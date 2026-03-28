import { create } from 'zustand';
import auth from '@react-native-firebase/auth';
import { getUser } from '@/services/firestore';
import type { User } from '@/types/user';

type AuthState = {
  firebaseUser:
    | import('@react-native-firebase/auth').FirebaseAuthTypes.User
    | null;
  userProfile: User | null;
  isLoading: boolean;
  setFirebaseUser: (
    user: import('@react-native-firebase/auth').FirebaseAuthTypes.User | null,
  ) => void;
  loadUserProfile: (uid: string) => Promise<void>;
  reset: () => void;
};

export const useAuthStore = create<AuthState>((set) => ({
  firebaseUser: null,
  userProfile: null,
  isLoading: true,

  setFirebaseUser: (user) => set({ firebaseUser: user }),

  loadUserProfile: async (uid) => {
    const profile = await getUser(uid);
    set({ userProfile: profile, isLoading: false });
  },

  reset: () => set({ firebaseUser: null, userProfile: null, isLoading: false }),
}));

// Set up the Firebase Auth listener — call once at app startup
export function initAuthListener(): () => void {
  return auth().onAuthStateChanged(async (user) => {
    const { setFirebaseUser, loadUserProfile, reset } = useAuthStore.getState();
    if (user) {
      setFirebaseUser(user);
      try {
        await loadUserProfile(user.uid);
      } catch (err) {
        console.error('Failed to load user profile, signing out:', err);
        // Stale session — sign out to force re-login with fresh credentials
        await auth().signOut();
        reset();
      }
    } else {
      reset();
    }
  });
}
