# DECISIONS.md — Design Decisions & Trade-offs

## Scenario 1 — Plan Upgrade

### Decision: Firestore updates happen only via webhook, never from the client

**Choice:** The client creates a Stripe Checkout session and opens the payment URL. After payment, Stripe fires a webhook (`customer.subscription.created` / `customer.subscription.updated`) which updates Firestore. The client never writes to the `subscriptions` collection directly.

**Why:** This is the only correct approach for billing systems. If we updated Firestore optimistically (before Stripe confirms payment), we'd have a window where the user sees a plan they haven't paid for. Worse, if payment fails, we'd need complex rollback logic. By making the webhook the single source of truth, Firestore always reflects what Stripe has actually processed.

**Trade-off:** There's a small delay (1-3 seconds) between payment completion and the UI updating. The user might briefly see the old plan after paying. This is acceptable — it's better than showing a plan the user hasn't actually paid for.

### Decision: Handle `customer.subscription.created` instead of `checkout.session.completed`

**Choice:** We listen for `customer.subscription.created` and `customer.subscription.updated` events rather than relying solely on `checkout.session.completed`.

**Why:** The Stripe API version (`2026-03-25.dahlia`) doesn't always fire `checkout.session.completed` via the CLI listener. The subscription lifecycle events (`created`, `updated`) are more reliable and contain all the data we need (price ID, status, period end). They also cover non-checkout subscription changes (e.g., upgrades via the Stripe dashboard).

**Trade-off:** `checkout.session.completed` carries session metadata (clinicId, plan) that we set ourselves, making the lookup trivial. With `customer.subscription.created`, we need to reverse-lookup the clinic by `stripeCustomerId`, then determine the plan by matching the price ID. This is slightly more complex but more robust.

### Decision: Lazy initialization of Stripe SDK in Cloud Functions

**Choice:** We use a `getStripe()` factory function instead of initializing the Stripe client at module scope.

**Why:** The Firebase Functions emulator runs a manifest generation step that imports all modules to discover function exports. During this step, environment variables (`.env`) aren't loaded yet. A top-level `new Stripe(process.env.STRIPE_SECRET_KEY!)` fails with "Neither apiKey nor config.authenticator provided". Lazy initialization defers the Stripe client creation to the first actual function invocation, when env vars are available.

**Trade-off:** Slightly more indirection in the code. Worth it for emulator compatibility.

### Decision: Stripe customer ID persistence and deduplication

**Choice:** When creating a Stripe customer for a clinic, we immediately persist the `stripeCustomerId` to Firestore and skip creation if one already exists (ignoring the seed placeholder `cus_test_REPLACE_ME`).

**Why:** Without this, repeated upgrade attempts would create duplicate Stripe customers for the same clinic. Each customer would have separate payment methods and subscription history, making billing management impossible.

### Decision: Plan determined by price ID reverse-lookup in webhook

**Choice:** In the webhook handler, we determine the plan by matching the subscription item's `price.id` against our known `PRICE_IDS` map, rather than relying on metadata.

**Why:** Metadata can be lost or not set (e.g., subscriptions created via the Stripe dashboard). The price ID is always present on the subscription object and is the definitive indicator of which plan the customer is on. This approach also naturally handles plan changes triggered outside our app.

**Trade-off:** We maintain a hardcoded `PRICE_IDS` map in both `checkout.ts` and `webhook.ts`. If price IDs change in Stripe, both need updating. This could be DRYed up into a shared config, but for clarity we keep them co-located with their usage.
