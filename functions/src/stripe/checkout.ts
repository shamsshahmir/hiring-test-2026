import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
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

const ADDON_PRICES: Record<string, number> = {
  extra_storage: 19,
  extra_seats: 49,
  advanced_analytics: 79,
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

  // Validate and apply discount code for base plan checkout
  let stripeCouponId: string | undefined;
  if (discountCode) {
    const discountSnap = await db
      .collection('discounts')
      .where('code', '==', discountCode)
      .limit(1)
      .get();

    if (discountSnap.empty) {
      throw new HttpsError('not-found', `Discount code "${discountCode}" not found`);
    }

    const discount = discountSnap.docs[0].data();
    const validUntil = discount.validUntil?.toDate?.() ?? new Date(0);

    if (validUntil <= new Date()) {
      throw new HttpsError('failed-precondition', `Discount code "${discountCode}" has expired`);
    }
    if (discount.usedCount >= discount.usageLimit) {
      throw new HttpsError('failed-precondition', `Discount code "${discountCode}" has reached its usage limit`);
    }
    if (!discount.appliesToBase) {
      throw new HttpsError('failed-precondition', `Discount "${discountCode}" does not apply to base plan pricing`);
    }

    // Create Stripe coupon
    const coupon = await getStripe().coupons.create({
      percent_off: discount.percentOff,
      duration: 'repeating',
      duration_in_months: 12,
      name: `${discountCode} - ${discount.percentOff}% off`,
    });
    stripeCouponId = coupon.id;

    // NOTE: Usage count is NOT incremented here. Checkout sessions can be abandoned.
    // The increment happens in the webhook (handleCheckoutCompleted) when payment succeeds.
    // The discount code is passed via session metadata so the webhook can find it.
  }

  const session = await getStripe().checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: PRICE_IDS[plan], quantity: 1 }],
    ...(stripeCouponId ? { discounts: [{ coupon: stripeCouponId }] } : {}),
    metadata: { clinicId, plan, ...(discountCode ? { discountCode } : {}) },
    success_url: 'clinicapp://billing?success=true',
    cancel_url: 'clinicapp://billing?canceled=true',
  });

  return { sessionId: session.id, url: session.url };
});

/**
 * Purchases an add-on for a clinic.
 *
 * Strategy: Validate → Stripe-first → Firestore-second with compensating rollback.
 *
 * Validates:
 *   - Caller is clinic owner
 *   - Clinic has an active paid subscription (not free, not grace_period)
 *   - Add-on isn't already active
 *   - Discount code (if provided) is valid, not expired, within usage limit,
 *     AND applies to this specific add-on type
 */
