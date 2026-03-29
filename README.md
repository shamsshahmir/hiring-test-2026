# blackcode SA — Developer Hiring Test 2026

blackcode SA is a Swiss software agency building Metaesthetics — a SaaS platform for aesthetic medicine clinics — and AIOS Companion, an AI agent platform. We're a small, senior team and we're looking for a developer who can own complex systems, not just implement tickets.

---

## What this is

A half-built React Native app. Your job is to finish specific parts of it.

Estimated time: **8 hours**. No tricks. No gotchas. We picked a domain (clinic billing) that's genuinely complex but doesn't require domain expertise — it's logic all the way down.

The code compiles. The emulator runs. The seed populates realistic data. You're not starting from scratch, and you're not fixing someone else's mess — the scaffold is intentionally clean. Your job is to implement the hard parts we left open.

---

## The domain

A clinic management app. Three user types:

- **Owner** — runs the clinic, manages staff, controls billing
- **Staff** — works at the clinic, manages appointments
- **Patient** — books and views their own appointments

The billing system is the interesting part. Clinics subscribe to a base plan, buy add-ons on top, and can apply discount codes. The complexity comes from how these interact: a downgrade can conflict with active staff seats, a payment failure puts the clinic in a grace period, a discount might apply to the base plan but not to add-ons. These aren't edge cases — they're the normal operation of a real billing system.

---

## Stack

| Layer | Tech | Why |
|---|---|---|
| Mobile | React Native + Expo | Cross-platform, fast iteration, Expo Router handles navigation cleanly |
| Backend | Firebase (Firestore + Functions + Auth) | Real-time subscriptions, generous free tier for dev, emulator makes local dev fast |
| Payments | Stripe | Industry standard, excellent webhook tooling, test mode is solid |
| State | Zustand | Minimal boilerplate, works well with Firebase's real-time model |
| Language | TypeScript strict | Non-negotiable. If a type is `any`, it's a TODO. |

---

## Getting started

### Prerequisites

