
'use client';

import {
  createContext,
  useState,
  useEffect,
  type ReactNode,
  useCallback,
} from 'react';
import {
  onAuthStateChanged,
  signOut,
  updatePassword,
  signInWithPopup,
  type User as FirebaseAuthUser,
  GoogleAuthProvider,
} from 'firebase/auth';
import {
  arrayRemove,
  collection,
  deleteField,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { useToast } from '@/hooks/use-toast';
import { auth, db } from '@/lib/firebase';
import { buildNotificationDocument } from '@/lib/notifications';
import { getMemberPermissions, normalizeRole } from '@/lib/permissions';
import { normalizeInviteCode } from '@/lib/invite-codes';
import { joinHouseholdWithInvite } from '@/app/household/actions';
import type {
  Household,
  HouseholdMember,
  HouseholdPermission,
  User,
} from '@/lib/types';

type PermissionMap = Record<HouseholdPermission, boolean>;

interface AuthContextType {
  currentUser: User | null;
  household: Household | null;
  currentMember: HouseholdMember | null;
  permissions: PermissionMap;
  loading: boolean;
  householdLoading: boolean;
  signInWithGoogle: () => Promise<void>;
  logout: () => void;
  updateUser: (data: Partial<Omit<User, 'uid' | 'email'>>, newPassword?: string) => Promise<void>;
  createHousehold: (name: string) => Promise<void>;
  joinHousehold: (code: string) => Promise<boolean>;
  leaveHousehold: () => Promise<void>;
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

type GoogleProfileData = {
  names?: Array<{
    displayName?: string;
    givenName?: string;
    familyName?: string;
  }>;
  birthdays?: Array<{
    date?: {
      month?: number;
      day?: number;
    };
  }>;
  genders?: Array<{
    value?: string;
  }>;
  photos?: Array<{
    url?: string;
  }>;
};

const hasErrorCode = (error: unknown): error is Error & { code: string } => {
  if (!(error instanceof Error) || !('code' in error)) {
    return false;
  }
  return typeof (error as Error & { code?: unknown }).code === 'string';
};

const getErrorMessage = (error: unknown) => error instanceof Error ? error.message : undefined;

// --- Provider Component ---
export function AuthProvider({ children }: { children: ReactNode }) {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [household, setHousehold] = useState<Household | null>(null);
  const [currentMember, setCurrentMember] = useState<HouseholdMember | null>(null);
  const [loading, setLoading] = useState(true);
  const [householdLoading, setHouseholdLoading] = useState(true);
  const { toast } = useToast();

  const fetchOrCreateUserProfile = useCallback(async (firebaseUser: FirebaseAuthUser, googleProfileData?: GoogleProfileData): Promise<User | null> => {
    if (!firebaseUser.email) {
      toast({ variant: 'destructive', title: "Sign-in error", description: "No email address found for user."});
      return null;
    }
    const userDocRef = doc(db, 'users', firebaseUser.email);
    const docSnap = await getDoc(userDocRef);

    if (docSnap.exists()) {
      return { uid: firebaseUser.uid, ...docSnap.data() } as User;
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
      await setDoc(userDocRef, dataToSave);
      return { uid: firebaseUser.uid, ...dataToSave } as User;
    }

    const names = googleProfileData.names?.[0] || {};
    const birthdays = googleProfileData.birthdays?.[0]?.date || {};
    const genders = googleProfileData.genders?.[0]?.value;

    const newUserProfile: Partial<Omit<User, 'uid'>> = {
      email: firebaseUser.email,
      displayName: names.displayName || firebaseUser.displayName || firebaseUser.email.split('@')[0],
      firstName: names.givenName,
      lastName: names.familyName,
      avatarUrl: googleProfileData.photos?.[0]?.url || firebaseUser.photoURL,
      role: 'member',
      forcePasswordChange: false,
      householdId: null,
      birthday: birthdays?.month && birthdays?.day ? `${birthdays.month}/${birthdays.day}` : undefined,
      gender: genders,
    };
    
    const dataToSave = Object.fromEntries(
      Object.entries(newUserProfile).filter(([, value]) => value !== undefined && value !== null)
    ) as Partial<Omit<User, 'uid'>>;

    await setDoc(userDocRef, dataToSave);
    toast({ title: "Welcome!", description: "Your new account has been created." });
    return { uid: firebaseUser.uid, ...dataToSave } as User;

  }, [toast]);
  

  // This effect runs when the householdId on the currentUser changes.
  useEffect(() => {
    const cleanupLegacyInviteCode = async (householdData: Household, role: HouseholdMember['role']) => {
      if (role !== 'owner' || !householdData.inviteCode) return;
      try {
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

      const memberSnap = await getDoc(doc(db, 'households', householdId, 'members', currentUser.uid));
      if (!memberSnap.exists()) return null;

      const memberData = memberSnap.data() as HouseholdMember;
      const normalizedMember = {
        ...memberData,
        uid: currentUser.uid,
        role: normalizeRole(memberData.role),
        status: memberData.status || (memberData.role === 'newuser' ? 'pending' : 'active'),
      } as HouseholdMember;

      const householdSnap = await getDoc(doc(db, 'households', householdId));
      if (!householdSnap.exists()) return null;

      const householdData = { id: householdSnap.id, ...householdSnap.data() } as Household;
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
      return normalizedMember;
    };

    const clearStaleHousehold = async () => {
      setHousehold(null);
      setCurrentMember(null);
      if (!currentUser?.email || !currentUser.householdId) return;
      try {
        await setDoc(doc(db, 'users', currentUser.email), { householdId: null, role: 'member', permissions: {} }, { merge: true });
        setCurrentUser(prev => prev ? { ...prev, householdId: null, role: 'member', permissions: {} } : prev);
      } catch (error) {
        console.warn('Could not clear a stale household reference from the profile.', error);
      }
    };

    const fetchHousehold = async () => {
      setHouseholdLoading(true);
      try {
        if (!currentUser?.householdId) {
          setHousehold(null);
          setCurrentMember(null);
          return;
        }
        try {
          const member = await loadMembership(currentUser.householdId);
          if (!member) await clearStaleHousehold();
        } catch (error) {
          // Permission denied means this account is not a member of that household.
          console.warn('Household membership could not be loaded.', error);
          await clearStaleHousehold();
        }
      } finally {
        setHouseholdLoading(false);
      }
    };

    fetchHousehold();
  }, [
    currentUser?.avatarUrl,
    currentUser?.displayName,
    currentUser?.email,
    currentUser?.householdId,
    currentUser?.permissions,
    currentUser?.role,
    currentUser?.uid,
  ]);

  // This is for session management ONLY (on page refresh)
  useEffect(() => {
    const unsubscribeAuth = onAuthStateChanged(auth, async (firebaseUser) => {
      setLoading(true);
      if (firebaseUser) {
        // On refresh, we only fetch the existing profile. Creation happens at sign-in.
        const userProfile = await fetchOrCreateUserProfile(firebaseUser);
        if (userProfile) {
            setHouseholdLoading(true);
            setCurrentUser(userProfile);
        } else {
        setCurrentUser(null);
        setHousehold(null);
        setCurrentMember(null);
        setHouseholdLoading(false);
      }
      } else {
        // User is not logged in
        setCurrentUser(null);
        setHousehold(null);
        setCurrentMember(null);
        setHouseholdLoading(false);
      }
      setLoading(false);
    });

    return () => unsubscribeAuth();
  }, [fetchOrCreateUserProfile]);


  const signInWithGoogle = useCallback(async (): Promise<void> => {
    setLoading(true);
    const googleProvider = new GoogleAuthProvider();
    googleProvider.addScope("https://www.googleapis.com/auth/user.birthday.read");
    googleProvider.addScope("https://www.googleapis.com/auth/user.gender.read");
    googleProvider.setCustomParameters({ prompt: "consent" });

    try {
      const result = await signInWithPopup(auth, googleProvider);
      const { user: firebaseUser } = result;

      const credential = GoogleAuthProvider.credentialFromResult(result);
      const accessToken = credential?.accessToken;

      if (!accessToken) throw new Error("No access token from Google Sign-In.");
      
      const peopleRes = await fetch(
        "https://people.googleapis.com/v1/people/me?personFields=names,birthdays,genders,emailAddresses,photos",
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      if (!peopleRes.ok) throw new Error(`Google People API failed with status: ${peopleRes.status}`);
      
      const googleProfileData = await peopleRes.json() as GoogleProfileData;
      
      // The user profile is created or fetched immediately after sign-in with the full data.
      const userProfile = await fetchOrCreateUserProfile(firebaseUser, googleProfileData);

      if (userProfile) {
        setHouseholdLoading(true);
        setCurrentUser(userProfile);
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
  }, [fetchOrCreateUserProfile, toast]);

  const logout = useCallback(async () => {
    await signOut(auth);
    setCurrentUser(null);
    setHousehold(null);
    setCurrentMember(null);
    setHouseholdLoading(false);
    toast({ title: "Logged Out", description: "You have been successfully logged out." });
  },[toast]);
  
  const updateUser = useCallback(async (data: Partial<Omit<User, 'uid' | 'email'>>, newPassword?: string) => {
    if (!auth.currentUser || !currentUser?.email) {
      toast({ variant: 'destructive', title: 'Not Authenticated', description: 'You must be logged in to update your profile.' });
      return;
    }
    setLoading(true);
    try {
      if (newPassword && auth.currentUser.providerData.some(p => p.providerId === 'password')) {
        toast({title: 'Updating Password...'})
        await updatePassword(auth.currentUser, newPassword);
        toast({title: 'Password Updated Successfully!'})
        data.forcePasswordChange = false;
      }
      
      const userDocRef = doc(db, 'users', currentUser.email);
      await setDoc(userDocRef, data, { merge: true });
      setCurrentUser(prev => prev ? { ...prev, ...data } : null);
      toast({ title: 'Profile Updated', description: 'Your information has been successfully updated.' });
    
    } catch (error) {
      console.error("Update User Error:", error instanceof Error ? error : String(error));
      let description = "An unknown error occurred.";
      if (hasErrorCode(error) && error.code === 'auth/requires-recent-login') {
          description = "This action requires you to have recently logged in. Please log out and log back in to continue.";
      } else {
          description = getErrorMessage(error) || description;
      }
      toast({ variant: 'destructive', title: 'Update Failed', description });
    } finally {
        setLoading(false);
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
          description: getErrorMessage(error) || 'Could not create the new household.',
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

      setCurrentUser(prev => prev ? { ...prev, householdId: result.data.household.id, role: 'newuser', permissions: {} } : null);
      setHousehold(result.data.household);
      setCurrentMember(result.data.member);
      toast({ title: 'Request sent', description: `An owner or admin of ${result.data.household.name} will approve you shortly.` });
      return true;
    } catch (error) {
      console.error('Failed to join household', error);
      toast({ variant: 'destructive', title: 'Could not join', description: 'We could not reach HomeHub. Check your connection and try again.' });
      return false;
    }
  }, [currentUser, toast]);

  const leaveHousehold = useCallback(async () => {
    if (!currentUser?.email || !currentUser.householdId || !household || !currentMember) {
      toast({ variant: 'destructive', title: 'No Household', description: 'There is no household to leave.' });
      return;
    }
    if (currentMember.role === 'owner') {
      toast({
        variant: 'destructive',
        title: 'Owner Cannot Leave',
        description: 'Transfer ownership or delete the household before leaving.',
      });
      return;
    }

    try {
      const householdId = currentUser.householdId;
      const batch = writeBatch(db);
      const now = new Date().toISOString();
      batch.delete(doc(db, 'households', householdId, 'members', currentUser.uid));
      batch.update(doc(db, 'households', householdId), {
        memberEmails: arrayRemove(currentUser.email),
        updatedAt: now,
      });
      batch.set(doc(db, 'users', currentUser.email), {
        householdId: null,
        role: 'member',
        permissions: {},
      }, { merge: true });
      batch.set(doc(collection(db, 'households', householdId, 'auditLogs')), {
        actorUid: currentUser.uid,
        actorEmail: currentUser.email,
        actorName: currentUser.displayName,
        action: 'member.left',
        targetUid: currentUser.uid,
        targetEmail: currentUser.email,
        targetName: currentUser.displayName,
        createdAt: now,
      });
      batch.set(doc(collection(db, 'households', householdId, 'notifications')), buildNotificationDocument({
        householdId,
        category: 'system',
        title: 'Member left household',
        message: `${currentUser.displayName || currentUser.email} left the household.`,
        deepLink: '/household?tab=members',
        sourceType: 'household-member-left',
        sourceId: currentUser.uid,
      }));

      const choresSnap = await getDocs(query(
        collection(db, 'households', householdId, 'chores'),
        where('assignedToEmail', '==', currentUser.email)
      ));
      choresSnap.forEach((choreDoc) => {
        batch.update(choreDoc.ref, {
          assignedToEmail: '',
          assignedToDisplayName: 'Unassigned',
        });
      });

      const templatesSnap = await getDocs(query(
        collection(db, 'households', householdId, 'chore-templates'),
        where('assignedToEmail', '==', currentUser.email)
      ));
      templatesSnap.forEach((templateDoc) => {
        batch.update(templateDoc.ref, {
          assignedToEmail: null,
        });
      });

      await batch.commit();
      setCurrentUser(prev => prev ? { ...prev, householdId: null, role: 'member', permissions: {} } : null);
      setHousehold(null);
      setCurrentMember(null);
      toast({ title: 'Left Household', description: `You left ${household.name}.` });
    } catch (error) {
      console.error('Failed to leave household', error);
      toast({ variant: 'destructive', title: 'Leave Failed', description: getErrorMessage(error) || 'Could not leave the household.' });
    }
  }, [currentMember, currentUser, household, toast]);

  const permissions = getMemberPermissions(currentMember);

  const value = {
    currentUser,
    household,
    currentMember,
    permissions,
    loading,
    householdLoading,
    signInWithGoogle,
    logout,
    updateUser,
    createHousehold,
    joinHousehold,
    leaveHousehold,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}
