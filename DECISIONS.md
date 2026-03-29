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

---

## Scenario 3 — Add-on Purchase with Discount Interaction

### Decision: All discount validation happens server-side in Cloud Functions

**Choice:** The client sends the discount code as a plain string. The Cloud Function validates everything: existence, expiry, usage limit, and applicability to the item type. The client never evaluates discount rules.

**Why:** Discount codes have financial impact. If validation ran client-side, a modified client could bypass expiry checks or apply base-plan-only discounts to add-ons. Server-side validation is the only safe approach. The client-side `calculateDiscountedPrice` function exists for UI display purposes only (showing estimated prices) — it's never trusted for actual billing.

### Decision: Discount applicability is type-checked, not just boolean

**Choice:** A discount has `appliesToBase: boolean` and `appliesToAddons: AddonType[] | 'all'`. When purchasing an add-on, the function checks whether the specific add-on type is in the `appliesToAddons` list. A discount with `appliesToBase: true, appliesToAddons: []` is explicitly rejected for add-on purchases with a clear error message explaining it only applies to the base plan.

**Why:** The WELCOME20 discount (20% off base plan only) must NOT accidentally apply to add-on purchases. The type system makes this explicit — `appliesToAddons: []` means "no add-ons". The error message tells the user exactly why their code was rejected, reducing support tickets.

### Decision: Expired discounts are rejected for new purchases, honored for existing subscribers

**Choice:** If `validUntil < now`, the discount is rejected for any new purchase (upgrade or add-on). However, existing subscribers who applied the discount when it was valid keep their discounted rate until their subscription renews or the Stripe coupon's `duration_in_months` expires naturally.

**Why:** Stripping a discount mid-cycle from an existing subscriber is legally questionable (they entered a contract at the discounted rate) and creates bad UX (surprise price increase). Letting Stripe's coupon duration handle the natural expiry is cleaner — when the coupon's 12-month period ends, the full price applies automatically. No server-side intervention needed.

**Trade-off:** A subscriber who applied an add-on discount 11 months ago still gets 1 more month of discount even though the code expired. This is acceptable — the coupon duration is the contractual term, not the code's `validUntil` date.

### Decision: Stripe coupons created per-use, not reused

**Choice:** Each time a valid discount code is applied, we create a new Stripe coupon via `stripe.coupons.create()` rather than looking up an existing one.

**Why:** Stripe coupons are immutable — you can't change their percentage after creation. If we reused coupons, we'd need a mapping table between our discount codes and Stripe coupon IDs. Creating per-use is simpler and avoids stale coupon references. Stripe handles coupon deduplication internally if needed.

**Trade-off:** This creates many Stripe coupon objects over time. In production, we'd periodically clean up unused coupons via the Stripe API. For this implementation, the volume is negligible.

### Decision: Stripe-first, Firestore-second with compensating rollback (same pattern as Scenario 2)

**Choice:** The add-on purchase creates the Stripe subscription item FIRST, then writes the Firestore addon record + increments discount usage in a single transaction. If Firestore fails, we delete the Stripe subscription item and coupon as compensating rollback.

**Why:** Same reasoning as Scenario 2. Stripe-first means if Firestore fails, we undo the charge — the user is never billed for something that isn't recorded. The alternative (Firestore-first) would leave a record of an add-on with no corresponding Stripe billing.

### Decision: Discount usage count checked inside Firestore transaction

**Choice:** The discount usage limit is re-checked inside the Firestore transaction (after the Stripe call), not just during the initial validation pass. The increment also happens inside the transaction.

**Why:** Two concurrent requests could both pass the initial usage check (before Stripe calls), then both succeed with Stripe. The transaction re-check is the pessimistic guarantee — only one will succeed in incrementing past the limit. The losing request gets rolled back (Stripe item deleted).

### Decision: Extra Seats add-on updates clinic.seats.max

**Choice:** When the `extra_seats` add-on is purchased, the Firestore transaction also increments `clinic.seats.max` by `ADDON_SEATS_BONUS` (5). Other add-ons don't affect seat limits.

**Why:** The Extra Seats pack's purpose is to increase capacity. Without updating `seats.max`, the Firestore rules would still block new staff additions at the plan's base limit. The increment is atomic within the same transaction as the addon record write.

### Decision: Grace period blocks add-on purchases

**Choice:** A clinic in `grace_period` status cannot purchase add-ons. The Cloud Function rejects with a clear error.