- Node 18+ (tested on Node 22)
- Firebase CLI: `npm install -g firebase-tools`
- Expo CLI: `npm install -g expo-cli`
- Stripe CLI: [Install from stripe.com/docs/stripe-cli](https://stripe.com/docs/stripe-cli) (needed for webhook testing)
- Android device or emulator (tested on physical Android device)

### Setup

```bash
# Clone and install
git clone <your-fork-url>
cd hiring-test-2026
npm install

# Install function dependencies
cd functions && npm install && cd ..

# Build Cloud Functions (required before first emulator start)
cd functions && npm run build && cd ..
```

### Environment

The `.env` file is pre-configured with Stripe test keys and emulator settings. Key settings:

```bash
# Emulator host — set to your machine's local IP for physical device testing
# Use 'localhost' for Android emulator, or your LAN IP (e.g., 192.168.x.x) for physical device
EXPO_PUBLIC_EMULATOR_HOST=192.168.100.21

# Already set to true for local development
EXPO_PUBLIC_USE_EMULATOR=true
```

**Physical device setup:** The app connects to Firebase emulators over your local network. Set `EXPO_PUBLIC_EMULATOR_HOST` to your machine's IP address (find with `ipconfig getifaddr en0` on macOS). Both the phone and computer must be on the same WiFi network.

The `firebase.json` is configured with `"host": "0.0.0.0"` on all emulator ports so they accept connections from the local network, not just localhost.

The `google-services.json` contains a valid-format dummy API key for the emulator. No real Firebase project is needed.

### Running

You need **3 terminals** (4 if testing webhooks):

```bash
# Terminal 1: Start Firebase emulators
npm run emulator

# Terminal 2: Seed test data (run after emulator is ready)
npm run seed

# Terminal 3: Start the app
npx expo run:android
# Or for development builds:
npx expo start

# Terminal 4 (optional): Forward Stripe webhooks for end-to-end testing
stripe listen --forward-to http://localhost:5001/clinic-test-local/us-central1/handleStripeWebhook
```

**Important:** The emulator persists data across restarts (via `--import/--export-on-exit`). To start fresh, delete the `emulator-data/` directory before starting the emulator.

**Important:** If you re-seed, clear existing auth data first (the seed script doesn't handle existing users):
```bash
curl -s -X DELETE "http://localhost:9099/emulator/v1/projects/clinic-test-local/accounts"
npm run seed
```

### Test accounts (all passwords: `test1234`)

| Account | Email | Role |
|---|---|---|
| Owner | `sophie.owner@test.com` | Clinic owner — manages billing, staff, subscriptions |
| Staff | `anna.staff@test.com` | Staff member |
| Staff | `marc.staff@test.com` | Staff member |
| Patient | `patient1@test.com` | Patient |
| Patient | `patient2@test.com` | Patient |

### Stripe test card

For Stripe Checkout payments: `4242 4242 4242 4242`, any future expiry, any CVC.

### Emulator UI

Access the Firebase Emulator UI at `http://localhost:4000` to inspect Firestore data, auth users, and function logs.

---

## What to implement

There are 6 scenarios. Each one has a `// TODO [CHALLENGE]:` comment in the relevant file pointing you at exactly where the implementation goes. You don't have to implement all 6 — depth matters more than breadth. Two scenarios done properly beats six scenarios half-done.

For **every decision you make**, write it down in a `DECISIONS.md` file at the repo root. We're not looking for perfect answers — we're looking for reasoning. If you queued the downgrade instead of blocking it, tell us why. If you picked token revocation over Firestore rule checks, tell us the trade-off you considered.

---

### Scenario 1 — Plan upgrade

User upgrades from Free → Pro mid-cycle.

- Stripe handles proration
- Firestore reflects new plan immediately on webhook confirmation (not before)
- New seat limit available immediately after webhook processes

**Where to look:** `src/services/stripe.ts` → `createCheckoutSession`, `functions/src/stripe/checkout.ts`, `functions/src/stripe/webhook.ts` → `handleCheckoutCompleted`

---

### Scenario 2 — Downgrade with seat conflict

Clinic on Premium (15 seats, 10 used) downgrades to Pro (5 seats).

- System detects: 10 active staff, only 5 seats allowed
- **You decide:** block the downgrade until staff are deactivated, OR queue it for end of billing period
- Firestore rules must enforce the seat limit regardless of UI state
- Document your decision in `DECISIONS.md`

**Where to look:** `src/services/stripe.ts` → `initiateDowngrade`, `functions/src/stripe/checkout.ts` → `initiateDowngrade`, `firestore.rules` → seats section

---

### Scenario 3 — Add-on purchase with discount interaction

Clinic purchases Extra Storage add-on. They have two discount codes active:
- `WELCOME20`: 20% off base plan **only** (does not apply to add-ons)
- `ADDONS15`: 15% off all add-ons (expired — see Scenario 5)

The discount logic must be enforced server-side. The client sends the code; the function validates what it applies to.

**Where to look:** `src/types/discount.ts` → `calculateDiscountedPrice`, `functions/src/stripe/checkout.ts` → `purchaseAddon`

---

### Scenario 4 — Payment failure

Stripe sends `invoice.payment_failed`.

- System enters a **grace period** (you decide how long — document it)
- During grace period: existing features stay, no new staff can be added
- After grace period ends: plan reverts to Free, excess staff seats deactivated
- Firestore rules must enforce the grace period state without needing UI changes

**Where to look:** `functions/src/stripe/webhook.ts` → `invoice.payment_failed` handler, `firestore.rules` → seats section

---

### Scenario 5 — Expired discount code

A discount has `validUntil` in the past.

- New subscribers: code rejected at checkout
- Existing subscribers who applied it: **you decide** — honor until renewal, or strip on next invoice? Document it.
- The UI must make the expiry state visible (there's a `DiscountTag` component that partially handles this)

**Where to look:** `src/types/discount.ts` → `isDiscountValid`, `functions/src/stripe/checkout.ts` → discount validation, `src/components/DiscountTag.tsx`

---

### Scenario 6 — Session invalidation on role change

Staff member is removed by owner. Their Firebase Auth session is still active on their device.

The system must block their access without requiring them to log out manually.

- Option A: `admin.auth().revokeRefreshTokens(uid)` — server-side token revocation
- Option B: Firestore rule check on every protected operation (check `active` flag in seats collection)
- Option C: Custom claims with a `disabled` field, checked in rules

Pick one. Implement it. Document the trade-offs.

**Where to look:** `src/services/auth.ts` → `revokeUserSession`, `functions/src/stripe/checkout.ts` → `removeStaffMember`, `firestore.rules` → seats section

---

## Evaluation criteria

| Area | What we're looking for |
|---|---|
| Data model | Can it represent all 6 scenarios without hacking? Is the schema clean? |
| Firestore rules | Are they actually enforced server-side? Do they hold under edge cases? |
| Stripe integration | Is the webhook handler real? Is plan gating server-side (not just UI)? |
| Discount logic | Is the interaction model correct and extensible? |
| Design decisions | Are they documented? Are the trade-offs understood? |
| React Native quality | TypeScript strict throughout, clean components, no magic strings |
| Code quality | Readable, structured, consistent — someone else can work in it |
| README | Can we run it in under 5 minutes? |

We're a small team. Code that's clear and opinionated is more valuable to us than code that's clever and fragile.

---

## Implementation summary

All 6 scenarios are implemented. See `DECISIONS.md` for 37 documented design decisions with trade-off analysis.

### Scenario 1 — Plan Upgrade
- Client creates Stripe Checkout session via Cloud Function → user pays → webhook updates Firestore
- Handles `customer.subscription.created` and `customer.subscription.updated` events
- Discount codes validated server-side, usage deferred to webhook (handles abandoned checkouts)

### Scenario 2 — Downgrade with Seat Conflict
- **Queued approach:** seat conflict → downgrade scheduled for end of billing period
- Stripe Subscription Schedules for paid→paid, `cancel_at_period_end` for paid→free
- Stripe-first, Firestore-second with compensating rollback on failure
- `pendingDowngrade` stored with `stripeScheduleId` for cancellability
- Firestore rules block new seats during pending downgrade
- Auto-deactivation of excess seats when subscription is deleted (owner kept, earliest staff kept)
- `cancelPendingDowngrade` Cloud Function to undo a queued downgrade

### Scenario 3 — Add-on Purchase with Discounts
- Server-side discount validation: checks existence, expiry, usage limit, and applicability per item type
- WELCOME20 (base only) correctly rejected for add-on purchases with clear error message
- ADDONS15 (expired) rejected with expiry error
- Stripe-first with compensating rollback (deletes subscription item + coupon on Firestore failure)
- Discount usage re-checked inside Firestore transaction (prevents concurrent over-use)
- Extra Seats add-on increments `clinic.seats.max`; webhook accounts for this when syncing

### Scenario 4 — Payment Failure & Grace Period
- 7-day grace period matching Stripe's Smart Retries window
- `clinicIsActive` (allows reads during grace) vs `clinicCanExpand` (blocks new seats/add-ons)
- No cron job needed — Stripe's subscription cancellation triggers cleanup
- UI shows grace period warning with end date

### Scenario 5 — Expired Discount Code
- Expired codes rejected server-side for all new purchases
- Existing subscribers honored until Stripe coupon's `duration_in_months` expires naturally
- `DiscountTag` shows Active/Expired/Exhausted badges with remaining uses and applicability

### Scenario 6 — Session Invalidation
- **Combined approach (Option A + B):** token revocation + Firestore rule enforcement
- `removeStaffMember` Cloud Function: atomic transaction (deactivate seat, clear clinicId, revert to patient, decrement seats.used) + `revokeRefreshTokens`
- Firestore rules check `isSeatActive()` on appointments — immediate blocking, no 1-hour token window
- Token revocation failure is non-critical (rules are primary defense)

### Architecture patterns used throughout
- **Stripe-first, Firestore-second** with compensating rollbacks
- **Firestore transactions** with re-checks for concurrent request safety
- **Zero `any` types** — TypeScript strict throughout
- **Server-side enforcement** for all billing logic (Firestore rules + Cloud Functions)
- **Defense in depth** for security (rules + token revocation)

---

## How to submit

1. Fork this repo
2. Implement what you can — depth over breadth
3. Write your `DECISIONS.md` — this matters as much as the code
4. Send your fork link to **andrea@blackcode.ch**

We read every submission. If your thinking is interesting, we'll be in touch — even if the implementation isn't complete.
