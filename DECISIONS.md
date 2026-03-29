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

---

## Scenario 2 — Downgrade with Seat Conflict

### Decision: Queue the downgrade instead of blocking it

**Choice:** When a clinic has more active staff than the target plan allows (e.g., 10 staff on Premium, downgrading to Pro with 5 seats), we queue the downgrade for end of billing period rather than blocking it outright.

**Why:**
1. **The clinic paid for Premium.** They're entitled to use 15 seats until the period they paid for ends. Blocking the downgrade forces them to deactivate staff immediately to even initiate the process — punitive UX.
2. **Stripe natively supports scheduled changes.** Using `cancel_at_period_end: true` aligns with Stripe's mental model for end-of-period transitions.
3. **Time to resolve.** The owner gets days/weeks to decide which staff to deactivate, rather than being forced into an immediate decision under time pressure.
4. **The type system anticipated this.** `DowngradeResult` already has `strategy: 'queued'` and `effectiveDate` fields, confirming the codebase was designed with queuing in mind.

**Trade-off:** The queued approach is more complex to implement — we need a `pendingDowngrade` field on the subscription doc, Firestore rules that enforce the pending state (block new seat additions), and webhook logic to clear the flag when the transition completes. The blocking approach would be simpler (just return an error), but worse for the user.

**What if the owner doesn't deactivate staff by the deadline?** At period end, Stripe cancels the subscription and fires the webhook. At that point, the system should auto-deactivate excess seats (keeping the owner + most recently active staff). This enforcement happens server-side in the webhook handler, not via Firestore rules.

### Decision: Immediate path for no-conflict downgrades

**Choice:** If active seats <= target plan seats, the downgrade processes immediately via `stripe.subscriptions.update()` with proration.

**Why:** No reason to delay when there's no conflict. The user gets immediate feedback, and Stripe prorates the billing automatically.

### Decision: Firestore rules enforce pending downgrade state

**Choice:** When `pendingDowngrade` is set on the subscription doc, Firestore rules block new seat activations/creations. Seat deactivation (setting `active: false`) is always allowed.

**Why:** The rules must enforce this server-side because the client cannot be trusted. Without rule enforcement, an owner could queue a downgrade and then add more staff during the waiting period, making the conflict worse. By blocking new seats in rules, the only path forward is to resolve the conflict.

**Trade-off:** The rules become more complex (multiple `allow update` clauses with different conditions). But this is the correct place for enforcement — the alternative (only checking in Cloud Functions) would leave a gap where direct Firestore writes could bypass the check.

### Decision: Active seat count from subcollection, not clinic.seats.used

**Choice:** The Cloud Function counts active seats by querying `seats/{clinicId}/members` where `active == true`, rather than reading `clinic.seats.used`.

**Why:** `clinic.seats.used` is a denormalized counter that could be stale if a previous operation failed mid-way. The subcollection query is the authoritative source. For a billing decision with financial implications, we must use the authoritative count.

### Decision: Stripe Subscription Schedules for paid→paid downgrades

**Choice:** For paid-to-paid downgrades (e.g., Premium → Pro), we use Stripe Subscription Schedules (`subscriptionSchedules.create` with `from_subscription`). For paid-to-free downgrades, we use `cancel_at_period_end: true`.

**Why:** `cancel_at_period_end` deletes the subscription at period end. For paid→paid, we don't want deletion — we want a price swap that keeps the subscription alive with continuous billing. Subscription Schedules handle this atomically: the current phase keeps the old price, and a new phase starts at period end with the new price. No interruption, no gap in service.

**Trade-off:** Subscription Schedules are a more complex Stripe API surface. The alternative — canceling and re-creating a new subscription — creates a gap where the customer has no active subscription, which can cause webhook race conditions and brief access loss. The schedule approach avoids this entirely.

### Decision: Auto-deactivate excess seats on subscription deletion

**Choice:** When a subscription is deleted (end of period after queued downgrade, or cancellation), the webhook handler automatically deactivates excess staff seats. It keeps the owner's seat + the earliest-joined members up to the free plan limit.

