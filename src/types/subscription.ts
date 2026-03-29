import { Timestamp } from '@react-native-firebase/firestore';

export type Plan = 'free' | 'pro' | 'premium' | 'vip';

// Active: normal operation
// Grace period: payment failed, limited functionality, no new staff
// Canceled: plan ended, reverted to free limits
export type SubscriptionStatus =
  | 'active'
  | 'grace_period'
  | 'canceled'
  | 'trialing';

export type AddonType = 'extra_storage' | 'extra_seats' | 'advanced_analytics';

export type Addon = {
  id: string;
  clinicId: string;
  type: AddonType;
  price: number; // CHF/month
  active: boolean;
  stripeItemId: string | null;
};

export type PendingDowngrade = {
  targetPlan: Plan;
  targetSeats: number;
  conflictingSeats: number;
  effectiveDate: Timestamp;
  stripeScheduleId: string | null; // Subscription Schedule ID (paid→paid) for cancellation
};

export type Subscription = {
  clinicId: string;
  plan: Plan;
  status: SubscriptionStatus;
  currentPeriodEnd: Timestamp;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  // Set during grace period — how long until plan reverts
  gracePeriodEnd: Timestamp | null;
  // Set when a downgrade is queued due to seat conflict (Scenario 2)
  pendingDowngrade: PendingDowngrade | null;
};

// Plan metadata — source of truth for seat limits and pricing
export const PLAN_CONFIG: Record<
  Plan,
  { price: number; seats: number; label: string }
> = {
  free: { price: 0, seats: 1, label: 'Free' },
  pro: { price: 99, seats: 5, label: 'Pro' },
  premium: { price: 249, seats: 15, label: 'Premium' },
  vip: { price: 499, seats: Infinity, label: 'VIP' },
};

export const ADDON_CONFIG: Record<
  AddonType,
  { price: number; label: string; description: string }
> = {
  extra_storage: {
    price: 19,
    label: 'Extra Storage',
    description: 'Unlocks file attachments on appointments',
  },
  extra_seats: {
    price: 49,
    label: 'Extra Seats Pack',
    description: '+5 staff seats',
  },
  advanced_analytics: {
    price: 79,
    label: 'Advanced Analytics',
    description: 'Unlocks the analytics screen',
  },
};
