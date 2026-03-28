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

// TODO [CHALLENGE]: Implement session invalidation for removed staff (Scenario 6).
// When an owner removes a staff member, their Firebase Auth session on their device
// is still valid. Options:
//   A) Revoke refresh tokens server-side (Firebase Admin SDK — requires Cloud Function)
//   B) Check Firestore on every protected action — if user.active === false, block access
//   C) Use custom claims to set a 'disabled' flag and check it in Firestore rules
//
// Whichever approach you choose, document WHY in DECISIONS.md.
// The Firestore rule in seats/ is intentionally incomplete — your implementation goes there.
export async function revokeUserSession(_userId: string): Promise<void> {
  throw new Error(
    'TODO [CHALLENGE]: Implement revokeUserSession via Cloud Function',
  );
}
