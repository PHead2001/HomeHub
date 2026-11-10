
'use client';

import {
  createContext,
  useState,
  useEffect,
  type ReactNode,
  useCallback,
  useMemo,
  useRef,
} from 'react';
import {
  onAuthStateChanged,
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
import { clearHouseSnapshot, deviceStorage } from '@/lib/dashboard/house-snapshot';
import { normalizeInviteCode } from '@/lib/invite-codes';
import { memberProfileDiffers, pendingHouseholdView } from '@/lib/member-directory';
import { friendlyError } from '@/lib/friendly-error';
import { deleteHouseholdAction, joinHouseholdWithInvite, leaveHouseholdAction, syncMyMemberProfileAction } from '@/app/household/actions';
import type {
  Household,
  HouseholdMember,
  HouseholdPermission,
  User,
} from '@/lib/types';

type PermissionMap = Record<HouseholdPermission, boolean>;

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

const INVITE_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const generateShortCode = (length: number) => {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += INVITE_CODE_CHARS.charAt(Math.floor(Math.random() * INVITE_CODE_CHARS.length));
  }
  return result;
};

const slugifyHouseholdName = (name: string) => {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || 'household';
};

const generateHouseholdId = (name: string) => `${slugifyHouseholdName(name)}-${generateShortCode(4).toLowerCase()}`;

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
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  // The latest user, readable synchronously inside the Auth listener.
  const currentUserRef = useRef<User | null>(null);
  useEffect(() => { currentUserRef.current = currentUser; }, [currentUser]);

  const [household, setHousehold] = useState<Household | null>(null);
  const [currentMember, setCurrentMember] = useState<HouseholdMember | null>(null);
  const [loading, setLoading] = useState(true);
  const [householdLoading, setHouseholdLoading] = useState(true);
  const [profileConfirmed, setProfileConfirmed] = useState(false);
  // Household shown from the cache (by id), so the confirmed run doesn't flash back to loading.
  const cachedHouseholdShown = useRef<string | null>(null);
  // The first Auth callback of a page load is the session restore: the only one the cache
  // fast path helps. Later callbacks (a sign-in on this page) keep the server-only path.
  const restoringSession = useRef(true);

  // Publishes a profile from the server. The household effect owns `householdLoading`; it is
  // set here in advance only when the uid or householdId changes (so the onboarding screen
  // never flashes before that effect runs), which are exactly the changes that re-run the
  // effect and end loading. An unchanged profile changes nothing, so loading can't be left on.
  const publishProfile = useCallback((profile: User) => {
    const shown = currentUserRef.current;
    if (sameProfile(shown, profile)) return;
    if (shown?.uid !== profile.uid || (shown?.householdId ?? null) !== (profile.householdId ?? null)) setHouseholdLoading(true);
    currentUserRef.current = profile;
    setCurrentUser(profile);
  }, []);
  const [householdLoadFailed, setHouseholdLoadFailed] = useState(false);
  const [householdLoadAttempt, setHouseholdLoadAttempt] = useState(0);
  const retryHouseholdLoad = useCallback(() => setHouseholdLoadAttempt(attempt => attempt + 1), []);

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
  

  // This effect runs when the householdId on the currentUser changes, or when the cached
  // profile is confirmed by the server.
  useEffect(() => {
    // A newer run supersedes this one (the profile changed or was confirmed, or the provider
    // unmounted): from then on this run neither updates state nor writes to the profile.
    let active = true;
    const cleanupLegacyInviteCode = async (householdData: Household, role: HouseholdMember['role']) => {
      if (role !== 'owner' || !householdData.inviteCode) return;
      try {
        const { db, doc, updateDoc, deleteField } = await loadData();
        await updateDoc(doc(db, 'households', householdData.id), {
          inviteCode: deleteField(),
          updatedAt: new Date().toISOString(),
        });
      } catch (error) {
        console.warn("Legacy permanent invite code could not be removed automatically.", error);
      }
    };

    // households/{id}/members/{uid} is the only authority. A profile that points at
    // a household without a membership record is stale: clear it, grant nothing.
    const loadMembership = async (householdId: string) => {
      if (!currentUser?.email || !currentUser.uid) return null;

      const { db, doc, getDoc } = await loadData();
      const memberSnap = await getDoc(doc(db, 'households', householdId, 'members', currentUser.uid));
      if (!active) return undefined;
      if (!memberSnap.exists()) return null;

      const normalizedMember = normalizeMember(memberSnap.data() as HouseholdMember, currentUser.uid);

      // A pending person knows the household's name from their own record (written
      // when the invite was redeemed) and never reads the household document, which
      // lists every member's email. Older pending records without it still read it.
      let householdData: Household;
      const pendingView = pendingHouseholdView(householdId, normalizedMember);
      if (pendingView) {
        householdData = pendingView;
      } else {
        const householdSnap = await getDoc(doc(db, 'households', householdId));
        if (!active) return undefined;
        if (!householdSnap.exists()) return null;
        householdData = { id: householdSnap.id, ...householdSnap.data() } as Household;
      }
      setHousehold(householdData);
      setCurrentMember(normalizedMember);
      const currentOverrides = JSON.stringify(currentUser.permissions || {});
      const memberOverrides = JSON.stringify(normalizedMember.permissions || {});
      if (
        currentUser.householdId !== householdData.id ||
        currentUser.role !== normalizedMember.role ||
        currentOverrides !== memberOverrides
      ) {
        setCurrentUser(prev => prev ? {
          ...prev,
          householdId: householdData.id,
          role: normalizedMember.role,
          permissions: normalizedMember.permissions,
        } : prev);
      }
      await cleanupLegacyInviteCode(householdData, normalizedMember.role);
      // Heal drift between the profile and the public member data (name, photo).
      if (memberProfileDiffers(normalizedMember, { displayName: currentUser.displayName, avatarUrl: currentUser.avatarUrl })) void syncMemberProfile(householdId);
      return normalizedMember;
    };

    const clearStaleHousehold = async () => {
      if (!active) return;
      setHousehold(null);
      setCurrentMember(null);
      if (!currentUser?.email || !currentUser.householdId) return;
      try {
        const { db, doc, setDoc } = await loadData();
        if (!active) return;
        await setDoc(doc(db, 'users', currentUser.email), { householdId: null, role: 'member', permissions: {} }, { merge: true });
        if (!active) return;
        setCurrentUser(prev => prev ? { ...prev, householdId: null, role: 'member', permissions: {} } : prev);
      } catch (error) {
        console.warn('Could not clear a stale household reference from the profile.', error);
      }
    };

    // Repeat visit: show this member's cached household at once (display only, no network).
    const showCachedHousehold = async (householdId: string, uid: string) => {
      if (cachedHouseholdShown.current === householdId) return;
      const [cachedMember, cachedHousehold] = await Promise.all([
        readCached(['households', householdId, 'members', uid]),
        readCached(['households', householdId]),
      ]);
      if (!active || !cachedMember) return;
      const member = normalizeMember(cachedMember.data() as HouseholdMember, uid);
      const pendingView = pendingHouseholdView(householdId, member);
      if (!pendingView && !cachedHousehold) return;
      setHousehold(pendingView ?? ({ id: cachedHousehold!.id, ...cachedHousehold!.data() } as Household));
      setCurrentMember(member);
      cachedHouseholdShown.current = householdId;
      setHouseholdLoading(false);
    };

    const fetchHousehold = async () => {
      const householdId = currentUser?.householdId;
      // Provisional (cached) profile: at most show the cached household. The server reads,
      // the stale-household cleanup and the end of loading wait for the confirmed profile,
      // so an outdated cached profile can never clear or replace a valid household.
      if (!profileConfirmed) {
        if (householdId && currentUser?.uid) await showCachedHousehold(householdId, currentUser.uid);
        return;
      }
      setHouseholdLoadFailed(false);
      if (cachedHouseholdShown.current !== householdId) setHouseholdLoading(true);
      try {
        if (!householdId) {
          setHousehold(null);
          setCurrentMember(null);
          return;
        }
        if (currentUser?.uid) await showCachedHousehold(householdId, currentUser.uid);
        if (!active) return;
        try {
          const member = await loadMembership(householdId);
          if (member === null) await clearStaleHousehold();
        } catch (error) {
          if (!active) return;
          // Only a definitive denial means this account is not a member. Offline or
          // transient failures keep the profile's reference so loading can be retried.
          console.warn('Household membership could not be loaded.', error);
          if ((error as { code?: string })?.code === 'permission-denied') {
            await clearStaleHousehold();
          } else {
            setHousehold(null);
            setCurrentMember(null);
            cachedHouseholdShown.current = null;
            setHouseholdLoadFailed(true);
          }
        }
      } finally {
        if (active) setHouseholdLoading(false);
      }
    };

    fetchHousehold();
    return () => { active = false; };
  }, [
    currentUser?.avatarUrl,
    currentUser?.displayName,
    currentUser?.email,
    currentUser?.householdId,
    currentUser?.permissions,
    currentUser?.role,
    currentUser?.uid,
    householdLoadAttempt,
    profileConfirmed,
  ]);

  // This is for session management ONLY (on page refresh)
  useEffect(() => {
    const unsubscribeAuth = onAuthStateChanged(auth, async (firebaseUser) => {
      const restoring = restoringSession.current;
      restoringSession.current = false;
      setLoading(true);
      if (firebaseUser) {
        // Repeat visit: render from this user's cached profile at once; the server copy
        // below replaces it only if something changed.
        const cached = restoring && firebaseUser.email ? await readCached(['users', firebaseUser.email]) : null;
        if (cached) {
          setProfileConfirmed(false);
          setCurrentUser({ uid: firebaseUser.uid, ...cached.data() } as User);
          setLoading(false);
        }
        // On refresh, we only fetch the existing profile. Creation happens at sign-in.
        const userProfile = await fetchOrCreateUserProfile(firebaseUser);
        if (userProfile) {
            publishProfile(userProfile);
            setProfileConfirmed(true);
        } else {
        setCurrentUser(null);
        setProfileConfirmed(false);
        setHousehold(null);
        setCurrentMember(null);
        cachedHouseholdShown.current = null;
        setHouseholdLoading(false);
      }
      } else {
        // User is not logged in: nothing of the last user's house stays on this device.
        clearHouseSnapshot(deviceStorage());
        setCurrentUser(null);
        setProfileConfirmed(false);
        setHousehold(null);
        setCurrentMember(null);
        cachedHouseholdShown.current = null;
        setHouseholdLoading(false);
      }
      setLoading(false);
    });

    return () => unsubscribeAuth();
  }, [fetchOrCreateUserProfile, publishProfile]);


  const signInWithGoogle = useCallback(async (): Promise<void> => {
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

  const logout = useCallback(async () => {
    // The last-known house rooms go first, before anything that can fail or reload.
    clearHouseSnapshot(deviceStorage());
    // Flush queued writes (e.g. offline shopping ticks) while still signed in, since
    // the rules reject them once signed out. Then remove this household's cached data
    // from the device. A terminated Firestore instance cannot be reused, so the page
    // reloads afterwards. (Emulator runs hold only synthetic data and keep the live
    // instance.)
    const firestoreStopped = !firebaseEmulatorMode && await (await loadData()).clearLocalFirestoreCache();
    try {
      await signOut(auth);
    } finally {
      if (firestoreStopped) window.location.assign("/");
    }
    if (firestoreStopped) return;
    setCurrentUser(null);
    setProfileConfirmed(false);
    setHousehold(null);
    setCurrentMember(null);
    cachedHouseholdShown.current = null;
    setHouseholdLoading(false);
    toast({ title: "Logged Out", description: "You have been successfully logged out." });
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
      setCurrentUser(prev => prev ? { ...prev, ...data } : null);
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
    if (!currentUser?.email || !currentUser.uid) {
        toast({ variant: 'destructive', title: 'Not Authenticated' });
        return;
    }

    const trimmedName = name.trim();
    if (!trimmedName) {
        toast({ variant: 'destructive', title: 'Missing Household Name', description: 'Please enter a household name.' });
        return;
    }

    const { db, doc, collection, writeBatch } = await loadData();
    const userDocRef = doc(db, 'users', currentUser.email);
    
    let createdHousehold: Household | null = null;
    let createdMember: HouseholdMember | null = null;

    try {
      for (let attempt = 0; attempt < 8; attempt++) {
        const newHouseholdId = generateHouseholdId(trimmedName);
        const householdDocRef = doc(db, 'households', newHouseholdId);
        const memberDocRef = doc(db, 'households', newHouseholdId, 'members', currentUser.uid);
        const auditDocRef = doc(collection(db, 'households', newHouseholdId, 'auditLogs'));
        const now = new Date().toISOString();
        const newHouseholdData: Omit<Household, 'id'> = {
          name: trimmedName,
          ownerEmail: currentUser.email,
          ownerUid: currentUser.uid,
          memberEmails: [currentUser.email],
          createdAt: now,
          updatedAt: now,
          // Reminders and recurring chores run on the server in this timezone.
          timeZone: browserTimeZone(),
        };
        const ownerMember: HouseholdMember = {
          uid: currentUser.uid,
          email: currentUser.email,
          displayName: currentUser.displayName,
          avatarUrl: currentUser.avatarUrl,
          role: 'owner',
          status: 'active',
          joinedAt: now,
          approvedAt: now,
          approvedByUid: currentUser.uid,
        };
        const batch = writeBatch(db);
        batch.set(householdDocRef, newHouseholdData);
        batch.set(memberDocRef, ownerMember);
        batch.set(userDocRef, { householdId: newHouseholdId, role: 'owner', permissions: {} }, { merge: true });
        batch.set(auditDocRef, {
          actorUid: currentUser.uid,
          actorEmail: currentUser.email,
          actorName: currentUser.displayName,
          action: 'household.created',
          createdAt: now,
          details: { householdName: trimmedName },
        });

        try {
          await batch.commit();
          createdHousehold = { id: newHouseholdId, ...newHouseholdData };
          createdMember = ownerMember;
          break;
        } catch (error) {
          if (attempt === 7) throw error;
        }
      }

      const createdHouseholdResult = createdHousehold;
      const createdMemberResult = createdMember;
      if (!createdHouseholdResult || !createdMemberResult) {
        throw new Error('Could not reserve a unique household ID.');
      }

      setCurrentUser(prev => prev ? { ...prev, householdId: createdHouseholdResult.id, role: 'owner', permissions: {} } : null);
      setHousehold(createdHouseholdResult);
      setCurrentMember(createdMemberResult);

      toast({ title: 'Household Created!', description: `Welcome to ${trimmedName}!` });
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
      setCurrentUser(prev => prev ? { ...prev, householdId: result.data.household.id, role: 'newuser', permissions: {} } : null);
      setHousehold({ id: result.data.household.id, name: result.data.household.name });
      setCurrentMember({
        ...result.data.member,
        email: currentUser.email,
        ...(currentUser.displayName ? { displayName: currentUser.displayName } : {}),
        avatarUrl: currentUser.avatarUrl ?? null,
      });
      toast({ title: 'Request sent', description: `An owner or admin of ${result.data.household.name} will approve you shortly.` });
      return true;
    } catch (error) {
      console.error('Failed to join household', error);
      toast({ variant: 'destructive', title: 'Could not join', description: 'We could not reach HomeHub. Check your connection and try again.' });
      return false;
    }
  }, [currentUser, toast]);

  const resetHouseholdState = useCallback(() => {
    setHousehold(null);
    setCurrentMember(null);
    setCurrentUser(prev => prev ? { ...prev, householdId: null, role: 'member', permissions: {} } : null);
  }, []);

  const leaveHousehold = useCallback(async () => {
    const firebaseUser = auth.currentUser;
    if (!firebaseUser || !currentUser?.householdId || !household) {
      toast({ variant: 'destructive', title: 'No household', description: 'There is no household to leave.' });
      return false;
    }
    try {
      const result = await leaveHouseholdAction({ idToken: await firebaseUser.getIdToken(), householdId: currentUser.householdId });
      if (!result.ok) {
        toast({ variant: 'destructive', title: 'Could not leave', description: result.message });
        return false;
      }
      resetHouseholdState();
      toast({ title: 'You left the household', description: `You are no longer part of ${household.name}.` });
      return true;
    } catch {
      toast({ variant: 'destructive', title: 'Could not leave', description: 'We could not reach HomeHub. Try again.' });
      return false;
    }
  }, [currentUser?.householdId, household, resetHouseholdState, toast]);

  const deleteHousehold = useCallback(async (confirmName: string) => {
    const firebaseUser = auth.currentUser;
    if (!firebaseUser || !currentUser?.householdId || !household) return false;
    try {
      const result = await deleteHouseholdAction({
        idToken: await firebaseUser.getIdToken(),
        householdId: currentUser.householdId,
        confirmName,
      });
      if (!result.ok) {
        toast({ variant: 'destructive', title: 'Could not delete', description: result.message });
        return false;
      }
      resetHouseholdState();
      toast({ title: 'Household deleted', description: `${household.name} and everything in it were deleted.` });
      return true;
    } catch {
      toast({ variant: 'destructive', title: 'Could not delete', description: 'We could not reach HomeHub. Try again.' });
      return false;
    }
  }, [currentUser?.householdId, household, resetHouseholdState, toast]);

  // Stable identity: consumers list permissions in effect and callback dependencies.
  const permissions = useMemo(() => getMemberPermissions(currentMember), [currentMember]);

  const value = {
    currentUser,
    household,
    currentMember,
    permissions,
    loading,
    householdLoading,
    profileConfirmed,
    householdLoadFailed,
    retryHouseholdLoad,
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
      {children}
    </AuthContext.Provider>
  );
}
