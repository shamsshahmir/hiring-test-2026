import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';
import type { User } from '@/types/user';

const USE_EMULATOR = process.env.EXPO_PUBLIC_USE_EMULATOR === 'true';
const EMULATOR_HOST = process.env.EXPO_PUBLIC_EMULATOR_HOST ?? 'localhost';

if (USE_EMULATOR) {
  auth().useEmulator(`http://${EMULATOR_HOST}:9099`);
}

export async function signUp(
  email: string,
  password: string,
  displayName: string,
  role: 'owner' | 'patient' = 'patient',
): Promise<void> {
  const credential = await auth().createUserWithEmailAndPassword(
    email,
    password,
  );
  await credential.user.updateProfile({ displayName });

  // Write user doc to Firestore
  const userData: Omit<User, 'id'> = {
    displayName,
    email,
    role,
    clinicId: null,
    createdAt: firestore.Timestamp.now(),
  };

  await firestore().collection('users').doc(credential.user.uid).set(userData);
}

export async function signIn(email: string, password: string): Promise<void> {
  await auth().signInWithEmailAndPassword(email, password);
}

export async function signOut(): Promise<void> {
  await auth().signOut();
}

// Force token refresh to pick up new custom claims (e.g., after role change)
// Call this after any server-side role update.
export async function refreshAuthToken(): Promise<void> {
  await auth().currentUser?.getIdToken(true);
}

/**
 * Removes a staff member and revokes their session.
 * Calls the removeStaffMember Cloud Function which:
 *   1. Deactivates seat in Firestore (blocks access via rules immediately)
 *   2. Revokes Firebase Auth refresh tokens (forces re-auth within 1 hour)
 *   3. Clears user's clinicId and reverts role to patient
 *
 * See DECISIONS.md for trade-off analysis (Option A+B combined approach).
 */
export async function removeStaffMember(
  clinicId: string,
  targetUserId: string,
): Promise<void> {
  const functions = (await import('@react-native-firebase/functions')).default;
  const fn = functions().httpsCallable('removeStaffMember');
  await fn({ clinicId, targetUserId });
}
