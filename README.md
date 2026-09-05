# RecoverAI

**Autonomous, Deterministic AI Revenue Recovery Engine for Indian UPI & Card Payments**

RecoverAI is a payment-failure recovery engine built for the Indian payments ecosystem (UPI, RBI e-mandates, debit/credit cards, netbanking). It couples multi-model LLM **advisory** reasoning (Google Gemini → Anthropic Claude → OpenAI) with an authoritative **Deterministic Policy Engine** that holds sole decision authority and enforces retry caps, stopping rules, and Indian regulatory compliance (TRAI commercial-communication windows, RBI additional-factor authentication for recurring mandates).

The design thesis is narrow and deliberate: **an LLM is useful for reading context, and unfit to hold authority over money.** Every recommendation is advisory; a deterministic kernel decides; the ledger records both, including the disagreement.

> **Track 03 bar:** *"Don't just identify the problem. Show measured money recovered across a batch, with compliant escalation, stopping rules, and an audit trail."* Sections 2 and 3 answer each clause with reconciled numbers and an explicit statement of what is proven and what is not.

---

## 1. System Architecture

```
                       ┌──────────────────────────────────────────────┐
                       │           INCOMING PAYMENT EVENT             │
                       │   (Razorpay Webhook / Checkout Drop-off)     │
                       └──────────────────────┬───────────────────────┘
                                              │
                                              ▼
                       ┌──────────────────────────────────────────────┐
                       │             SECURITY & INGESTION             │
                       │  • HMAC-SHA256 Signature Verification        │
                       │  • eventId Deduplication / Idempotency       │
                       │  • Terminal-State Conflict Guards            │
                       └──────────────────────┬───────────────────────┘
                                              │
                                              ▼
                       ┌──────────────────────────────────────────────┐
                       │           AI REASONING LAYER (ADVISORY)      │
                       │   Multi-Model Chain: Gemini → Claude → OpenAI│
                       │   Context: Failure code, tier, history, hour │
                       │   NON-FATAL: outage never blocks recovery    │
                       └──────────────────────┬───────────────────────┘
                                              │
                                     Advisory Recommendation
                                        (may be discarded)
                                              │
                                              ▼
                       ┌──────────────────────────────────────────────┐
                       │      DETERMINISTIC POLICY ENGINE (AUTHORITY) │
                       │  • Single Source of Truth / Hard Rules Kernel│
                       │  • TRAI Nudge Window Guard (10:00-21:00 IST) │
                       │  • RBI AFA Threshold Gate (₹15,000)          │
                       │  • Anti-Loop & Max-Retry Exhaustion Caps     │
                       └──────────────────────┬───────────────────────┘
                                              │
                              Authoritative Enforced Decision
                                              │
                                              ▼
                       ┌──────────────────────────────────────────────┐
                       │         SINGLE WRITE-GATEKEEPER              │
                       │  • executeAction() — sole state mutator      │
                       │  • Live Gateway Calls vs Labelled Fallback   │
                       │  • Append-Only Audit Ledger                  │
                       └──────────────────────┬───────────────────────┘
                                              │
                                              ▼
                       ┌──────────────────────────────────────────────┐
                       │          REAL-TIME OBSERVABILITY             │
                       │  • Next.js Executive Glassmorphic Dashboard  │
                       │  • Per-Row AI Provider/Model Attribution     │
                       │  • AI Override Signal Indicators             │
                       └──────────────────────────────────────────────┘
```

### 1.1 Advisory vs. Authority Separation

The LLM never writes and never decides. `lib/policy-engine.ts` exposes one pure function —
`diagnoseAndDecide(transaction, policyConfig, currentHour, now?)` — with no database handle, no
ambient clock, and no network access. The hour is injected as a parameter, which is precisely what
makes compliance behaviour testable at any time of day rather than only after 21:00.

When the advisory recommendation and the policy decision disagree, **the policy decision executes.**
The ledger records the disagreement under `actor = 'policy_engine_override'`, retaining the model's
reasoning alongside the rule that overruled it and the action actually taken.

