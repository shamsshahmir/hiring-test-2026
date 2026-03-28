import { Redirect } from 'expo-router';
import { useAuthStore } from '@/store/authStore';

export default function Index() {
  const firebaseUser = useAuthStore((s) => s.firebaseUser);

  if (firebaseUser) {
    return <Redirect href="/(app)/appointments" />;
  }

  return <Redirect href="/(auth)/login" />;
}
