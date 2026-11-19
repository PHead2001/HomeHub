
'use client';

import {
  createContext,
  lazy,
  Suspense,
  useState,
  useEffect,
  type ReactNode,
  useCallback,
  useMemo,
  useReducer,
  useRef,
} from 'react';
import {
  onAuthStateChanged,
  onIdTokenChanged,
  signOut,
  updatePassword,
  signInWithPopup,
  getAdditionalUserInfo,
  type User as FirebaseAuthUser,
  GoogleAuthProvider,
} from 'firebase/auth';
import { useToast } from '@/hooks/use-toast';
import { auth, firebaseEmulatorMode } from '@/lib/firebase-app';
import { getMemberPermissions } from '@/lib/permissions';
import { normalizeMember, sameProfile } from '@/lib/auth/cached-session';
import { SESSION_HINT_KEY } from '@/lib/dashboard/session-hint';
import { deviceStorage } from '@/lib/dashboard/house-snapshot';
import { forgetHouseholdOnDevice } from '@/lib/auth/household-scope';
import {
  canWatchHousehold,
  classifyListenerError,
  initialMembershipState,
  liveProfile,
  membershipChangeNotice,
  membershipReducer,
  membershipView,
  stalePointerFor,
  MEMBERSHIP_LOAD_TIMEOUT_MS,
  type AccessEnd,
  type NoticeSnapshot,
} from '@/lib/auth/live-membership';
import { keepListening } from '@/lib/shopping/live-state';
import { pushSignOutGate, runPushSignOut } from '@/lib/push-tokens';
import { hasPushSubscription } from '@/lib/service-worker';
import { normalizeInviteCode } from '@/lib/invite-codes';
import { memberProfileDiffers } from '@/lib/member-directory';
import { friendlyError } from '@/lib/friendly-error';
import { createHouseholdAction, deleteHouseholdAction, joinHouseholdWithInvite, leaveHouseholdAction, syncMyMemberProfileAction } from '@/app/household/actions';
import { hasTabletMarker } from '@/lib/devices/former-tablet';
import { codeFromSetupFragment } from '@/lib/devices/device-codes';
import { DEVICE_GOOGLE_SIGN_IN_REFUSAL, PERSONAL_PRINCIPAL, devicePrincipalOf, looksLikeDevice, retryDeviceClaims, type Principal } from '@/lib/devices/principal';
import type {
  Household,
  HouseholdMember,
  HouseholdPermission,
  User,
} from '@/lib/types';

type PermissionMap = Record<HouseholdPermission, boolean>;

/** A person or a registered wall tablet (src/lib/devices/principal.ts). */
export type { Principal };
const PERSONAL = PERSONAL_PRINCIPAL;

// The wall-tablet shell (docs/modules/devices/README.md, "Tablet shell"). Loaded only for
// a device session: it reads Firestore, which signed-out and personal first paint never load here.
const TabletShell = lazy(() => import('@/components/devices/tablet-shell'));

/**
 * Firestore and the rest of the data stack (`@/lib/firebase`, which starts App
 * Check before Firestore and Storage) load only when a signed-in user needs them,
 * so signed-out pages download just the app and Auth. Every caller below awaits
 * this before its first read or write; after the first call it resolves at once.
 */
const loadData = () => Promise.all([import('@/lib/firebase'), import('firebase/firestore')])
  .then(([firebase, firestore]) => ({ ...firestore, db: firebase.db, clearLocalFirestoreCache: firebase.clearLocalFirestoreCache }));

/**
 * Repeat-visit fast path (H01): reads a document from Firestore's local cache only, with no
 * network and no App Check round trip. The cache holds only what this signed-in user has read
 * on this device and is cleared on sign-out. `null` when it isn't cached (first visit, the
 * emulator's memory cache). Callers still confirm with the server afterwards.
 */
const readCached = async (path: string[]) => {
  const { db, doc, getDocFromCache } = await loadData();
  try {
    const [first, ...rest] = path;
    const snap = await getDocFromCache(doc(db, first, ...rest));
    return snap.exists() ? snap : null;
  } catch {
    return null;
  }
};

interface AuthContextType {
  /** A person or a registered wall tablet (see `Principal`). */
  principal: Principal;
  currentUser: User | null;
  household: Household | null;
  currentMember: HouseholdMember | null;
  permissions: PermissionMap;
  loading: boolean;
  householdLoading: boolean;
  /**
   * False while `currentUser` is the provisional copy from this device's cache (repeat-visit
   * fast path), true once the server profile has confirmed it. Anything that acts on the
   * profile (writes, one-time syncs) waits for true.
   */
  profileConfirmed: boolean;
  /** True when membership could not be loaded for an operational reason (offline, timeout). */
  householdLoadFailed: boolean;
  retryHouseholdLoad: () => void;
  /**
   * Set when access to a household ended while this session knew the membership
   * (removed, a join request declined, or the household deleted). Its data is already
   * gone from this device; `HouseholdManager` explains it until dismissed.
   */
  membershipEnded: AccessEnd | null;
  dismissMembershipEnded: () => void;
  signInWithGoogle: () => Promise<void>;
  logout: () => void;
  /** `silent` skips the global loading state and the success toast (used for background preference sync). */
  updateUser: (data: Partial<Omit<User, 'uid' | 'email'>>, newPassword?: string, options?: { silent?: boolean }) => Promise<void>;
  createHousehold: (name: string) => Promise<void>;
  joinHousehold: (code: string) => Promise<boolean>;
  leaveHousehold: () => Promise<boolean>;
  deleteHousehold: (confirmName: string) => Promise<boolean>;
}

