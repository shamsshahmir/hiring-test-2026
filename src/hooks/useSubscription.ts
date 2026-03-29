import { useClinicStore } from '@/store/clinicStore';
import type { Plan } from '@/types/subscription';
import { PLAN_CONFIG } from '@/types/subscription';
import type { PendingDowngrade } from '@/types/subscription';

export function useSubscription() {
  const { clinic, subscription } = useClinicStore();

  const plan: Plan = subscription?.plan ?? 'free';
  const config = PLAN_CONFIG[plan];

  const seatsUsed = clinic?.seats.used ?? 0;
  const seatsMax = clinic?.seats.max ?? config.seats;
  const seatsAvailable = seatsMax === Infinity ? Infinity : seatsMax - seatsUsed;
  const pendingDowngrade: PendingDowngrade | null = (subscription as any)?.pendingDowngrade ?? null;

  return {
    plan,
    status: subscription?.status ?? 'canceled',
    config,
    seatsUsed,
    seatsMax,
    seatsAvailable,
    pendingDowngrade,
    isActive: subscription?.status === 'active',
    isGracePeriod: subscription?.status === 'grace_period',
    canAddStaff: seatsAvailable > 0 && subscription?.status === 'active' && !pendingDowngrade,
  };
}
