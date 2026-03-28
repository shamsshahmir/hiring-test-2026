import { Timestamp } from '@react-native-firebase/firestore';

export type AppointmentStatus =
  | 'scheduled'
  | 'confirmed'
  | 'completed'
  | 'canceled';

export type Appointment = {
  id: string;
  patientId: string;
  staffId: string;
  clinicId: string;
  status: AppointmentStatus;
  datetime: Timestamp;
  notes: string | null;
  // TODO [CHALLENGE]: Add attachments field — only available with extra_storage add-on
  // attachments?: string[]; // storage URLs
};