export const AuthContext = createContext<AuthContextType | null>(null);

/**
 * The Google ID-token claims Firebase Auth already returns at sign-in
 * (`getAdditionalUserInfo(result).profile`). Only the default `openid email
 * profile` scopes are requested, so there is no extra Google API call and no
 * birthday or gender.
 */
type GoogleProfileData = {
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
};

const textClaim = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

const googleProfileFrom = (profile: Record<string, unknown> | null | undefined): GoogleProfileData => ({
  name: textClaim(profile?.name),
  given_name: textClaim(profile?.given_name),
  family_name: textClaim(profile?.family_name),
  picture: textClaim(profile?.picture),
});

const hasErrorCode = (error: unknown): error is Error & { code: string } => {
  if (!(error instanceof Error) || !('code' in error)) {
    return false;
  }
  return typeof (error as Error & { code?: unknown }).code === 'string';
};

const browserTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
};


/** Copies your profile's name and photo onto your membership record (server action, best effort). */
async function syncMemberProfile(householdId: string): Promise<void> {
  try {
    const user = auth.currentUser;
    if (!user) return;
    const result = await syncMyMemberProfileAction({ idToken: await user.getIdToken(), householdId });
    if (!result.ok) console.warn('Your name and photo could not be shared with the household yet.', result.code);
  } catch (error) {
    console.warn('Your name and photo could not be shared with the household yet.', error instanceof Error ? error.message : String(error));
  }
}