In the frozen benchmark the advisory layer is overruled on **8 of 65 transactions (12.3%)**. Those
eight resolve as: 5 redirected to a compliant nudge (2 of which recovered), 2 escalated to a terminal
`stop_unrecoverable`, and 1 deferred to `no_action`.

The nine rules evaluate in strict priority order, first match wins:

| # | Trigger | Decision |
| :-- | :--- | :--- |
| 1 | Already `recovered` | `no_action` |
| 2 | Blocked reason code (`payment_risk_check_failed`, `transaction_daily_limit_exceeded`) | `stop_unrecoverable` |
| 3 | Subscription above RBI AFA threshold (₹15,000) | `request_approval` *(TRAI-gated)* |
| 4 | Retry and/or nudge limits exhausted | `stop_unrecoverable` |
| 5 | Transient `gateway` / `razorpay` failure within tier retry limit | `auto_retry` |
| 6 | `insufficient_funds`, nudges remaining | `send_nudge` *(TRAI-gated)* |
| 7 | Card declined / expired / auth failed, first nudge | `send_nudge` *(TRAI-gated, no retry)* |
| 8 | Checkout abandonment, by age: <1h / 1–24h / >24h | `no_action` / `send_nudge` *(TRAI-gated)* / `stop_unrecoverable` |
| 9 | No rule matched | `no_action` |

Rule 7 deliberately does **not** retry. A declined or expired card fails identically on retry, so the
only useful action is asking the customer to update the instrument.

These five actions — `auto_retry`, `send_nudge`, `request_approval`, `stop_unrecoverable`,
`no_action` — are the complete set the engine can emit.

### 1.2 Single Write-Gatekeeper (`executeAction`)

Every state mutation — transaction status, retry and nudge counters, recovery amounts, payment-link
creation — passes through `lib/action-executor.ts`. No route, script, or component writes transaction
state directly. That is what makes the ledger a complete record rather than a partial one.

**A failed gateway call is never counted as collected money.** If the live Razorpay call throws, the
executor forces `success = false`, `recovered = false`, `recoveredAmountPaise = null`, and labels the
audit row:

```
[SIMULATED FALLBACK — NO LIVE RAZORPAY CALL] Razorpay Payment Link creation failed (<cause>).
No live link exists and no payment was confirmed. The offline simulation would have reported "<outcome>".
```

Fallback outcome codes live in a list deliberately separate from the success codes in
`lib/recovery-outcomes.ts` and are excluded from `SUCCESSFUL_RECOVERY_OUTCOMES`, so a blocked
outbound request cannot inflate recovered revenue in any rollup, API response, or dashboard tile.

### 1.3 Production Webhook Hardening

`app/api/webhook/route.ts`:

- **HMAC-SHA256 verification** via Razorpay's own `validateWebhookSignature`. Forged or corrupted payloads are rejected with `400`.
- **Idempotency** on a unique `eventId` column. A replayed delivery returns `200` and writes **zero** additional rows.
- **Terminal-state conflict guard.** A late `payment.failed` for an already-`recovered` transaction cannot downgrade it; the attempt is itself audited rather than dropped silently.
- **Honest failure codes.** A genuine processing error returns `500` so Razorpay retries, instead of masking the failure behind a `200`.
- **Multi-secret verification** so webhook secrets can be rotated without dropping in-flight deliveries.

The four terminal and non-terminal states a transaction can hold are exactly `recovered`, `failed`,
`unrecoverable`, and `pending`.

### 1.4 Compliance Gating

**TRAI (commercial communication, 10:00–21:00 IST).** All four customer-messaging paths are gated —
Rule 3 (`request_approval`) plus Rules 6, 7, and 8 (`send_nudge`). Outside the window the engine
returns `action: 'no_action'` with `blockedByCompliance: true` and the reason *"outside compliant
nudge window (TRAI SMS timing rules), deferred to next window"*. No SMS body is composed at all.

**RBI additional-factor authentication.** Subscription debits above the merchant-configured
`afaThresholdPaise` (₹15,000) cannot auto-retry; they route to `request_approval` for an explicit
customer 2FA step-up.