**Why:** During grace period, the clinic's existing payment method has failed. Adding more billable items to a subscription with a failing payment method is counterproductive — Stripe would immediately try to charge the new item and fail again. The owner should resolve the payment issue first.

### Decision: Discount usage deferred to webhook for checkout sessions

**Choice:** When a discount code is used during plan upgrade (checkout session), the `usedCount` is NOT incremented when the session is created. Instead, the discount code is stored in the session's metadata, and the webhook handler (`handleCheckoutCompleted`) increments the count when payment actually succeeds.

**Why:** Checkout sessions can be abandoned — the user creates a session, sees the Stripe payment page, and closes the browser. If we incremented on session creation, abandoned sessions would consume usage slots permanently. By deferring to the webhook, we only count successful payments.

**Trade-off:** There's a brief window where concurrent requests could both create sessions with the same near-limit discount code (both pass the usage check, neither has incremented yet). In practice this is rare and the worst case is one extra use of a discount code. The alternative — a distributed lock across the session creation and eventual webhook — adds significant complexity for a negligible risk.

**Note:** This differs from the `purchaseAddon` flow where payment is synchronous (Stripe subscription item is created immediately). There, we can safely increment in the same Firestore transaction because we know the Stripe charge succeeded.

### Decision: Add-ons deactivated on subscription deletion

**Choice:** When `handleSubscriptionDeleted` fires (downgrade to free or cancellation), all active add-ons are deactivated in the same transaction that reverts the plan.

**Why:** A free plan cannot have add-ons. If we left add-ons active after reverting to free, the Firestore data would be inconsistent — the UI would show active add-ons on a plan that doesn't support them, and Stripe would have no corresponding billing items. Deactivating atomically in the same transaction prevents any inconsistent window.

### Decision: Webhook accounts for Extra Seats add-ons when setting seats.max

**Choice:** The `handleSubscriptionUpdated` webhook calculates `seats.max` as `planConfig.seats + (extraSeatsCount * ADDON_SEATS_BONUS)` by counting `extra_seats` price items on the Stripe subscription, rather than hardcoding `planConfig.seats`.

**Why:** Adding a subscription item (add-on purchase) triggers `customer.subscription.updated`. If the webhook blindly set `seats.max = planConfig.seats`, it would overwrite the Extra Seats bonus that was just applied by the `purchaseAddon` function. By reading the actual subscription items from Stripe, the webhook always reflects the true seat entitlement.

**Trade-off:** The webhook now depends on recognizing the Extra Seats price ID. If the price ID changes in Stripe, the webhook would under-count seats. This is mitigated by the same `PRICE_IDS` map used throughout the codebase.

---

## Scenario 4 — Payment Failure & Grace Period

### Decision: 7-day grace period matching Stripe's Smart Retries window

**Choice:** Grace period is 7 days from the first `invoice.payment_failed` event.

**Why:** Stripe's Smart Retries automatically retry failed payments over ~7 days using ML to pick optimal retry times. Setting our grace period to match means: by the time our grace period ends, Stripe has either recovered the payment (triggering `payment_succeeded` → status restored) or given up and canceled the subscription (triggering `subscription.deleted` → revert to free). There's no gap where we'd need to manually cancel.

**Trade-off:** 7 days is generous. Some systems use 3 days. But shorter grace periods risk canceling subscriptions that Stripe would have recovered via Smart Retries, leading to unnecessary churn and re-subscription friction.

### Decision: Grace period only entered from active status

**Choice:** The `handlePaymentFailed` handler only transitions from `active` → `grace_period`. If the subscription is already in `grace_period` (repeated failures), it doesn't re-enter or extend the grace.

**Why:** Extending the grace period on every retry failure would create an indefinite grace state. The 7-day window is absolute from the first failure. Stripe's own retry logic runs within this window. If all retries fail, Stripe cancels the subscription, which triggers our `handleSubscriptionDeleted` cleanup.

### Decision: `clinicCanExpand` vs `clinicIsActive` in Firestore rules

**Choice:** Two separate helper functions in Firestore rules:
- `clinicIsActive()` — returns true for `active` OR `grace_period` (used for read access, existing features)
- `clinicCanExpand()` — returns true for `active` ONLY (used for seat creation, add-on purchases)

**Why:** During grace period, the clinic should retain access to existing features (reading data, using appointments, etc.) but cannot expand (no new staff, no new add-ons). A single boolean couldn't express this distinction. The two functions make the intent clear in the rules.

### Decision: No manual grace period expiry enforcement needed

