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
 *
 * Strategy: Stripe-first, Firestore-second with compensating rollback.
 *   1. Validate ownership, plan, and seat counts
 *   2. Acquire Firestore lock (transaction) to prevent concurrent downgrades
 *   3. Create Stripe schedule/cancellation FIRST
 *   4. Write pendingDowngrade to Firestore with schedule ID
 *   5. If Firestore write fails, roll back the Stripe change (compensating transaction)
 *
 * No conflict: processes immediately via Stripe subscription update.
 * Seat conflict: queues downgrade for end of billing period.
 *   - Paid→paid: uses Stripe Subscription Schedules to swap price at period end.
 *   - Paid→free: sets cancel_at_period_end on the subscription.
 */
export const initiateDowngrade = onCall(async (request) => {
  if (!request.auth)
    throw new HttpsError('unauthenticated', 'Must be signed in');

  const { clinicId, targetPlan } = request.data as {
    clinicId: string;
    targetPlan: 'free' | 'pro' | 'premium';
  };

  const db = admin.firestore();
  const { PLAN_CONFIG_SERVER } = await import('./planConfig');
  const { Timestamp } = await import('firebase-admin/firestore');
  const stripe = getStripe();

  // --- PHASE 1: Validate everything before touching Stripe ---

  const userDoc = await db.collection('users').doc(request.auth.uid).get();
  const user = userDoc.data();
  if (!user || user.role !== 'owner' || user.clinicId !== clinicId) {
    throw new HttpsError('permission-denied', 'Only clinic owners can manage billing');
  }

  const subDoc = await db.collection('subscriptions').doc(clinicId).get();
  const sub = subDoc.data();
  if (!sub?.stripeSubscriptionId || sub.stripeSubscriptionId === 'sub_test_REPLACE_ME') {
    throw new HttpsError('failed-precondition', 'No active subscription to downgrade');
  }

  const currentPrice = PLAN_CONFIG_SERVER[sub.plan as keyof typeof PLAN_CONFIG_SERVER]?.price ?? 0;
  const targetPrice = PLAN_CONFIG_SERVER[targetPlan]?.price ?? 0;
  if (targetPrice >= currentPrice) {
    throw new HttpsError('invalid-argument', 'Target plan must be cheaper than current plan');
  }

  if (sub.pendingDowngrade) {
    throw new HttpsError('already-exists', 'A downgrade is already pending');
  }

  // Authoritative seat count from subcollection
  const seatsSnap = await db
    .collection('seats').doc(clinicId)
    .collection('members')
    .where('active', '==', true)
    .get();
  const activeSeats = seatsSnap.size;
  const targetSeats = PLAN_CONFIG_SERVER[targetPlan].seats;

  // --- PHASE 2: No conflict — immediate downgrade ---
  if (activeSeats <= targetSeats) {
    if (targetPlan === 'free') {
      await stripe.subscriptions.cancel(sub.stripeSubscriptionId);
    } else {
      const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
      const currentItem = stripeSub.items.data[0];
      await stripe.subscriptions.update(sub.stripeSubscriptionId, {
        items: [{ id: currentItem.id, price: PRICE_IDS[targetPlan] }],
        proration_behavior: 'create_prorations',
      });
    }
    // Webhook handles Firestore update
    return { strategy: 'immediate' };
  }

  // --- PHASE 3: Seat conflict — Stripe first, then Firestore ---
  const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
  const periodEnd = stripeSub.current_period_end;
  const effectiveDate = typeof periodEnd === 'number'
    ? new Date(periodEnd > 1e12 ? periodEnd : periodEnd * 1000)
    : new Date();

  let stripeScheduleId: string | null = null;

  if (targetPlan === 'free') {
    // Paid→free: schedule cancellation at period end
    await stripe.subscriptions.update(sub.stripeSubscriptionId, {
      cancel_at_period_end: true,
    });
  } else {
    // Paid→paid: create Subscription Schedule to swap price at period end
    const schedule = await stripe.subscriptionSchedules.create({
      from_subscription: sub.stripeSubscriptionId,
      phases: [
        {
          items: [{ price: stripeSub.items.data[0].price.id, quantity: 1 }],
          start_date: stripeSub.current_period_start as number,
          end_date: periodEnd as number,
        },
        {
          items: [{ price: PRICE_IDS[targetPlan], quantity: 1 }],
          start_date: periodEnd as number,
        },
      ],
    } as unknown as Stripe.SubscriptionScheduleCreateParams);
    stripeScheduleId = schedule.id;
  }

  // --- PHASE 4: Write to Firestore — rollback Stripe on failure ---
  try {
    await db.runTransaction(async (tx) => {
      const subRef = db.collection('subscriptions').doc(clinicId);
      const freshSub = await tx.get(subRef);

      // Re-check for concurrent downgrade inside transaction
      if (freshSub.data()?.pendingDowngrade) {
        throw new Error('CONCURRENT_DOWNGRADE');
      }

      tx.update(subRef, {
        pendingDowngrade: {
          targetPlan,
          targetSeats,
          conflictingSeats: activeSeats - targetSeats,
          effectiveDate: Timestamp.fromDate(effectiveDate),
          stripeScheduleId,
        },
      });
    });
  } catch (err: any) {
    // Compensating rollback: undo the Stripe changes
    console.error('Firestore write failed, rolling back Stripe:', err);
    try {
      if (targetPlan === 'free') {
        await stripe.subscriptions.update(sub.stripeSubscriptionId, {
          cancel_at_period_end: false,
        });
      } else if (stripeScheduleId) {
        await stripe.subscriptionSchedules.release(stripeScheduleId);
      }
    } catch (rollbackErr) {
      console.error('CRITICAL: Stripe rollback also failed:', rollbackErr);
      // In production: alert ops team, create incident
    }

    if (err.message === 'CONCURRENT_DOWNGRADE') {
      throw new HttpsError('already-exists', 'A downgrade was just created by another request');
    }
    throw new HttpsError('internal', 'Failed to save downgrade. No changes were made.');
  }

  return {
    strategy: 'queued',
    conflictingSeats: activeSeats - targetSeats,
    effectiveDate: effectiveDate.toISOString(),
  };
});