**Tier-aware patience.** `vip` 3 retry attempts, `standard` 1, `trial` 1; `maxNudges` 2 for every
tier. Card-reason nudges are additionally capped at 1. Every threshold lives in the `PolicyConfig`
table and is merchant-tunable without a code change.

---

## 2. Benchmark Evaluation (65-Transaction Dataset)

RecoverAI was validated against a standardized 65-scenario benchmark covering the spectrum of Indian
payment failure patterns: transient switch errors, bank downtime, insufficient funds, card
authorization failures and expiries, RBI-threshold subscription mandates, fraud and velocity blocks,
and abandoned checkouts across three age bands. Tier mix: 40 `standard`, 13 `vip`, 12 `trial`.

Every figure below was re-derived directly from the frozen ledger (`dev.db.locked-baseline`) with
independent SQL, not read back from application output.

### Headline Performance Metrics

| Metric | Benchmark Result | Status / Details |
| :--- | :--- | :--- |
| **Total At-Risk Evaluated** | **₹4,24,437.00** | 65 transactions across VIP, Standard, and Trial tiers |
| **Total Recovered Revenue** | **₹2,45,460.00** | Recovered via intelligent routing and compliant dunning |
| **Recovery Rate (by value)** | **57.8%** | ₹2,45,460 of ₹4,24,437, reconciled against the immutable ledger |
| **Recovery Rate (by count)** | **64.6%** | 42 of 65 transactions |
| **Successful Recoveries** | **42 transactions** | Automated retries, payment links, and approved mandates |
| **Failed Recoveries** | **13 transactions** | ₹1,31,987.00 — retry/nudge limits reached within safe stopping rules |
| **Honest Exceptions** | **6 transactions** | ₹28,994.00 — `stop_unrecoverable` (fraud/velocity blocks, expired carts) |
| **Pending / In-Flight** | **4 transactions** | ₹17,996.00 — 2 premature carts (<1h) held + 2 active carts nudged, awaiting payment |

Both rates are quoted because they differ, and the value-weighted figure is the lower and more
conservative of the two. Every paise reconciles: `42 + 13 + 6 + 4 = 65`, and
`₹2,45,460 + ₹1,31,987 + ₹28,994 + ₹17,996 = ₹4,24,437`.

### Recovery Breakdown by Action

Action taken from the audit ledger; recovery and money counted from transaction state.

| Action | Txns | Recovered | Rate | Recovered value | At-risk value |
| :--- | ---: | ---: | ---: | ---: | ---: |
| `auto_retry` | 30 | 25 | **83.3%** | ₹1,16,475.00 | ₹1,44,970.00 |
| `send_nudge` | 23 | 14 | **60.9%** | ₹45,986.00 | ₹1,14,977.00 |
| `request_approval` | 4 | 3 | **75.0%** | ₹82,999.00 | ₹1,32,998.00 |
| `stop_unrecoverable` | 6 | 0 | 0.0% | ₹0.00 | ₹28,994.00 |
| `no_action` | 2 | 0 | 0.0% | ₹0.00 | ₹2,498.00 |
| **Total** | **65** | **42** | **64.6%** | **₹2,45,460.00** | **₹4,24,437.00** |

- **`stop_unrecoverable`** — 0.0% by design. 3 risk/velocity blocks (₹2,997.00) stopped on first evaluation to eliminate merchant liability, never retried and never nudged; 3 carts abandoned more than 24 hours ago (₹25,997.00), past the point where a nudge is useful or welcome.
- **`no_action`** — 0.0% by design. Deliberate hold on carts under 60 minutes old per merchant anti-spam policy (see §3.2). This is a merchant-policy choice, not a TRAI requirement.

---

## 3. Honest Disclosures & Operational Scope

Stated plainly, because a recovery number that cannot be audited is worth nothing.

### 3.1 Benchmark Simulation vs. Live Gateway Verification

**The ₹2,45,460.00 headline figure is a deterministic offline benchmark, not settled money.**
Recovery across the 65 transactions is resolved by a seeded per-transaction oracle
(`expectedRecoveryOutcome`), which is what makes the batch reproducible and the arithmetic
independently checkable — but the recovery *events* are stipulated by the fixture, not observed from a
payment network.

