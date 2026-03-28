import firestore from '@react-native-firebase/firestore';
import type { Clinic } from '@/types/clinic';
import type { User } from '@/types/user';
import type { Subscription } from '@/types/subscription';
import type { Appointment } from '@/types/appointment';
import type { Addon } from '@/types/subscription';
import type { Discount } from '@/types/discount';

const USE_EMULATOR = process.env.EXPO_PUBLIC_USE_EMULATOR === 'true';
const EMULATOR_HOST = process.env.EXPO_PUBLIC_EMULATOR_HOST ?? 'localhost';

if (USE_EMULATOR) {
  firestore().useEmulator(EMULATOR_HOST, 8080);
}

// --- Clinics ---

export function subscribeToClinic(
  clinicId: string,
  onUpdate: (clinic: Clinic) => void,
): () => void {
  return firestore()
    .collection('clinics')
    .doc(clinicId)
    .onSnapshot((snap) => {
      if (snap.exists) {
        onUpdate({ id: snap.id, ...snap.data() } as Clinic);
      }
    });
}

// --- Users ---

export async function getUser(userId: string): Promise<User | null> {
  const snap = await firestore().collection('users').doc(userId).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() } as User;
}

export async function getClinicMembers(clinicId: string): Promise<User[]> {
  const snap = await firestore()
    .collection('users')
    .where('clinicId', '==', clinicId)
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as User);
}

// --- Subscriptions ---

export function subscribeToSubscription(
  clinicId: string,
  onUpdate: (sub: Subscription) => void,
): () => void {
  return firestore()
    .collection('subscriptions')
    .doc(clinicId)
    .onSnapshot((snap) => {
      if (snap.exists) {
        onUpdate({ clinicId, ...snap.data() } as Subscription);
      }
    });
}

// --- Appointments ---

export function subscribeToClinicAppointments(
  clinicId: string,
  onUpdate: (appointments: Appointment[]) => void,
): () => void {
  return firestore()
    .collection('appointments')
    .where('clinicId', '==', clinicId)
    .orderBy('datetime', 'asc')
    .onSnapshot((snap) => {
      const appointments = snap.docs.map(
        (d) => ({ id: d.id, ...d.data() }) as Appointment,
      );
      onUpdate(appointments);
    });
}

export function subscribeToPatientAppointments(
  patientId: string,
  onUpdate: (appointments: Appointment[]) => void,
): () => void {
  return firestore()
    .collection('appointments')
    .where('patientId', '==', patientId)
    .orderBy('datetime', 'asc')
    .onSnapshot((snap) => {
      const appointments = snap.docs.map(
        (d) => ({ id: d.id, ...d.data() }) as Appointment,
      );
      onUpdate(appointments);
    });
}

// --- Add-ons ---

export async function getClinicAddons(clinicId: string): Promise<Addon[]> {
  const snap = await firestore()
    .collection('addons')
    .doc(clinicId)
    .collection('items')
    .where('active', '==', true)
    .get();
  return snap.docs.map((d) => ({ id: d.id, clinicId, ...d.data() }) as Addon);
}

// --- Discounts ---

export async function getClinicDiscounts(
  clinicId: string,
): Promise<Discount[]> {
  // Fetch discounts referenced by the clinic's activeDiscounts array
  const clinicSnap = await firestore()
    .collection('clinics')
    .doc(clinicId)
    .get();
  const clinic = clinicSnap.data() as Clinic;
  if (!clinic?.activeDiscounts?.length) return [];

  const discountDocs = await Promise.all(
    clinic.activeDiscounts.map((code) =>
      firestore()
        .collection('discounts')
        .where('code', '==', code)
        .limit(1)
        .get(),
    ),
  );

  return discountDocs
    .flatMap((snap) => snap.docs)
    .map((d) => ({ id: d.id, ...d.data() }) as Discount);
}
