// Stripe service — client-side helpers and typed stubs.
// Actual Stripe operations happen in Cloud Functions (functions/src/stripe/).
// The client calls Firebase Functions, which call Stripe server-side.
// This keeps the Stripe secret key off the device.

import functions from '@react-native-firebase/functions';

const USE_EMULATOR = process.env.EXPO_PUBLIC_USE_EMULATOR === 'true';
const EMULATOR_HOST = process.env.EXPO_PUBLIC_EMULATOR_HOST ?? 'localhost';

if (USE_EMULATOR) {
  functions().useEmulator(EMULATOR_HOST, 5001);
}

export type CreateCheckoutParams = {
  clinicId: string;
  plan: 'pro' | 'premium' | 'vip';
  discountCode?: string;
};

export type CheckoutResult = {
  sessionId: string;
  url: string;
};

export async function createCheckoutSession(
  params: CreateCheckoutParams,
): Promise<CheckoutResult> {
  const fn = functions().httpsCallable('createCheckoutSession');
  const result = await fn(params);
  return result.data as CheckoutResult;
}

export type AddonPurchaseParams = {
  clinicId: string;
  addonType: 'extra_storage' | 'extra_seats' | 'advanced_analytics';
  discountCode?: string;
};

export async function purchaseAddon(
  params: AddonPurchaseParams,
): Promise<void> {
  const fn = functions().httpsCallable('purchaseAddon');
  await fn(params);
}

export type DowngradeParams = {
  clinicId: string;
  targetPlan: 'free' | 'pro' | 'premium';
};

export type DowngradeResult = {
  // 'immediate': downgrade processed now (no seat conflict, or user resolved conflict)
  // 'queued': scheduled for end of billing period (seat conflict detected)
  strategy: 'immediate' | 'queued';
  conflictingSeats?: number; // how many seats exceed target plan limit
  effectiveDate?: string; // ISO date if queued
};

export async function initiateDowngrade(
  params: DowngradeParams,
): Promise<DowngradeResult> {
  const fn = functions().httpsCallable('initiateDowngrade');
  const result = await fn(params);
  return result.data as DowngradeResult;
}

export async function cancelPendingDowngrade(clinicId: string): Promise<void> {
  const fn = functions().httpsCallable('cancelPendingDowngrade');
  await fn({ clinicId });
}