/**
 * Cancels a pending downgrade.
 * Releases the Stripe Schedule (paid→paid) or un-sets cancel_at_period_end (paid→free).
 * Clears pendingDowngrade from Firestore.
 */
export const cancelPendingDowngrade = onCall(async (request) => {
  if (!request.auth)
    throw new HttpsError('unauthenticated', 'Must be signed in');

  const { clinicId } = request.data as { clinicId: string };
  const db = admin.firestore();
  const stripe = getStripe();

  // Verify owner
  const userDoc = await db.collection('users').doc(request.auth.uid).get();
  const user = userDoc.data();
  if (!user || user.role !== 'owner' || user.clinicId !== clinicId) {
    throw new HttpsError('permission-denied', 'Only clinic owners can cancel downgrades');
  }

  const subDoc = await db.collection('subscriptions').doc(clinicId).get();
  const sub = subDoc.data();

  if (!sub?.pendingDowngrade) {
    throw new HttpsError('not-found', 'No pending downgrade to cancel');
  }

  const { stripeScheduleId, targetPlan } = sub.pendingDowngrade;

  // Undo the Stripe side
  if (stripeScheduleId) {
    // Paid→paid: release the subscription schedule (reverts to normal subscription)
    await stripe.subscriptionSchedules.release(stripeScheduleId);
  } else if (targetPlan === 'free' && sub.stripeSubscriptionId) {
    // Paid→free: un-set cancel_at_period_end
    await stripe.subscriptions.update(sub.stripeSubscriptionId, {
      cancel_at_period_end: false,
    });
  }

  // Clear Firestore
  await subDoc.ref.update({ pendingDowngrade: null });

  return { success: true };
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