export const purchaseAddon = onCall(async (request) => {
  if (!request.auth)
    throw new HttpsError('unauthenticated', 'Must be signed in');

  const { clinicId, addonType, discountCode } = request.data as {
    clinicId: string;
    addonType: 'extra_storage' | 'extra_seats' | 'advanced_analytics';
    discountCode?: string;
  };

  const db = admin.firestore();
  const stripe = getStripe();
  const { ADDON_SEATS_BONUS } = await import('./planConfig');

  // --- PHASE 1: Validate everything before touching Stripe ---

  const userDoc = await db.collection('users').doc(request.auth.uid).get();
  const user = userDoc.data();
  if (!user || user.role !== 'owner' || user.clinicId !== clinicId) {
    throw new HttpsError('permission-denied', 'Only clinic owners can manage billing');
  }

  const subDoc = await db.collection('subscriptions').doc(clinicId).get();
  const sub = subDoc.data();
  if (!sub?.stripeSubscriptionId || sub.stripeSubscriptionId === 'sub_test_REPLACE_ME') {
    throw new HttpsError('failed-precondition', 'A paid subscription is required to add add-ons');
  }
  if (sub.plan === 'free') {
    throw new HttpsError('failed-precondition', 'Upgrade to a paid plan before adding add-ons');
  }
  if (sub.status === 'grace_period') {
    throw new HttpsError('failed-precondition', 'Cannot add add-ons while payment is past due');
  }

  const existingAddon = await db
    .collection('addons').doc(clinicId)
    .collection('items')
    .where('type', '==', addonType)
    .where('active', '==', true)
    .limit(1)
    .get();
  if (!existingAddon.empty) {
    throw new HttpsError('already-exists', 'This add-on is already active');
  }

  // Validate discount code if provided (read-only check — no writes yet)
  let discountRef: admin.firestore.DocumentReference | null = null;
  let discountData: admin.firestore.DocumentData | null = null;
  let stripeCouponId: string | undefined;

  if (discountCode) {
    const discountSnap = await db
      .collection('discounts')
      .where('code', '==', discountCode)
      .limit(1)
      .get();

    if (discountSnap.empty) {
      throw new HttpsError('not-found', `Discount code "${discountCode}" not found`);
    }

    discountRef = discountSnap.docs[0].ref;
    discountData = discountSnap.docs[0].data();

    const validUntil = discountData.validUntil?.toDate?.() ?? new Date(0);
    if (validUntil <= new Date()) {
      throw new HttpsError('failed-precondition', `Discount code "${discountCode}" has expired`);
    }
    if (discountData.usedCount >= discountData.usageLimit) {
      throw new HttpsError('failed-precondition', `Discount code "${discountCode}" has reached its usage limit`);
    }

    const appliesToThisAddon =
      discountData.appliesToAddons === 'all' ||
      (Array.isArray(discountData.appliesToAddons) && discountData.appliesToAddons.includes(addonType));

    if (!appliesToThisAddon) {
      throw new HttpsError(
        'failed-precondition',
        `Discount "${discountCode}" does not apply to ${addonType}.` +
        (discountData.appliesToBase ? ' This code only applies to base plan pricing.' : ''),
      );
    }

    // Create Stripe coupon
    const coupon = await stripe.coupons.create({
      percent_off: discountData.percentOff,
      duration: 'repeating',
      duration_in_months: 12,
      name: `${discountCode} - ${discountData.percentOff}% off`,
    });
    stripeCouponId = coupon.id;
  }

  // --- PHASE 2: Stripe-first — create subscription item ---
  const subscriptionItem = await stripe.subscriptionItems.create({
    subscription: sub.stripeSubscriptionId,
    price: PRICE_IDS[addonType],
    quantity: 1,
    ...(stripeCouponId ? { discounts: [{ coupon: stripeCouponId }] } : {}),
  });

  // --- PHASE 3: Firestore-second — write addon record + increment discount usage ---
  const addonRef = db
    .collection('addons').doc(clinicId)
    .collection('items').doc();

  try {
    await db.runTransaction(async (tx) => {
      // Re-check discount usage inside transaction to prevent concurrent over-use
      if (discountRef && discountData) {
        const freshDiscount = await tx.get(discountRef);
        const fresh = freshDiscount.data();
        if (fresh && fresh.usedCount >= fresh.usageLimit) {
          throw new Error('DISCOUNT_EXHAUSTED');
        }
        tx.update(discountRef, {
          usedCount: FieldValue.increment(1),
        });
      }

      tx.set(addonRef, {
        clinicId,
        type: addonType,
        price: ADDON_PRICES[addonType],
        active: true,
        stripeItemId: subscriptionItem.id,
        discountCode: discountCode ?? null,
      });

      const clinicRef = db.collection('clinics').doc(clinicId);

      // Extra Seats addon: increase seat max
      if (addonType === 'extra_seats') {
        tx.update(clinicRef, {
          addons: FieldValue.arrayUnion(addonRef.id),
          'seats.max': FieldValue.increment(ADDON_SEATS_BONUS),
        });
      } else {
        tx.update(clinicRef, {
          addons: FieldValue.arrayUnion(addonRef.id),
        });
      }
    });
  } catch (err: unknown) {
    // Compensating rollback: remove the Stripe subscription item
    console.error('Firestore write failed, rolling back Stripe subscription item:', err);
    try {
      await stripe.subscriptionItems.del(subscriptionItem.id, {
        proration_behavior: 'none',
      });
      if (stripeCouponId) {
        await stripe.coupons.del(stripeCouponId);
      }
    } catch (rollbackErr) {
      console.error('CRITICAL: Stripe rollback failed:', rollbackErr);
    }

    if (err instanceof Error && err.message === 'DISCOUNT_EXHAUSTED') {
      throw new HttpsError('failed-precondition', `Discount code "${discountCode}" has reached its usage limit`);
    }
    throw new HttpsError('internal', 'Failed to save add-on. No charges were made.');
  }

  return { addonId: addonRef.id, stripeItemId: subscriptionItem.id };
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
  } catch (err: unknown) {
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

    if (err instanceof Error && err.message === 'CONCURRENT_DOWNGRADE') {
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
 *
 * Defense in depth (Option A + B):
 *   1. Firestore transaction: deactivate seat, clear clinicId, decrement seats.used
 *   2. Revoke Firebase Auth refresh tokens (immediate, but tokens valid up to 1 hour)
 *   3. Firestore rules check seat.active on every protected operation (catches the 1-hour window)
 *
 * This combination ensures:
 *   - Immediate blocking for most operations (Firestore rules check active flag)
 *   - Token revocation forces re-auth within 1 hour (catches any cached-token edge cases)
 *   - No custom claims needed (simpler, no propagation delay)
 */
export const removeStaffMember = onCall(async (request) => {
  if (!request.auth)
    throw new HttpsError('unauthenticated', 'Must be signed in');

  const { clinicId, targetUserId } = request.data as {
    clinicId: string;
    targetUserId: string;
  };

  const db = admin.firestore();

  // Verify caller is owner of this clinic
  const callerDoc = await db.collection('users').doc(request.auth.uid).get();
  const caller = callerDoc.data();
  if (!caller || caller.role !== 'owner' || caller.clinicId !== clinicId) {
    throw new HttpsError('permission-denied', 'Only clinic owners can remove staff');
  }

  // Verify target is a staff member (not the owner) of this clinic
  const targetDoc = await db.collection('users').doc(targetUserId).get();
  const target = targetDoc.data();
  if (!target || target.clinicId !== clinicId) {
    throw new HttpsError('not-found', 'User is not a member of this clinic');
  }
  if (target.role === 'owner') {
    throw new HttpsError('failed-precondition', 'Cannot remove the clinic owner');
  }

  // Verify the seat exists and is active
  const seatRef = db.collection('seats').doc(clinicId).collection('members').doc(targetUserId);
  const seatDoc = await seatRef.get();
  if (!seatDoc.exists || !seatDoc.data()?.active) {
    throw new HttpsError('not-found', 'Staff member seat is not active');
  }

  // Phase 1: Atomic Firestore update
  await db.runTransaction(async (tx) => {
    const clinicRef = db.collection('clinics').doc(clinicId);
    const userRef = db.collection('users').doc(targetUserId);

    // Deactivate seat
    tx.update(seatRef, { active: false });

    // Clear user's clinic association and revert to patient role
    tx.update(userRef, {
      clinicId: null,
      role: 'patient',
    });

    // Decrement seat count
    tx.update(clinicRef, {
      'seats.used': FieldValue.increment(-1),
    });
  });

  // Phase 2: Revoke Firebase Auth refresh tokens
  // This invalidates ALL active sessions for the user within ~1 hour.
  // Combined with Firestore rules checking seat.active, access is blocked immediately.
  try {
    await admin.auth().revokeRefreshTokens(targetUserId);
  } catch (err) {
    // Token revocation failure is not critical — Firestore rules still block access
    console.error('Token revocation failed (Firestore rules still enforce):', err);
  }

  console.log(`Staff ${targetUserId} removed from clinic ${clinicId}, tokens revoked`);
  return { success: true };
});
