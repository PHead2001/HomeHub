
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
import { useToast } from '@/hooks/use-toast';
import { doc, getDoc, setDoc, onSnapshot, collection, query, where, writeBatch, getDocs, deleteDoc } from 'firebase/firestore';
import type { User, HomeAssistantCredentials, Household } from '@/lib/types';
import { auth, db } from '@/lib/firebase';
import { slugify } from '@/lib/utils';


// --- Types ---
interface AuthContextType {
  currentUser: User | null;
  household: Household | null;
  loading: boolean;
  signInWithGoogle: () => Promise<void>;
  logout: () => void;
  updateUser: (data: Partial<Omit<User, 'uid' | 'email'>>, newPassword?: string) => Promise<void>;
  saveHomeAssistantCredentials: (credentials: HomeAssistantCredentials) => Promise<void>;
  disconnectHomeAssistant: () => Promise<void>;
  createHousehold: (name: string) => Promise<void>;
  joinHousehold: (code: string) => Promise<void>;
};

// --- Context Definition ---
export const AuthContext = createContext<AuthContextType | null>(null);

const generateInviteCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// --- Provider Component ---
export function AuthProvider({ children }: { children: ReactNode }) {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [household, setHousehold] = useState<Household | null>(null);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  const fetchOrCreateUserProfile = useCallback(async (firebaseUser: FirebaseAuthUser, googleProfileData?: any): Promise<User | null> => {
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
        role: 'admin',
        forcePasswordChange: false,
        householdId: null,
      }
      await setDoc(userDocRef, dataToSave);
      return { uid: firebaseUser.uid, ...dataToSave } as User;
    }

    const names = googleProfileData.names?.[0] || {};
    const birthdays = googleProfileData.birthdays?.[0]?.date || {};
    const genders = googleProfileData.genders?.[0]?.value;

    const newUserProfile: Omit<User, 'uid'> = {
      email: firebaseUser.email as string,
      displayName: names.displayName || firebaseUser.displayName || firebaseUser.email.split('@')[0],
      firstName: names.givenName,
      lastName: names.familyName,
      avatarUrl: googleProfileData.photos?.[0]?.url || firebaseUser.photoURL,
      role: 'admin',
      forcePasswordChange: false,
      householdId: null,
      birthday: birthdays?.month && birthdays?.day ? `${birthdays.month}/${birthdays.day}` : undefined,
      gender: genders,
    };
    
    const dataToSave: Record<string, any> = {};
    for (const [key, value] of Object.entries(newUserProfile)) {
      if (value !== undefined && value !== null) {
        dataToSave[key] = value;
      }
    }

    await setDoc(userDocRef, dataToSave);
    toast({ title: "Welcome!", description: "Your new account has been created." });
    return { uid: firebaseUser.uid, ...dataToSave } as User;

  }, [toast]);
  

  // This effect runs when the householdId on the currentUser changes
  useEffect(() => {
    const fetchHousehold = async () => {
      if (currentUser?.householdId) {
        const householdDocRef = doc(db, 'households', currentUser.householdId);
        try {
          const docSnap = await getDoc(householdDocRef);
          if (docSnap.exists()) {
            setHousehold({ id: docSnap.id, ...docSnap.data() } as Household);
          } else {
            console.warn("Household not found, resetting for user.");
            setHousehold(null);
            // This could happen if a household is deleted. Reset the user's householdId.
            if (currentUser.email) {
              const userDocRef = doc(db, 'users', currentUser.email);
              setDoc(userDocRef, { householdId: null }, { merge: true });
            }
          }
        } catch (error) {
          console.error("Error fetching household document:", error);
          setHousehold(null);
        }
      } else {
        setHousehold(null);
      }
    };

    fetchHousehold();
  }, [currentUser?.householdId, currentUser?.email]);

  // This is for session management ONLY (on page refresh)
  useEffect(() => {
    const unsubscribeAuth = onAuthStateChanged(auth, async (firebaseUser) => {
      setLoading(true);
      if (firebaseUser) {
        // On refresh, we only fetch the existing profile. Creation happens at sign-in.
        const userProfile = await fetchOrCreateUserProfile(firebaseUser);
        if (userProfile) {
            setCurrentUser(userProfile);
        } else {
            setCurrentUser(null);
            setHousehold(null);
        }
      } else {
        // User is not logged in
        setCurrentUser(null);
        setHousehold(null);
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
      
      const googleProfileData = await peopleRes.json();
      
      // The user profile is created or fetched immediately after sign-in with the full data.
      const userProfile = await fetchOrCreateUserProfile(firebaseUser, googleProfileData);

      if (userProfile) {
        setCurrentUser(userProfile);
        toast({ title: 'Login Successful', description: 'Welcome!' });
      }

    } catch (error: any) {
        console.error("Google Sign-In Error:", error);
        let message = 'An unknown error occurred during login.';
        if (error.code === 'auth/popup-closed-by-user') {
            message = 'Sign-in window was closed before completing.'
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
    
    } catch (error: any) {
      console.error("Update User Error:", error);
      let description = "An unknown error occurred.";
      if (error.code === 'auth/requires-recent-login') {
          description = "This action requires you to have recently logged in. Please log out and log back in to continue.";
      } else {
          description = error.message;
      }
      toast({ variant: 'destructive', title: 'Update Failed', description });
    } finally {
        setLoading(false);
    }
  }, [currentUser, toast]);

  const saveHomeAssistantCredentials = useCallback(async (credentials: HomeAssistantCredentials) => {
    if (!currentUser?.householdId) {
      toast({ variant: 'destructive', title: 'No Household', description: "You must be in a household to configure Home Assistant." });
      return;
    }
    const configDocRef = doc(db, 'households', currentUser.householdId, 'home-automation', 'credentials');
    try {
      await setDoc(configDocRef, credentials);
      toast({ title: 'Credentials Saved', description: 'Successfully connected to Home Assistant.' });
    } catch (error) {
      console.error('Failed to save Home Assistant credentials', error);
      toast({ variant: 'destructive', title: 'Save Failed', description: 'Could not save credentials.' });
    }
  }, [currentUser?.householdId, toast]);

  const disconnectHomeAssistant = useCallback(async () => {
    if (!currentUser?.householdId) {
      toast({ variant: 'destructive', title: 'No Household', description: "You must be in a household to disconnect Home Assistant." });
      return;
    }
    const configDocRef = doc(db, 'households', currentUser.householdId, 'home-automation', 'credentials');
    try {
      await deleteDoc(configDocRef);
      toast({ title: 'Disconnected', description: 'Successfully disconnected from Home Assistant.' });
    } catch (error) {
       console.error('Failed to delete Home Assistant credentials', error);
      toast({ variant: 'destructive', title: 'Disconnect Failed', description: 'Could not disconnect.' });
    }
  }, [currentUser?.householdId, toast]);

  const createHousehold = useCallback(async (name: string) => {
    if (!currentUser?.email) {
        toast({ variant: 'destructive', title: 'Not Authenticated' });
        return;
    }

    const newHouseholdId = slugify(name);
    const householdDocRef = doc(db, 'households', newHouseholdId);
    
    const householdSnap = await getDoc(householdDocRef);
    if (householdSnap.exists()) {
        toast({ variant: 'destructive', title: 'Household Exists', description: 'A household with a very similar name already exists. Please choose a different name.' });
        return;
    }

    const userDocRef = doc(db, 'users', currentUser.email);

    const newHouseholdData: Omit<Household, 'id'> = {
        name,
        ownerEmail: currentUser.email,
        memberEmails: [currentUser.email],
        createdAt: new Date().toISOString(),
        inviteCode: generateInviteCode()
    }
    
    try {
        const batch = writeBatch(db);
        batch.set(householdDocRef, newHouseholdData);
        batch.update(userDocRef, { householdId: newHouseholdId });
        await batch.commit();

        setCurrentUser(prev => prev ? { ...prev, householdId: newHouseholdId } : null);

        toast({ title: 'Household Created!', description: `Welcome to ${name}!` });
    } catch (error) {
        console.error('Failed to create household', error);
        toast({ variant: 'destructive', title: 'Creation Failed', description: 'Could not create the new household.' });
    }
  }, [currentUser, toast]);

  const joinHousehold = useCallback(async (code: string) => {
    if (!currentUser?.email) {
        toast({ variant: 'destructive', title: 'Not Authenticated' });
        return;
    }
    const householdsRef = collection(db, 'households');
    const q = query(householdsRef, where('inviteCode', '==', code.toUpperCase()));
    
    try {
        const querySnapshot = await getDocs(q);
        if (querySnapshot.empty) {
            toast({ variant: 'destructive', title: 'Invalid Code', description: 'No household found with that invite code.' });
            return;
        }

        const householdDoc = querySnapshot.docs[0];
        const householdData = householdDoc.data() as Household;

        if (householdData.memberEmails.includes(currentUser.email)) {
            toast({ title: 'Already a Member', description: 'You are already a member of this household.' });
            setCurrentUser(prev => prev ? { ...prev, householdId: householdDoc.id } : null);
            return;
        }

        const householdDocRef = doc(db, 'households', householdDoc.id);
        const userDocRef = doc(db, 'users', currentUser.email);

        const batch = writeBatch(db);
        batch.update(householdDocRef, { memberEmails: [...householdData.memberEmails, currentUser.email] });
        batch.update(userDocRef, { householdId: householdDoc.id });
        await batch.commit();
        
        setCurrentUser(prev => prev ? { ...prev, householdId: householdDoc.id } : null);

        toast({ title: 'Welcome!', description: `You've joined ${householdData.name}!` });

    } catch (error) {
        console.error('Failed to join household', error);
        toast({ variant: 'destructive', title: 'Join Failed', description: 'Could not join the household.' });
    }
  }, [currentUser, toast]);

  const value = { currentUser, household, loading, signInWithGoogle, logout, updateUser, saveHomeAssistantCredentials, disconnectHomeAssistant, createHousehold, joinHousehold };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}
