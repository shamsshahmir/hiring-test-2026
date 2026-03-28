import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import Stripe from 'stripe';

// Lazy-init: env vars aren't available during emulator analysis step
let _stripe: Stripe;
function getStripe() {
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  return _stripe;
}

// Stripe Price IDs — set these in Firebase config or environment variables
const PRICE_IDS: Record<string, string> = {
  pro: 'price_1TFNdsKE5ra7Hrk1xtgF9wZ9',
  premium: 'price_1TFNg2KE5ra7Hrk1gDnw2G5u',
  vip: 'price_1TFNgrKE5ra7Hrk1vcprH34w',
  extra_storage: 'price_1TFNiBKE5ra7Hrk1qjT3kdxx',
  extra_seats: 'price_1TFNiwKE5ra7Hrk1Wg985hCC',
  advanced_analytics: 'price_1TFNjlKE5ra7Hrk1kKLNdDrz',
};

/**
 * Creates a Stripe Checkout session for plan upgrades.
 * Called from the React Native app via Firebase Functions callable.
 */
export const createCheckoutSession = onCall(async (request) => {
  if (!request.auth)
    throw new HttpsError('unauthenticated', 'Must be signed in');

  const { clinicId, plan, discountCode } = request.data as {
    clinicId: string;
    plan: 'pro' | 'premium' | 'vip';
    discountCode?: string;
  };

  const db = admin.firestore();

  // Verify caller is the clinic owner
  const userDoc = await db.collection('users').doc(request.auth.uid).get();
  const user = userDoc.data();
  if (!user || user.role !== 'owner' || user.clinicId !== clinicId) {
    throw new HttpsError(
      'permission-denied',
      'Only clinic owners can manage billing',
    );
  }

  // Get or create Stripe customer
  const subDoc = await db.collection('subscriptions').doc(clinicId).get();
  const sub = subDoc.data();
  let customerId: string;

  if (sub?.stripeCustomerId && sub.stripeCustomerId !== 'cus_test_REPLACE_ME') {
    customerId = sub.stripeCustomerId;
  } else {
    const clinicDoc = await db.collection('clinics').doc(clinicId).get();
    const clinic = clinicDoc.data();
    const customer = await getStripe().customers.create({
      email: user.email,
      name: clinic?.name,
      metadata: { clinicId },
    });
    customerId = customer.id;

    // Persist the customer ID so we don't create duplicates
    await subDoc.ref.set({ stripeCustomerId: customerId }, { merge: true });
  }

  // TODO [CHALLENGE]: Validate and apply discount code (Scenario 3 & 5).
  let stripeCouponId: string | undefined;
  if (discountCode) {
    console.log(
      'TODO [CHALLENGE]: Validate and apply discount code:',
      discountCode,
    );
  }

  const session = await getStripe().checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: PRICE_IDS[plan], quantity: 1 }],
    ...(stripeCouponId ? { discounts: [{ coupon: stripeCouponId }] } : {}),
    metadata: { clinicId, plan },
    success_url: 'clinicapp://billing?success=true',
    cancel_url: 'clinicapp://billing?canceled=true',
  });

  return { sessionId: session.id, url: session.url };
});

/**
 * Purchases an add-on for a clinic.
 */
export const purchaseAddon = onCall(async (request) => {
  if (!request.auth)
    throw new HttpsError('unauthenticated', 'Must be signed in');

  const { clinicId, addonType, discountCode } = request.data as {
    clinicId: string;
    addonType: 'extra_storage' | 'extra_seats' | 'advanced_analytics';
    discountCode?: string;
  };

  // TODO [CHALLENGE]: Implement add-on purchase (Scenario 3).
  console.log(
    'TODO [CHALLENGE]: Implement purchaseAddon for',
    addonType,
    'clinic',
    clinicId,
    discountCode,
  );
  throw new HttpsError(
    'unimplemented' as any,
    'TODO [CHALLENGE]: Implement purchaseAddon',
  );
});

/**
 * Initiates a plan downgrade with seat conflict detection.
 */
export const initiateDowngrade = onCall(async (request) => {
  if (!request.auth)
    throw new HttpsError('unauthenticated', 'Must be signed in');

  const { clinicId, targetPlan } = request.data as {
    clinicId: string;
    targetPlan: 'free' | 'pro' | 'premium';
  };

  // TODO [CHALLENGE]: Implement downgrade with seat conflict handling (Scenario 2).
  console.log(
    'TODO [CHALLENGE]: Implement initiateDowngrade to',
    targetPlan,
    'for clinic',
    clinicId,
  );
  throw new HttpsError(
    'unimplemented' as any,
    'TODO [CHALLENGE]: Implement initiateDowngrade',
  );
});

/**
 * Removes a staff member and invalidates their session.
 * Must be atomic: seat decrement + role update + session revocation in one operation.
 */
export const removeStaffMember = onCall(async (request) => {
  if (!request.auth)
    throw new HttpsError('unauthenticated', 'Must be signed in');

  const { clinicId, targetUserId } = request.data as {
    clinicId: string;
    targetUserId: string;
  };

  // TODO [CHALLENGE]: Implement staff removal + session invalidation (Scenario 6).
  console.log(
    'TODO [CHALLENGE]: Implement removeStaffMember for',
    targetUserId,
    'in clinic',
    clinicId,
  );
  throw new HttpsError(
    'unimplemented' as any,
    'TODO [CHALLENGE]: Implement removeStaffMember',
  );
});
