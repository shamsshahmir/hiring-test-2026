import { onRequest } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { Timestamp } from 'firebase-admin/firestore';
import Stripe from 'stripe';

let _stripe: Stripe;
function getStripe() {
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  return _stripe;
}

const GRACE_PERIOD_DAYS = 7; // Document: chosen to match Stripe's own retry window

/**
 * Stripe webhook handler.
 * All billing state in Firestore is written here — never from the client.
 *
 * Events handled:
 *   - checkout.session.completed  → activate subscription
 *   - customer.subscription.updated → sync plan changes
 *   - invoice.payment_succeeded   → reset grace period, restore status
 *   - invoice.payment_failed      → enter grace period (Scenario 4)
 *   - customer.subscription.deleted → cancel subscription, revert to Free
 */
export const handleStripeWebhook = onRequest(async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;

  let event: Stripe.Event;

  try {
    event = getStripe().webhooks.constructEvent(req.rawBody, sig!, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err);
    res.status(400).send('Webhook Error');
    return;
  }

  const db = admin.firestore();

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        await handleCheckoutCompleted(db, session);
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        await handleSubscriptionUpdated(db, sub);
        break;
      }

      case 'invoice.paid':
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice;
        await handlePaymentSucceeded(db, invoice);
        break;
      }

      case 'invoice.payment_failed': {
        // TODO [CHALLENGE]: Implement Scenario 4 — payment failure → grace period.
        const invoice = event.data.object as Stripe.Invoice;
        console.log('TODO [CHALLENGE]: Handle payment failure for invoice', invoice.id);
        break;
      }

      case 'customer.subscription.deleted': {
        // TODO [CHALLENGE]: Handle subscription cancellation.
        const sub = event.data.object as Stripe.Subscription;
        console.log('TODO [CHALLENGE]: Handle subscription deleted for', sub.id);
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).send('Internal error');
  }
});

async function handleCheckoutCompleted(
  db: admin.firestore.Firestore,
  session: Stripe.Checkout.Session,
): Promise<void> {
  const clinicId = session.metadata?.clinicId;
  const plan = session.metadata?.plan as 'pro' | 'premium' | 'vip';

  if (!clinicId || !plan) {
    throw new Error('Missing clinicId or plan in session metadata');
  }

  const { PLAN_CONFIG_SERVER } = await import('./planConfig');
  const planConfig = PLAN_CONFIG_SERVER[plan];

  await db.runTransaction(async (tx) => {
    const subRef = db.collection('subscriptions').doc(clinicId);
    const clinicRef = db.collection('clinics').doc(clinicId);

    tx.set(subRef, {
      clinicId,
      plan,
      status: 'active',
      stripeCustomerId: session.customer,
      stripeSubscriptionId: session.subscription,
      currentPeriodEnd: Timestamp.fromDate(
        new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      ),
      gracePeriodEnd: null,
    }, { merge: true });

    tx.update(clinicRef, {
      plan,
      'seats.max': planConfig.seats,
    });
  });
}

async function handleSubscriptionUpdated(
  db: admin.firestore.Firestore,
  stripeSubscription: Stripe.Subscription,
): Promise<void> {
  // Try finding by subscription ID first, then by customer ID (for new subscriptions)
  let snap = await db
    .collection('subscriptions')
    .where('stripeSubscriptionId', '==', stripeSubscription.id)
    .limit(1)
    .get();

  if (snap.empty) {
    const customerId = typeof stripeSubscription.customer === 'string'
      ? stripeSubscription.customer
      : stripeSubscription.customer?.id;
    if (customerId) {
      snap = await db
        .collection('subscriptions')
        .where('stripeCustomerId', '==', customerId)
        .limit(1)
        .get();
    }
  }

  if (snap.empty) {
    console.warn('No clinic found for subscription', stripeSubscription.id);
    return;
  }

  const subDoc = snap.docs[0];
  const clinicId = subDoc.id;

  // Reverse-lookup: find which plan matches the price ID on the subscription
  const PRICE_IDS: Record<string, string> = {
    pro: 'price_1TFNdsKE5ra7Hrk1xtgF9wZ9',
    premium: 'price_1TFNg2KE5ra7Hrk1gDnw2G5u',
    vip: 'price_1TFNgrKE5ra7Hrk1vcprH34w',
  };
  const priceToPlan = Object.fromEntries(
    Object.entries(PRICE_IDS).map(([plan, priceId]) => [priceId, plan]),
  );

  const planItem = stripeSubscription.items.data.find(
    (item) => priceToPlan[item.price.id],
  );

  if (!planItem) {
    console.warn('No recognizable plan price in subscription items for clinic', clinicId);
    return;
  }

  const newPlan = priceToPlan[planItem.price.id] as 'pro' | 'premium' | 'vip';
  const { PLAN_CONFIG_SERVER } = await import('./planConfig');
  const planConfig = PLAN_CONFIG_SERVER[newPlan];

  await db.runTransaction(async (tx) => {
    const subRef = db.collection('subscriptions').doc(clinicId);
    const clinicRef = db.collection('clinics').doc(clinicId);

    // current_period_end can be seconds (number) or already a Date depending on Stripe API version
    const periodEnd = stripeSubscription.current_period_end;
    const periodEndDate = typeof periodEnd === 'number'
      ? new Date(periodEnd > 1e12 ? periodEnd : periodEnd * 1000)
      : new Date();

    tx.update(subRef, {
      plan: newPlan,
      status: stripeSubscription.status === 'active' ? 'active' : subDoc.data()?.status,
      stripeSubscriptionId: stripeSubscription.id,
      currentPeriodEnd: Timestamp.fromDate(periodEndDate),
    });

    tx.update(clinicRef, {
      plan: newPlan,
      'seats.max': planConfig.seats,
    });
  });

  console.log(`Subscription updated for clinic ${clinicId}: plan=${newPlan}, seats=${planConfig.seats}`);
}

async function handlePaymentSucceeded(
  db: admin.firestore.Firestore,
  invoice: Stripe.Invoice,
): Promise<void> {
  if (!invoice.customer) return;

  const snap = await db
    .collection('subscriptions')
    .where('stripeCustomerId', '==', invoice.customer)
    .limit(1)
    .get();

  if (snap.empty) return;

  await snap.docs[0].ref.update({
    status: 'active',
    gracePeriodEnd: null,
  });
}