// --- Provider Component ---
export function AuthProvider({ children }: { children: ReactNode }) {
  // The signed-in person's profile (`users/{email}`) as last read. The household pointer,
  // role and overrides the app uses come from the live membership instead (`liveProfile`).
  const [profile, setProfile] = useState<User | null>(null);
  // The latest profile, readable synchronously inside the Auth listener.
  const profileRef = useRef<User | null>(null);
  useEffect(() => { profileRef.current = profile; }, [profile]);

  const [membership, dispatchMembership] = useReducer(membershipReducer, initialMembershipState);
  const [principal, setPrincipal] = useState<Principal>(PERSONAL);
  const principalRef = useRef<Principal>(PERSONAL);
  const [loading, setLoading] = useState(true);
  const [profileConfirmed, setProfileConfirmed] = useState(false);
  // Bumped by "Try again" so every listener of the household is reopened.
  const [listenAttempt, setListenAttempt] = useState(0);
  // The first Auth callback of a page load is the session restore: the only one the cache
  // fast path helps. Later callbacks (a sign-in on this page) keep the server-only path.
  const restoringSession = useRef(true);

  // Publishes a profile from the server; an unchanged profile changes nothing, so the
  // listeners that depend on it are not reopened.
  const publishProfile = useCallback((next: User) => {
    if (sameProfile(profileRef.current, next)) return;
    profileRef.current = next;
    setProfile(next);
  }, []);
  const retryHouseholdLoad = useCallback(() => {
    dispatchMembership({ type: 'retry' });
    setListenAttempt(attempt => attempt + 1);
  }, []);
  const dismissMembershipEnded = useCallback(() => dispatchMembership({ type: 'dismissEnded' }), []);

  // On a device where someone was signed in, start loading the data layer (Firestore and
  // App Check) alongside Auth's session restore instead of after it. Signed-out visitors
  // (no hint) never download it (H03 first-paint budget).
  useEffect(() => {
    try {
      if (window.localStorage.getItem(SESSION_HINT_KEY) === '1') void loadData();
    } catch {
      // Storage blocked: load on demand as usual.
    }
  }, []);
  const { toast } = useToast();

  const fetchOrCreateUserProfile = useCallback(async (firebaseUser: FirebaseAuthUser, googleProfileData?: GoogleProfileData): Promise<User | null> => {
    if (!firebaseUser.email) {
      toast({ variant: 'destructive', title: "Sign-in error", description: "No email address found for user."});
      return null;
    }
    const { db, doc, getDoc, setDoc } = await loadData();
    const userDocRef = doc(db, 'users', firebaseUser.email);
    const docSnap = await getDoc(userDocRef);
    // A brand-new user's profile can be created by two paths at once (the sign-in handler
    // and the Auth state listener). Whichever writes second is an update the rules deny; it
    // then reads the profile the other path created instead of failing.
    const createProfile = async (data: Record<string, unknown>): Promise<User> => {
      try {
        await setDoc(userDocRef, data);
        return { uid: firebaseUser.uid, ...data } as User;
      } catch (error) {
        if ((error as { code?: string })?.code !== 'permission-denied') throw error;
        const existing = await getDoc(userDocRef);
        if (!existing.exists()) throw error;
        return { uid: firebaseUser.uid, ...existing.data() } as User;
      }
    };

    if (docSnap.exists()) {
      const profile = { uid: firebaseUser.uid, ...docSnap.data() } as User;
      // Daily chore reminders fire at each person's chosen time in their own timezone.
      const timeZone = browserTimeZone();
      if (timeZone && profile.timeZone !== timeZone) {
        void setDoc(userDocRef, { timeZone }, { merge: true }).catch(() => undefined);
      }
      return profile;
    }

    if (!googleProfileData) {
      console.warn("Creating user profile with basic info from `onAuthStateChanged`. For full details, user should re-login.");
       const newUserProfile: Omit<User, 'uid' | 'householdId' | 'forcePasswordChange' | 'role'> = {
          email: firebaseUser.email,
          displayName: firebaseUser.displayName || firebaseUser.email.split('@')[0],
          firstName: firebaseUser.displayName?.split(' ')[0] || '',
          lastName: firebaseUser.displayName?.split(' ').slice(1).join(' ') || '',
          avatarUrl: firebaseUser.photoURL,
      };
      const dataToSave = {
        ...newUserProfile,
        role: 'member',
        forcePasswordChange: false,
        householdId: null,
      }
      return createProfile(dataToSave);
    }

    const newUserProfile: Partial<Omit<User, 'uid'>> = {
      email: firebaseUser.email,
      displayName: googleProfileData.name || firebaseUser.displayName || firebaseUser.email.split('@')[0],
      firstName: googleProfileData.given_name,
      lastName: googleProfileData.family_name,
      avatarUrl: googleProfileData.picture || firebaseUser.photoURL,
      role: 'member',
      forcePasswordChange: false,
      householdId: null,
    };

    const dataToSave = Object.fromEntries(
      Object.entries(newUserProfile).filter(([, value]) => value !== undefined && value !== null)
    ) as Partial<Omit<User, 'uid'>>;

    const created = await createProfile(dataToSave);
    toast({ title: "Welcome!", description: "Your new account has been created." });
    return created;

  }, [toast]);

  // --- Live membership (SL-3) ---------------------------------------------------------
  // One listener per document for the whole app: the profile, the person's own membership
  // record and (approved members only) the household document. Screens read them from
  // this context and never open their own.
  const uid = profile?.uid ?? null;
  const email = profile?.email ?? null;
  const profileHouseholdId = profile?.householdId ?? null;
  const watchedHouseholdId = membership.householdId;

  // The signed-in account and its profile pointer choose the household to watch. Keyed by
  // both: another account in the same household starts from nothing (its own record).
  useEffect(() => {
    dispatchMembership({ type: 'watch', uid, householdId: profileHouseholdId });
  }, [profileHouseholdId, uid]);

  // The profile itself, once the server has confirmed it: a pointer moved by the server
  // (removal, a join or a new household on another device) reaches this session.
  useEffect(() => {
    if (!profileConfirmed || !email || !uid) return;
    let stopped = false;
    let stop: (() => void) | null = null;
    void loadData().then(({ db, doc, onSnapshot }) => {
      if (stopped) return;
      stop = keepListening(({ healthy, failed }) => onSnapshot(
        doc(db, 'users', email),
        (snapshot) => {
          healthy(snapshot.metadata.fromCache);
          // A missing profile says nothing about membership; the next sign-in recreates it.
          if (snapshot.exists()) publishProfile({ uid, ...snapshot.data() } as User);
        },
        (error) => {
          console.warn('Profile listener stopped.', error instanceof Error ? error.message : String(error));
          if (classifyListenerError(error) === 'transient') failed();
        },
      ));
    });
    return () => { stopped = true; stop?.(); };
  }, [email, profileConfirmed, publishProfile, uid]);

  // The person's own membership record: the only authority for access and permissions.
  useEffect(() => {
    if (!watchedHouseholdId || !uid) return;
    const householdId = watchedHouseholdId;
    let stopped = false;
    let stop: (() => void) | null = null;
    void loadData().then(({ db, doc, onSnapshot }) => {
      if (stopped) return;
      stop = keepListening(({ healthy, failed }) => onSnapshot(
        doc(db, 'households', householdId, 'members', uid),
        // Metadata changes too, so a server answer that matches the cache still confirms it.
        { includeMetadataChanges: true },
        (snapshot) => {
          healthy(snapshot.metadata.fromCache);
          dispatchMembership({
            type: 'member',
            householdId,
            uid,
            exists: snapshot.exists(),
            data: snapshot.data(),
            fromCache: snapshot.metadata.fromCache,
            offline: typeof navigator !== 'undefined' && navigator.onLine === false,
          });
        },
        (error) => {
          const failure = classifyListenerError(error);
          console.warn('Membership listener stopped.', error instanceof Error ? error.message : String(error));
          dispatchMembership({ type: 'memberError', householdId, failure });
          // A denial ends access; a network or other error keeps the last known state and retries.
          if (failure === 'transient') failed();
        },
      ));
    });
    return () => { stopped = true; stop?.(); };
  }, [listenAttempt, uid, watchedHouseholdId]);

  // The household document, only while the record is approved (the rules let nobody else read it).
  const householdReadable = canWatchHousehold(membership);
  useEffect(() => {
    if (!householdReadable || !watchedHouseholdId) return;
    const householdId = watchedHouseholdId;
    let stopped = false;
    let stop: (() => void) | null = null;
    void loadData().then(({ db, doc, onSnapshot }) => {
      if (stopped) return;
      stop = keepListening(({ healthy, failed }) => onSnapshot(
        doc(db, 'households', householdId),
        (snapshot) => {
          healthy(snapshot.metadata.fromCache);
          dispatchMembership({ type: 'household', householdId, exists: snapshot.exists(), data: snapshot.data(), fromCache: snapshot.metadata.fromCache });
        },
        (error) => {
          console.warn('Household listener stopped.', error instanceof Error ? error.message : String(error));
          dispatchMembership({ type: 'householdError', householdId, failure: classifyListenerError(error) });
          // The membership record decides access; until it says otherwise, keep trying.
          failed();
        },
      ));
    });
    return () => { stopped = true; stop?.(); };
  }, [householdReadable, listenAttempt, watchedHouseholdId]);

  const view = useMemo(
    () => membershipView(membership, uid, profileHouseholdId, profileConfirmed),
    [membership, profileConfirmed, profileHouseholdId, uid],
  );
  // Same identity while the data is the same: screens that reload on a new `currentUser`
  // (the Chores page) must not reload for a membership snapshot that changes nothing they use.
  const computedUser = useMemo(() => liveProfile(profile, view, watchedHouseholdId), [profile, view, watchedHouseholdId]);
  const [currentUser, setStableUser] = useState<User | null>(computedUser);
  if (!sameProfile(currentUser, computedUser)) setStableUser(computedUser);
  const household = view.household;
  const currentMember = view.member;
  const householdLoading = profile ? view.phase === 'loading' : loading;
  const householdLoadFailed = view.phase === 'failed';

  // Nothing usable in time (a slow or absent connection with nothing cached): offer a retry.
  // The listeners keep running, so a late answer still opens the app.
  const waitingForMembership = Boolean(profile && watchedHouseholdId && view.phase === 'loading');
  useEffect(() => {
    if (!waitingForMembership || !watchedHouseholdId) return;
    const householdId = watchedHouseholdId;
    const timer = window.setTimeout(() => dispatchMembership({ type: 'loadTimeout', householdId }), MEMBERSHIP_LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [listenAttempt, waitingForMembership, watchedHouseholdId]);

  // Access ended, or the profile points at a household without a record: clear the
  // pointer (once the server confirmed the profile), so no later load tries it again.
  // Only the signed-in account's own membership counts (`stalePointerFor`), and the write
  // is dropped if the account changed before it runs.
  const stalePointer = stalePointerFor(membership, profile, profileConfirmed);
  const clearedPointer = useRef<string | null>(null);
  useEffect(() => {
    if (!stalePointer || !email || !uid || clearedPointer.current === `${uid}|${stalePointer}`) return;
    let cancelled = false;
    const sameAccount = () => !cancelled && auth.currentUser?.uid === uid && profileRef.current?.uid === uid &&
      profileRef.current.householdId === stalePointer;
    void (async () => {
      try {
        const { db, doc, setDoc } = await loadData();
        if (!sameAccount()) return;
        clearedPointer.current = `${uid}|${stalePointer}`;
        await setDoc(doc(db, 'users', email), { householdId: null, role: 'member', permissions: {} }, { merge: true });
        setProfile(prev => prev && prev.uid === uid && prev.householdId === stalePointer ? { ...prev, householdId: null, role: 'member', permissions: {} } : prev);
      } catch (error) {
        console.warn('Could not clear a stale household reference from the profile.', error instanceof Error ? error.message : String(error));
      }
    })();
    return () => { cancelled = true; };
  }, [email, stalePointer, uid]);

  // Nothing of a household this device no longer shows stays on it: the dashboard's
  // last-known house, Undo journal entries and in-memory memories (screens remount).
  // Keyed by account too: another person in the same household starts with nothing of the
  // previous person's (their Undo offers, the house snapshot, in-memory memories).
  const shownHousehold = membership.ended ? null : watchedHouseholdId;
  const lastShown = useRef<{ uid: string | null; householdId: string | null }>({ uid: null, householdId: null });
  useEffect(() => {
    const previous = lastShown.current;
    lastShown.current = { uid: membership.uid, householdId: shownHousehold };
    if (previous.householdId && (previous.householdId !== shownHousehold || previous.uid !== membership.uid)) {
      forgetHouseholdOnDevice(previous.householdId);
    }
  }, [membership.uid, shownHousehold]);

  // An approval or a new role made by someone else while this page is open.
  const lastSettled = useRef<NoticeSnapshot | null>(null);
  useEffect(() => {
    if (view.phase === 'loading') return;
    const next: NoticeSnapshot = { uid: membership.uid, householdId: watchedHouseholdId, phase: view.phase, role: view.member?.role ?? null };
    const notice = membershipChangeNotice(lastSettled.current, next);
    lastSettled.current = next;
    if (notice) toast(notice);
  }, [membership.uid, toast, view.member?.role, view.phase, watchedHouseholdId]);

  // Heal drift between the profile and the public member data (name, photo), once per change.
  const memberShown = view.phase === 'member' || view.phase === 'pending';
  const profileDrift = profileConfirmed && memberShown && watchedHouseholdId && currentMember && profile &&
    membership.uid === profile.uid && currentMember.uid === profile.uid &&
    memberProfileDiffers(currentMember, { displayName: profile.displayName, avatarUrl: profile.avatarUrl })
    ? `${profile.uid}|${watchedHouseholdId}|${profile.displayName ?? ''}|${profile.avatarUrl ?? ''}`
    : null;
  const driftSynced = useRef<string | null>(null);
  useEffect(() => {
    if (!profileDrift || !watchedHouseholdId || !uid || driftSynced.current === profileDrift) return;
    // The sync runs as whoever is signed in: never for a membership of another account.
    if (auth.currentUser?.uid !== uid) return;
    driftSynced.current = profileDrift;
    void syncMemberProfile(watchedHouseholdId);
  }, [profileDrift, uid, watchedHouseholdId]);

  // A frozen household (a deletion that failed partway) cannot be read any more, and
  // "Finish deleting" needs its exact name: take it from this device's cached copy when
  // there is one (otherwise the owner types it on the deletion screen).
  const deletingWithoutName = view.phase === 'deleting' && membership.uid === uid && !membership.lastName && watchedHouseholdId ? watchedHouseholdId : null;
  useEffect(() => {
    if (!deletingWithoutName) return;
    let cancelled = false;
    void readCached(['households', deletingWithoutName]).then((snapshot) => {
      const name = snapshot?.get('name');
      if (!cancelled && typeof name === 'string' && name.trim()) {
        dispatchMembership({ type: 'householdName', householdId: deletingWithoutName, name });
      }
    });
    return () => { cancelled = true; };
  }, [deletingWithoutName]);

  /**
   * Enters a device session (no profile fetch or creation, no membership, push or member
   * sync; true) or leaves one for the personal flow (false).
   */
  const switchPrincipal = useCallback((device: Principal | null): boolean => {
    if (device) {
      dispatchMembership({ type: 'reset' });
      if (profileRef.current) forgetHouseholdOnDevice(null);
      profileRef.current = null;
      setProfile(null);
      setProfileConfirmed(false);
      principalRef.current = device;
      setPrincipal(device);
      setLoading(false);
      return true;
    }
    if (principalRef.current.kind !== 'personal') {
      principalRef.current = PERSONAL;
      setPrincipal(PERSONAL);
    }
    return false;
  }, []);

  // A tablet whose claims could not be read (offline restore with an expired token): read
  // them again on reconnect, on every ID-token change and every 30 s until they resolve.
  const unresolvedDevice = principal.kind === 'device-unresolved' ? principal.deviceId : null;
  useEffect(() => {
    if (!unresolvedDevice) return;
    return retryDeviceClaims({
      resolve: async () => (auth.currentUser ? devicePrincipalOf(auth.currentUser) : null),
      onResolved: (device) => { if (auth.currentUser?.uid === `device_${device.deviceId}`) switchPrincipal(device); },
      triggers: [
        (retry) => {
          window.addEventListener('online', retry);
          return () => window.removeEventListener('online', retry);
        },
        (retry) => onIdTokenChanged(auth, () => retry()),
        (retry) => {
          const timer = window.setInterval(retry, 30_000);
          return () => window.clearInterval(timer);
        },
      ],
    });
  }, [switchPrincipal, unresolvedDevice]);

  // This is for session management ONLY (on page refresh)
  useEffect(() => {
    const unsubscribeAuth = onAuthStateChanged(auth, async (firebaseUser) => {
      const restoring = restoringSession.current;
      restoringSession.current = false;
      setLoading(true);
      // A wall tablet never runs the personal flow.
      if (switchPrincipal(firebaseUser ? await devicePrincipalOf(firebaseUser) : null)) return;
      if (firebaseUser) {
        // Another account on this page (for example a sign-in synchronised from another
        // tab): nothing of the previous one stays. The membership restarts from the new
        // account's own record when its profile arrives (the watch is keyed by account).
        if (profileRef.current && profileRef.current.uid !== firebaseUser.uid) {
          forgetHouseholdOnDevice(null);
          // The previous account's profile is no longer confirmed for whoever is signed in:
          // nothing may act on it (or pair it with the new account) until the new one arrives.
          setProfileConfirmed(false);
        }
        // Repeat visit: render from this user's cached profile at once; the server copy
        // below replaces it only if something changed.
        const cached = restoring && firebaseUser.email ? await readCached(['users', firebaseUser.email]) : null;
        if (cached) {
          setProfileConfirmed(false);
          const provisional = { uid: firebaseUser.uid, ...cached.data() } as User;
          profileRef.current = provisional;
          setProfile(provisional);
          setLoading(false);
        }
        // On refresh, we only fetch the existing profile. Creation happens at sign-in.
        const userProfile = await fetchOrCreateUserProfile(firebaseUser);
        if (userProfile) {
          publishProfile(userProfile);
          setProfileConfirmed(true);
        } else {
          dispatchMembership({ type: 'reset' });
          profileRef.current = null;
          setProfile(null);
          setProfileConfirmed(false);
        }
      } else {
        // User is not logged in: nothing of the last user's house stays on this device.
        dispatchMembership({ type: 'reset' });
        forgetHouseholdOnDevice(null);
        // A wall tablet whose session ended while its shell was not running (removed while
        // switched off): finish its clearing, then reload the setup screen.
        // A setup link's code is read now, before anything can strip it, and kept through the reload.
        // Only while nobody is signed in; recovery checks again before every step.
        if (hasTabletMarker() && auth.currentUser === null) {
          const setupCode = codeFromSetupFragment(window.location.hash);
          void import('@/lib/devices/former-tablet').then((mod) => mod.recoverFormerTabletHere(setupCode));
        }
        profileRef.current = null;
        setProfile(null);
        setProfileConfirmed(false);
      }
      setLoading(false);
    });

    return () => unsubscribeAuth();
  }, [fetchOrCreateUserProfile, publishProfile, switchPrincipal]);


  const signInWithGoogle = useCallback(async (): Promise<void> => {
    // A wall tablet switches to a personal account only through its protected exit
    // (an owner or admin PIN), never by signing in over the device session.
    if (principalRef.current.kind !== 'personal' || looksLikeDevice(auth.currentUser)) {
      toast({ variant: 'destructive', title: 'Sign-in not available here', description: DEVICE_GOOGLE_SIGN_IN_REFUSAL });
      return;
    }
    setLoading(true);
    // Default scopes only (openid, email, profile). Name and photo come from
    // the ID token Firebase Auth already returns; nothing else is requested.
    const googleProvider = new GoogleAuthProvider();

    try {
      const result = await signInWithPopup(auth, googleProvider);
      const { user: firebaseUser } = result;
      const googleProfileData = googleProfileFrom(getAdditionalUserInfo(result)?.profile);

      // The user profile is created or fetched immediately after sign-in.
      const userProfile = await fetchOrCreateUserProfile(firebaseUser, googleProfileData);

      if (userProfile) {
        publishProfile(userProfile);
        setProfileConfirmed(true);
        toast({ title: 'Login Successful', description: 'Welcome!' });
      }

    } catch (error) {
        console.error("Google Sign-In Error:", error instanceof Error ? error : String(error));
        let message = 'An unknown error occurred during login.';
        if (hasErrorCode(error) && error.code === 'auth/popup-closed-by-user') {
            message = 'Login canceled.'
        }
        toast({ variant: 'destructive', title: 'Login Failed', description: message });
    } finally {
        setLoading(false);
    }
  }, [fetchOrCreateUserProfile, publishProfile, toast]);

  const logoutInFlight = useRef(false);
  const logout = useCallback(async () => {
    // A second tap while the first sign-out is still flushing does nothing.
    if (logoutInFlight.current) return;
    logoutInFlight.current = true;
    // From here on no push registration may complete for this account: one still
    // in flight is discarded and cleaned up (see push-tokens).
    pushSignOutGate.begin();
    let reloading = false;
    try {
      // The last-known house rooms and the Undo journal go first, before anything that can fail or reload.
      forgetHouseholdOnDevice(null);
      // This device stops receiving the account's pushes: while still signed in, its
      // token leaves the account's private push document and FCM. Loading the module
      // and the cleanup share one 2 s budget and never block sign-out; what is left
      // is finished at the next sign-in. Nothing is loaded when this device has no
      // token, no registration in flight and no push subscription.
      await runPushSignOut({
        storage: deviceStorage(),
        hasSubscription: hasPushSubscription,
        cleanup: async () => (await import('@/lib/push-registration')).unregisterPushOnThisDevice(),
        onError: (error) => console.warn('Push could not be fully removed from this device on sign-out.', error instanceof Error ? error.message : String(error)),
      });
      // Flush queued writes (e.g. offline shopping ticks) while still signed in, since
      // the rules reject them once signed out. Then remove this household's cached data
      // from the device. A terminated Firestore instance cannot be reused, so the page
      // reloads afterwards. (Emulator runs hold only synthetic data and keep the live
      // instance.)
      const firestoreStopped = !firebaseEmulatorMode && await (await loadData()).clearLocalFirestoreCache();
      reloading = firestoreStopped;
      try {
        await signOut(auth);
      } finally {
        if (firestoreStopped) window.location.assign("/");
      }
      if (firestoreStopped) return;
      dispatchMembership({ type: 'reset' });
      profileRef.current = null;
      setProfile(null);
      setProfileConfirmed(false);
      toast({ title: "Logged Out", description: "You have been successfully logged out." });
    } finally {
      // The page is about to reload after a full sign-out; otherwise sign-out is possible again.
      if (!reloading) {
        logoutInFlight.current = false;
        pushSignOutGate.end();
      }
    }
  },[toast]);

  const updateUser = useCallback(async (data: Partial<Omit<User, 'uid' | 'email'>>, newPassword?: string, options?: { silent?: boolean }) => {
    const silent = options?.silent === true;
    if (!auth.currentUser || !currentUser?.email) {
      if (!silent) toast({ variant: 'destructive', title: 'Not Authenticated', description: 'You must be logged in to update your profile.' });
      return;
    }
    if (!silent) setLoading(true);
    try {
      if (newPassword && auth.currentUser.providerData.some(p => p.providerId === 'password')) {
        toast({title: 'Updating Password...'})
        await updatePassword(auth.currentUser, newPassword);
        toast({title: 'Password Updated Successfully!'})
        data.forcePasswordChange = false;
      }

      const { db, doc, setDoc } = await loadData();
      const userDocRef = doc(db, 'users', currentUser.email);
      await setDoc(userDocRef, data, { merge: true });
      setProfile(prev => prev ? { ...prev, ...data } : null);
      // Housemates see the name and photo through the membership record, which only
      // the server may write for you (best effort: the next load heals a failure).
      if (currentUser.householdId && ('displayName' in data || 'avatarUrl' in data)) void syncMemberProfile(currentUser.householdId);
      if (!silent) toast({ title: 'Profile Updated', description: 'Your information has been successfully updated.' });

    } catch (error) {
      console.error("Update User Error:", error instanceof Error ? error : String(error));
      let description = "An unknown error occurred.";
      if (hasErrorCode(error) && error.code === 'auth/requires-recent-login') {
          description = "This action requires you to have recently logged in. Please log out and log back in to continue.";
      } else {
          description = friendlyError(error);
      }
      toast({ variant: 'destructive', title: 'Update Failed', description });
    } finally {
        if (!silent) setLoading(false);
    }
  }, [currentUser, toast]);

  const createHousehold = useCallback(async (name: string) => {
    const firebaseUser = auth.currentUser;
    if (!currentUser?.email || !currentUser.uid || !firebaseUser) {
        toast({ variant: 'destructive', title: 'Not Authenticated' });
        return;
    }

    const trimmedName = name.trim();
    if (!trimmedName) {
        toast({ variant: 'destructive', title: 'Missing Household Name', description: 'Please enter a household name.' });
        return;
    }

    try {
      // The server writes the household, the owner membership, the profile pointer
      // and the activity entry in one transaction.
      const idToken = await firebaseUser.getIdToken();
      const result = await createHouseholdAction({ idToken, name: trimmedName, timeZone: browserTimeZone() });
      if (!result.ok) {
        toast({ variant: 'destructive', title: 'Creation Failed', description: result.message });
        return;
      }

      const { household: createdHousehold, member: createdMember } = result.data;
      // Shown at once; the listeners take over from here.
      dispatchMembership({ type: 'adopt', householdId: createdHousehold.id, member: normalizeMember(createdMember, currentUser.uid), household: createdHousehold });
      setProfile(prev => prev ? { ...prev, householdId: createdHousehold.id, role: 'owner', permissions: {} } : null);

      toast({ title: 'Household Created!', description: `Welcome to ${createdHousehold.name}!` });
    } catch (error) {
        console.error('Failed to create household', error);
        toast({
          variant: 'destructive',
          title: 'Creation Failed',
          description: friendlyError(error),
        });
    }
  }, [currentUser, toast]);

  const joinHousehold = useCallback(async (code: string) => {
    const firebaseUser = auth.currentUser;
    if (!currentUser?.email || !currentUser.uid || !firebaseUser) {
      toast({ variant: 'destructive', title: 'Please sign in again', description: 'Your session ended before the code could be used.' });
      return false;
    }
    if (!normalizeInviteCode(code)) {
      toast({ variant: 'destructive', title: 'Check the code', description: 'Invite codes have 10 letters and numbers, like ABCD-EFGH-JK.' });
      return false;
    }

    try {
      const idToken = await firebaseUser.getIdToken();
      const result = await joinHouseholdWithInvite({ idToken, code });
      if (!result.ok) {
        toast({ variant: 'destructive', title: 'Could not join', description: result.message });
        return false;
      }

      // The result holds only the household's id and name and the caller's own status.
      const joinedId = result.data.household.id;
      const member = normalizeMember({
        ...result.data.member,
        email: currentUser.email,
        ...(currentUser.displayName ? { displayName: currentUser.displayName } : {}),
        avatarUrl: currentUser.avatarUrl ?? null,
      } as HouseholdMember, currentUser.uid);
      dispatchMembership({ type: 'adopt', householdId: joinedId, member, household: { id: joinedId, name: result.data.household.name } });
      setProfile(prev => prev ? { ...prev, householdId: joinedId, role: 'newuser', permissions: {} } : null);
      toast({ title: 'Request sent', description: `An owner or admin of ${result.data.household.name} will approve you shortly.` });
      return true;
    } catch (error) {
      console.error('Failed to join household', error);
      toast({ variant: 'destructive', title: 'Could not join', description: 'We could not reach HomeHub. Check your connection and try again.' });
      return false;
    }
  }, [currentUser, toast]);

  // This person left or deleted the household here: no notice; its data leaves the device.
  const resetHouseholdState = useCallback(() => {
    dispatchMembership({ type: 'reset' });
    setProfile(prev => prev ? { ...prev, householdId: null, role: 'member', permissions: {} } : null);
  }, []);

  const leaveHousehold = useCallback(async () => {
    const firebaseUser = auth.currentUser;
    if (!firebaseUser || !currentUser?.householdId || !household) {
      toast({ variant: 'destructive', title: 'No household', description: 'There is no household to leave.' });
      return false;
    }
    // The record disappears before the action answers: that end needs no "removed" notice.
    dispatchMembership({ type: 'endingHere', householdId: currentUser.householdId });
    try {
      const result = await leaveHouseholdAction({ idToken: await firebaseUser.getIdToken(), householdId: currentUser.householdId });
      if (!result.ok) {
        dispatchMembership({ type: 'endingHereCancelled' });
        toast({ variant: 'destructive', title: 'Could not leave', description: result.message });
        return false;
      }
      resetHouseholdState();
      toast({ title: 'You left the household', description: `You are no longer part of ${household.name}.` });
      return true;
    } catch {
      dispatchMembership({ type: 'endingHereCancelled' });
      toast({ variant: 'destructive', title: 'Could not leave', description: 'We could not reach HomeHub. Try again.' });
      return false;
    }
  }, [currentUser?.householdId, household, resetHouseholdState, toast]);

  const deleteHousehold = useCallback(async (confirmName: string) => {
    const firebaseUser = auth.currentUser;
    if (!firebaseUser || !currentUser?.householdId || !household) return false;
    // The record is frozen, then deleted, before the action answers: no notice for that.
    dispatchMembership({ type: 'endingHere', householdId: currentUser.householdId });
    try {
      const result = await deleteHouseholdAction({
        idToken: await firebaseUser.getIdToken(),
        householdId: currentUser.householdId,
        confirmName,
      });
      if (!result.ok) {
        dispatchMembership({ type: 'endingHereCancelled' });
        toast({ variant: 'destructive', title: 'Could not delete', description: result.message });
        return false;
      }
      resetHouseholdState();
      toast({ title: 'Household deleted', description: `${household.name} and everything in it were deleted.` });
      return true;
    } catch {
      dispatchMembership({ type: 'endingHereCancelled' });
      toast({ variant: 'destructive', title: 'Could not delete', description: 'We could not reach HomeHub. Try again.' });
      return false;
    }
  }, [currentUser?.householdId, household, resetHouseholdState, toast]);

  // Stable identity while the values are the same: consumers list permissions in effect
  // and callback dependencies, and a membership snapshot that changes nothing else
  // (or another field of the record) must not re-run them.
  const computedPermissions = useMemo(() => getMemberPermissions(currentMember), [currentMember]);
  const permissionsKey = JSON.stringify(computedPermissions);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const permissions = useMemo(() => computedPermissions, [permissionsKey]);

  const value = {
    principal,
    currentUser,
    household,
    currentMember,
    permissions,
    loading,
    householdLoading,
    profileConfirmed,
    householdLoadFailed,
    retryHouseholdLoad,
    membershipEnded: view.ended,
    dismissMembershipEnded,
    signInWithGoogle,
    logout,
    updateUser,
    createHousehold,
    joinHousehold,
    leaveHousehold,
    deleteHousehold,
  };

  return (
    <AuthContext.Provider value={value}>
      {principal.kind !== 'personal'
        ? <Suspense fallback={null}><TabletShell principal={principal} /></Suspense>
        : children}
    </AuthContext.Provider>
  );
}