What **is** live-verified against active Razorpay test credentials (`rzp_test_...`):

- **Payment-link creation.** A genuine test-mode API call, with the returned link ID persisted to the ledger — `plink_TXI45ScD7eQ5H4` (₹499.00). Reproduce with `npm run test:razorpay`, which prints the raw Razorpay API response, or `npm run checkout:live`, which mints a link for a real browser checkout.
- **Webhook security and idempotency.** Signature rejection, replay suppression, terminal-state conflict handling, and `500`-on-failure are covered by the automated suites in §5, driven by locally HMAC-signed payloads.

What is **not** claimed:

- **That link stands at `pending` — created, not paid.** A complete customer-paid round trip (link → customer payment → inbound Razorpay webhook → state transition) is **not** evidenced in this repository. `npm run checkout:live` documents the manual loop (pay via test VPA `success@razorpay` or `failure@razorpay`, then confirm the inbound `evt_...`), but its completion is operator-run and unrecorded here. The webhook receiver is verified against locally-signed payloads, which proves the handler, not the delivery.
- The live link above is flagged `isDemoArtifact` and sits **outside** the 65-transaction benchmark by construction, so live experimentation can never move the headline numbers. `npm run test:demo-isolation` is the suite that proves this isolation holds — it does not, and is not claimed to, validate live link creation.
- No production settlement, reconciliation, or refund flow exists.
- If a live Razorpay call fails or hits test-mode rate limits, the system falls back to offline routing and tags the ledger `[SIMULATED FALLBACK — NO LIVE RAZORPAY CALL]` with `recovered = false`, so synthetic activity is never misattributed as live settlement.

### 3.2 Premature Cart Policy & In-Flight Carts (the 4 Pending Cases)

| Transaction | Value | Reason |
| :--- | ---: | :--- |
| `cart_abnd_recent_056` | ₹999.00 | Cart <1h old → `no_action`, *"too soon, avoiding premature nudge"* |
| `cart_abnd_recent_057` | ₹1,499.00 | Cart <1h old → `no_action`, *"too soon, avoiding premature nudge"* |
| `cart_abnd_active_061` | ₹14,999.00 | Nudged once, `nudge_sent_no_recovery`, awaiting customer |
| `cart_abnd_active_062` | ₹499.00 | Nudged once, `nudge_sent_no_recovery`, awaiting customer |

**The two premature carts (₹2,498.00 combined) are held deliberately, and the hold costs us the
headline number.** A shopper who abandoned a cart eleven minutes ago is very likely still shopping.
Firing an SMS at them is the fastest way to convert a recoverable customer into an unsubscribe, so
Rule 8 takes no action at all below 60 minutes and RecoverAI counts both carts as **not recovered.**

This is worth stating precisely because an earlier revision of this engine counted both as recovered
and reported **₹2,47,958.00 / 58.4% / 44 recovered.** Holding them correctly reduces the figure to
**₹2,45,460.00 / 57.8% / 42 recovered** — a delta of exactly ₹2,498.00, which is precisely
`₹999.00 + ₹1,499.00`. The lower number is the honest one, and it is the one published above. An
engine that claims credit for money it deliberately chose not to chase is not an auditable engine.

### 3.3 Provider Attribution Integrity

The advising provider and exact model are resolved at runtime and stamped on each audit row, rather
than asserted in advance. Across the 73 rows in the frozen ledger:

| Provider | Model | Rows |
| :--- | :--- | ---: |
| Google Gemini | `gemini-3.5-flash-lite` | 68 |
| Google Gemini | `gemini-3.5-flash` | 3 |
| *(none — advisory unavailable)* | *(none)* | 2 |

Zero rows attribute reasoning to a provider that did not answer. When every provider is unreachable
or quota-exhausted (HTTP 429), the engine records `advisory_unavailable` with `provider` and `model`
left **NULL** rather than inventing attribution, and the deterministic kernel proceeds alone — an
advisory outage can never block recovery.