**Why:** If we didn't auto-deactivate, the clinic would be in a broken state — more active seats than the plan allows, with Firestore rules blocking all seat operations. The owner couldn't even log in to fix it. Auto-deactivation with a clear priority (owner first, then by join date) is predictable and fair.

**Trade-off:** Auto-deactivation could surprise staff members who suddenly lose access. In production, we'd send email notifications before and after deactivation. For this implementation, the deactivation is immediate and silent. The ordering (keep earliest, deactivate latest) was chosen because earlier members are likely more integral to the clinic.

### Decision: Stripe-first, Firestore-second with compensating rollback

**Choice:** The downgrade flow creates the Stripe schedule/cancellation FIRST, then writes `pendingDowngrade` to Firestore. If the Firestore write fails, we roll back the Stripe change (release the schedule or un-set `cancel_at_period_end`).

**Why:** The alternative (Firestore first, Stripe second) creates a worse failure mode: if Firestore succeeds but Stripe fails, the user sees a pending downgrade in the UI that will never execute on Stripe's side. They'd be stuck with no way to resolve it. With Stripe-first, if Firestore fails, we undo the Stripe change — leaving the system in its original clean state. The user can simply retry.

**Trade-off:** There's a brief window (milliseconds) where Stripe has the schedule but Firestore doesn't know about it. If the Cloud Function crashes between the Stripe call and Firestore write, we'd have an orphaned schedule. In production, a reconciliation job that compares Stripe subscription states with Firestore would catch this. For this implementation, the compensating rollback handles the common failure case (Firestore transaction rejection).

### Decision: Firestore transaction with re-check for concurrent downgrades

**Choice:** Inside the Firestore transaction, we re-read the subscription and check for `pendingDowngrade` again. This catches the case where another request created a downgrade between our initial read and the Stripe call.

**Why:** The initial `pendingDowngrade` check (before the Stripe call) is an optimistic check to fail fast. But since we can't hold a Firestore lock while calling Stripe (which takes 100-500ms), another request could slip through. The transaction re-check is the pessimistic guarantee.

### Decision: Store `stripeScheduleId` in Firestore for cancellability

**Choice:** The `pendingDowngrade` field includes `stripeScheduleId` (the Stripe Subscription Schedule ID for paid→paid downgrades, null for paid→free).

**Why:** Without this, a pending downgrade is irreversible — the owner can't change their mind. By storing the schedule ID, the `cancelPendingDowngrade` Cloud Function can release the schedule (`subscriptionSchedules.release`) or un-set `cancel_at_period_end`, then clear Firestore. This is essential for a production billing system — billing decisions should always be reversible within the billing period.

### Decision: `cancelPendingDowngrade` as a separate Cloud Function

**Choice:** Cancelling a pending downgrade is a separate Cloud Function, not a parameter on `initiateDowngrade`.

**Why:** Separation of concerns. The downgrade initiation flow is already complex (validation, Stripe schedule creation, compensating rollback). Mixing in cancellation logic would make it harder to reason about. A separate function has a clear contract: if `pendingDowngrade` exists, undo the Stripe side and clear Firestore.

### Decision: Webhook preserves `pendingDowngrade` until target plan is reached

**Choice:** The `handleSubscriptionUpdated` webhook handler only clears `pendingDowngrade` when the subscription's plan actually transitions to the `pendingDowngrade.targetPlan`. Otherwise, it preserves the field.

**Why:** When a Subscription Schedule is created (or `cancel_at_period_end` is set), Stripe immediately fires `customer.subscription.updated` events — even though the plan hasn't changed yet. Our initial implementation blindly set `pendingDowngrade: null` on every subscription update, which wiped out the pending state milliseconds after we wrote it. The fix checks whether the new plan matches the pending target before clearing.

**Trade-off:** If a user somehow gets into a state where `pendingDowngrade.targetPlan` never matches an incoming plan (e.g., the schedule is externally modified in Stripe), the field would never be cleared automatically. The `cancelPendingDowngrade` function serves as the manual escape hatch for this edge case.