**Choice:** We don't implement a scheduled Cloud Function to check grace period expiry. Stripe handles it.

**Why:** When Stripe gives up retrying, it cancels the subscription, which fires `customer.subscription.deleted`. Our existing `handleSubscriptionDeleted` handler already reverts the plan to free and deactivates excess seats. Adding a cron job would be redundant and could race with Stripe's own cancellation event.

---

## Scenario 5 — Expired Discount Code

### Decision: Expired discounts honored for existing subscribers until Stripe coupon expires

**Choice:** When a discount code expires (`validUntil < now`), it is rejected for all new purchases. However, existing subscribers who applied the discount when it was valid keep their discounted rate — the Stripe coupon (`duration: 'repeating', duration_in_months: 12`) manages the natural expiry.

**Why:** Stripping a discount mid-cycle would be a surprise price increase. The subscriber entered a contract at the discounted rate. The Stripe coupon's `duration_in_months` is the contractual term — when it expires, the full price applies automatically on the next invoice. No server-side intervention or cron job needed.

**Trade-off:** A subscriber could enjoy up to 12 months of discount even if the code expired after 1 month. This is by design — the code's `validUntil` controls who can apply it, while the coupon's duration controls how long it lasts. These are independent concerns.

### Decision: DiscountTag shows clear expired/exhausted state with context

**Choice:** The `DiscountTag` component shows:
- Active discounts: green badge, validity date, remaining uses
- Expired discounts: red "Expired" badge, expiry date, note that existing subscribers are honored
- Exhausted discounts: red "Exhausted" badge, usage count

**Why:** The billing screen should make discount states unambiguous. An owner seeing "ADDONS15 — Expired" with the note "existing subscriptions with this discount are honored until renewal" knows exactly what's happening. No support ticket needed.

---

## Scenario 6 — Session Invalidation on Staff Removal

### Decision: Combined approach — Option A (token revocation) + Option B (Firestore rules)

**Choice:** When the owner removes a staff member:
1. Firestore transaction atomically: deactivate seat (`active: false`), clear `clinicId`, revert role to `patient`, decrement `seats.used`
2. Revoke Firebase Auth refresh tokens via `admin.auth().revokeRefreshTokens(uid)`
3. Firestore rules check `isSeatActive()` on every protected operation (appointments read/write)

**Why:** Neither approach alone is sufficient:
- **Option A alone (token revocation):** Firebase Auth tokens are valid for up to 1 hour after revocation. During that window, the removed staff member can still read/write Firestore if rules don't check the seat status.
- **Option B alone (Firestore rules):** Blocks Firestore operations immediately, but the user's client-side auth state still shows them as logged in. They'd see confusing permission errors rather than being cleanly logged out.
- **Combined:** Firestore rules provide immediate blocking (within milliseconds of the transaction). Token revocation forces a clean logout within 1 hour. The user experience degrades gracefully — first they lose data access, then the session expires.

**Trade-off:** The combined approach requires maintaining the `isSeatActive()` check in Firestore rules for every protected collection, adding read operations (Firestore document reads for the seat check). In a high-traffic system, this adds latency. For a clinic app with moderate traffic, the extra read is negligible.

### Decision: Option C (custom claims) rejected

**Choice:** We did not use custom claims with a `disabled` flag.

**Why:** Custom claims have a propagation delay — after calling `admin.auth().setCustomUserClaims()`, the client must refresh their ID token to pick up the new claims. This can take up to 1 hour (same as token revocation) and requires the client to cooperate by calling `getIdToken(true)`. Firestore rules checking custom claims would be stale until propagation completes. The seat-based approach gives us immediate enforcement without propagation delays.

### Decision: Token revocation failure is non-critical

**Choice:** If `admin.auth().revokeRefreshTokens()` fails, the error is logged but the function still succeeds.

**Why:** The Firestore transaction (Phase 1) is the critical operation — it immediately blocks access via rules. Token revocation is a secondary defense. If it fails (e.g., auth emulator doesn't support it, network issue), the user's seat is still deactivated in Firestore, so rules block them. The token will eventually expire naturally (1 hour max).

### Decision: Removed staff reverted to patient role, not deleted

**Choice:** When a staff member is removed, their user document is updated to `role: 'patient'`, `clinicId: null`. The user account is not deleted.

**Why:** The user might be a patient at the same clinic or join another clinic later. Deleting their account would destroy their appointment history and require re-registration. Reverting to patient preserves their data while revoking clinic access.