**Known ledger-granularity limitation.** For those 2 `advisory_unavailable` rows the `result` column
records the advisory state rather than the execution outcome, and one of them did in fact recover
(₹14,999.00). Per-action rates computed purely from ledger `result` strings therefore read one
recovery low. The table in §2 takes recovery from transaction state for exactly this reason, and is
authoritative for money.

### 3.4 Deliberately Out of Scope

Disclosed rather than implied:

- **No live SMS / WhatsApp / email delivery.** Messages are composed and logged, never sent. Real delivery in India requires DLT registration and template approval — a regulatory lead time, not an afternoon of work.
- **No consent or opt-out ledger.** A prerequisite for real delivery, and absent.
- **No scheduler.** A TRAI-deferred nudge is recorded as deferred; nothing re-fires it when the window opens at 10:00 IST. This is the single most significant functional gap — see §6.1.
- **No B2B receivables domain.** No invoice, due-date, or ageing model.
- **`externalPaymentId` is overwritten** by the recovery link ID when a live link is created, losing the original gateway reference — a reconciliation gap.
- **The webhook's check → mutate → log sequence is not wrapped in a transaction.** Idempotency is enforced by a unique index, so a crash mid-sequence cannot double-count, but it can leave a state change without its ledger row.
- **No CI pipeline.** The suite in §5 runs locally.

---

## 4. Getting Started

### Prerequisites

- **Node.js**: `v20.x` or `v22.x`
- **npm**: `v10.x` or higher
- SQLite3 (bundled via `@prisma/adapter-better-sqlite3` and `better-sqlite3`)

Stack: Next.js 16 (App Router) · React 19 · Prisma 7 with the `better-sqlite3` driver adapter ·
`razorpay` 2.9 · `@google/genai` · recharts · framer-motion.

> **Prisma 7 note:** the datasource URL lives in `prisma.config.ts`, not `schema.prisma`.

### Installation & Environment Setup

1. Clone the repository and install dependencies:
   ```bash
   git clone <repo-url>
   cd recoverai
   npm install
   ```

2. Configure environment variables in `.env`:
   ```bash
   cp .env.example .env
   ```
   Set your credentials:
   - `DATABASE_URL="file:./dev.db"`
   - `GEMINI_API_KEY` or `GOOGLE_API_KEY` (primary AI advisory)
   - `ANTHROPIC_API_KEY` (optional fallback)
   - `OPENAI_API_KEY` (optional fallback)
   - `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` (test-mode keys)
   - `RAZORPAY_WEBHOOK_SECRET` (webhook signature verification)
   - `DEMO_TRIGGER_SECRET` (authorizes the dashboard demo trigger endpoint)

   At least one AI provider key is required; `npm run demo` refuses to start without one rather than
   silently degrading.

3. Initialize the Prisma client:
   ```bash
   npx prisma generate
   ```

---

## 5. Running the Application & Test Suite

### Development Web Server

Start the executive dashboard with real-time polling updates:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) (or navigate to `/dashboard`).

### Running the Recovery Engine Demo

Execute the full recovery loop across the 65-scenario dataset with live AI advisory reasoning:

```bash
npm run demo
```

*Options:*
- `--hour=14`: Simulate execution at 14:00 IST (within the TRAI-compliant nudge window).
- `--hour=23`: Simulate execution at 23:00 IST (outside the window; triggers compliance guards).

> `npm run demo` **reseeds the database**, replacing all transactions and audit rows — it is the
> command that regenerates the frozen benchmark. To restore the shipped baseline at any point:
> ```bash
> npm run restore-baseline
> ```

### Running Policy Compliance Check

Run the pure deterministic rules engine against every transaction in the database — no AI calls, no
reseed:

```bash
npm run policy-check
```

### Full Automated Regression Suite

Run all 8 automated end-to-end and resilience suites:

```bash
npm run test:all
```

| Suite | Proves |
| :--- | :--- |
| `test:off-window` | TRAI window enforcement — nudges deferred outside 10:00–21:00 IST |
| `test:retry-exhaustion` | Terminal stopping rules once retry and nudge limits are exceeded |
| `test:idempotency` | HMAC verification and webhook event deduplication |
| `test:conflict-guard` | Webhooks cannot overwrite finalized terminal states |
| `test:demo-isolation` | Interactive demo clicks never mutate or pollute baseline benchmark data |
| `test:advisory-unavailable` | Deterministic fallback when every external AI provider is offline |
| `test:webhook-processing-failure` | Genuine database errors surface as `500`, not a masked `200` |
| `test:provider-attribution` | AI provider and model attribution are resolved dynamically at runtime |

Every suite confines its writes to transactions flagged `isDemoArtifact`. The resilience suites
(`test:retry-exhaustion`, `test:idempotency`) create a throwaway transaction and delete it together
with its audit rows in a `finally` block; the demo-trigger path instead writes against two persistent
demo-artifact transactions, which accumulate ledger rows across repeat runs. Either way the 65
benchmark transactions are never touched, and headline metrics exclude `isDemoArtifact` rows by
construction.

This isolation is verified, not asserted. Four consecutive suite runs against the shipped baseline
added 8 audit rows — **all 8 attached to the two demo-artifact transactions, 0 to any benchmark
transaction, and 0 orphaned** — leaving the headline unchanged to the paisa at ₹2,45,460.00 / 42
recovered.

Additional targeted scripts: `test:e2e`, `test:p2p`, `test:razorpay`, `test:abandonment`,
`test:demo-trigger-guard`, `checkout:live`.

---

## 6. Architecture Roadmap

The following capabilities are scheduled for subsequent releases, ordered by how much each would
raise the measured recovery rate.

1. **Distributed Queue & Rescheduling Engine**
   The highest-value gap. A TRAI-deferred nudge is currently recorded and then never re-fired, so
   "compliant escalation" today means compliantly declining to act. A BullMQ/Redis-backed durable
   delayed-task scheduler would dispatch a nudge blocked at 23:00 at precisely 10:00:00 IST the
   following morning, survive process restarts, and record both the deferral and the eventual outcome
   against the same transaction — closing the loop and converting held value into recovered value.

2. **Escalation Ladder & Unified Compliance Gate**
   Route every outbound message through a single `sendMessage()` choke point enforcing window,
   consent, opt-out, frequency cap, and channel, making it structurally impossible for a new rule to
   bypass compliance. On top of it, a true ladder — silent retry → SMS → WhatsApp → human queue →
   write-off — with per-attempt cost budgets, replacing today's parallel single-shot interventions.

3. **B2B Invoice & ERP Dunning**
   An `Invoice` domain with due dates, ageing buckets, and part-payments, plus broken-promise
   detection on the existing Promise-to-Pay tracker — dunning schedules rather than retry caps.
   Targets GST e-invoicing, Tally/Zoho reconciliation, and corporate netbanking mandates.

4. **DLT-Compliant Multi-Channel Delivery**
   Real SMS and WhatsApp dispatch through a DLT-registered sender with approved templates, a consent
   and opt-out ledger, and per-channel delivery receipts reconciled back into the audit trail.

5. **Multilingual Interactive Voice Recovery (IVR)**
   DLT-compliant voice-bot re-authorization in Hindi, Hinglish, and regional languages for high-AOV
   retail drop-offs, where voice converts materially better than SMS.

6. **Portfolio-Level Agentic Reasoning**
   Today the advisory layer classifies one transaction at a time. Reasoning over the whole *batch*
   would let it detect correlated failure — *"34 of these share `bank_technical_error` on one issuer
   inside 20 minutes; that is an outage, not 34 independent customer problems — hold all retries 30
   minutes, then retry the cohort"* — which is where an LLM contributes judgment a rule engine cannot
   encode.

7. **Provable Ledger Immutability**
   Hash-chain each audit row to its predecessor's digest and revoke `DELETE` at the database role
   level, making append-only integrity cryptographically verifiable rather than asserted.

8. **Incremental Lift Measurement**
   Run the batch against a holdout control group so the headline can be stated as lift rather than as
   a gross rate — *"57.8% recovered vs. X% for untouched controls, +Ypp incremental."* No control arm
   exists today, so no lift figure is claimed anywhere in this document. Incremental lift is the
   number a payments operator actually buys; a gross recovery rate cannot distinguish genuine recovery
   from customers who would have retried anyway.
