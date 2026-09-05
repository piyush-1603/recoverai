# RecoverAI

**Autonomous, Deterministic AI Revenue Recovery Engine for Indian UPI & Card Payments**

RecoverAI is an enterprise-grade payment failure recovery engine designed specifically for the Indian payments ecosystem (UPI, recurring mandates, debit/credit cards, and netbanking). It couples multi-model LLM advisory reasoning (Google Gemini, Anthropic Claude, OpenAI GPT) with an authoritative, mathematical **Deterministic Policy Engine** that strictly enforces risk parameters, retry limits, and Indian regulatory compliance (TRAI telecom nudge windows and RBI recurring mandates).

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
                       └──────────────────────┬───────────────────────┘
                                              │
                                     Advisory Recommendation
                                              │
                                              ▼
                       ┌──────────────────────────────────────────────┐
                       │      DETERMINISTIC POLICY ENGINE (AUTHORITY) │
                       │  • Single Source of Truth / Hard Rules Kernel│
                       │  • TRAI Nudge Window Guard (10:00-21:00 IST) │
                       │  • Anti-Loop & Max-Retry Exhaustion Caps     │
                       │  • VIP Escalation & Merchant Protection      │
                       └──────────────────────┬───────────────────────┘
                                              │
                              Authoritative Enforced Decision
                                              │
                                              ▼
                       ┌──────────────────────────────────────────────┐
                       │         SINGLE WRITE-GATEKEEPER              │
                       │  • executeAction() Atomic State Transition   │
                       │  • Live Gateway Calls vs Simulated Fallback  │
                       │  • Append-Only Tamper-Evident Audit Ledger   │
                       └──────────────────────┬───────────────────────┘
                                              │
                                              ▼
                       ┌──────────────────────────────────────────────┐
                       │          REAL-TIME OBSERVABILITY             │
                       │  • Next.js Executive Glassmorphic Dashboard  │
                       │  • Live Webhook Capture & Verification       │
                       │  • AI Override Signal Indicators             │
                       └──────────────────────────────────────────────┘
```

### Key Architectural Tenets

1. **Advisory vs. Authority Separation**:
   Large Language Models provide nuanced behavioral heuristics (evaluating customer loyalty, cart value, and churn risk), but **never hold direct write authority**. Every LLM recommendation is intercepted and verified by the `Deterministic Policy Engine`. If an LLM recommends an aggressive retry or off-hours customer nudge that violates compliance or risk thresholds, the policy engine strictly overrules it, logs a `policy_engine_override` entry to the ledger, and enforces the safe action.

2. **Single Write-Gatekeeper (`executeAction`)**:
   All database mutations, payment link generations, and state updates pass through a single, audited execution bottleneck in `lib/action-executor.ts`. This ensures no component can alter transaction states or recovery balances without recording a cryptographically consistent entry in the immutable audit log.

3. **Production Webhook Hardening**:
   - **HMAC-SHA256 Verification**: Reject forged or corrupted payloads using the Razorpay webhook signing secret.
   - **Idempotency**: All webhook delivery IDs are indexed and verified. Duplicate delivery attempts return `200 OK` immediately without re-executing business logic or corrupting recovery tallies.
   - **Terminal State Conflict Guard**: Webhooks arriving for transactions already finalized in a terminal state (`recovered`, `unrecoverable`, `failed_exhausted`) are safely audited and ignored, preventing race conditions.

4. **TRAI Telecom Nudge Window Compliance**:
   Under Telecom Regulatory Authority of India (TRAI) regulations, commercial communications (SMS/WhatsApp) cannot be sent to consumers outside **10:00 to 21:00 IST**. Customer-facing recovery actions (`send_nudge`, `request_approval`) attempted outside this window are automatically deferred with `blockedByCompliance: true` and `action: 'no_action'`.

---

## 2. Benchmark Evaluation (65-Transaction Dataset)

RecoverAI was validated against a standardized, 65-scenario benchmark dataset covering the full spectrum of Indian payment failure patterns: transient switch errors, card authorization failures, bank downtime, expired 2FA sessions, insufficient funds, abandoned checkouts, and customer-side aborts.

### Headline Performance Metrics

| Metric | Benchmark Result | Status / Details |
| :--- | :--- | :--- |
| **Total At-Risk Evaluated** | **₹4,24,437.00** | 65 transactions across VIP, Standard, and Trial tiers |
| **Total Recovered Revenue** | **₹2,45,460.00** | Recovered via intelligent routing and compliant dunning |
| **Recovery Rate** | **57.8%** | Reconciled against immutable ledger |
| **Successful Recoveries** | **42 transactions** | Automated retries, payment links, and approved mandates |
| **Failed Recoveries** | **13 transactions** | Network/exhaustion limits reached within safe stopping rules |
| **Honest Exceptions** | **6 transactions** | Stopped immediately (`stop_unrecoverable` - fraud, stolen cards, terminal decline) |
| **Pending / In-Flight** | **4 transactions** | 2 premature carts (<1h) deferred + 2 active carts (1-24h) nudged pending payment |

### Recovery Breakdown by Action

- **`auto_retry`**: 83.3% recovery rate (25/30 recovered · ₹1,16,475.00 recovered of ₹1,44,970.00 at risk).
- **`send_nudge`**: 60.9% recovery rate (14/23 recovered · ₹45,986.00 recovered of ₹1,14,977.00 at risk).
- **`request_approval`**: 75.0% recovery rate (3/4 recovered · ₹82,999.00 recovered of ₹1,32,998.00 at risk).
- **`stop_unrecoverable`**: 0.0% recovery (0/6 · deliberate halt on fraudulent, stolen, or expired carts to eliminate liability).
- **`no_action`**: 0.0% recovery (0/2 · deliberate deferral on carts <1h old per TRAI/merchant spam policy).

---

## 3. Honest Disclosures & Operational Scope

To maintain complete transparency for audits, technical judges, and production operations:

1. **Benchmark Simulation vs. Live Gateway Verification**:
   - The 65-scenario benchmark evaluates system recovery policy using deterministic state-machine simulation and recorded payment link generation.
   - Live end-to-end payment link creation, customer checkout, and webhook reconciliation are independently validated using active Razorpay API test credentials (`rzp_test_...`) via `npm run test:demo-isolation` and the interactive dashboard trigger.
   - If live Razorpay API calls fail or test-mode rate limits are reached, the system gracefully falls back to simulated offline routing, tagging the audit ledger with `[SIMULATED FALLBACK — NO LIVE RAZORPAY CALL]` so synthetic activity is never misattributed as live settlement.

2. **Premature Cart Abandonment Policy & In-Flight Carts (4 Pending Cases)**:
   - In accordance with standard e-commerce best practices, transactions originating from checkout abandonment (`source: 'customer'`) less than 60 minutes old are intentionally placed in `pending` review (`action: 'no_action'`). RecoverAI does not immediately trigger high-frequency SMS/WhatsApp nudges while the shopper may still be actively browsing or completing checkout.
   - Active carts abandoned 1–24 hours ago receive compliant payment link nudges; until the shopper completes payment via the link, their status remains `pending` with outcome `nudge_sent_no_recovery`.

3. **Provider Attribution Integrity**:
   - The advising AI provider (e.g. `Google Gemini · gemini-3.5-flash-lite`, `Anthropic Claude`, or `OpenAI GPT`) is resolved dynamically at runtime and stamped directly on audit rows.
   - If all external AI providers are unreachable or encounter quota exhaustion (HTTP 429), the engine fails open gracefully to the deterministic policy kernel without disruption, logging `advisory_unavailable`.

---

## 4. Getting Started

### Prerequisites

- **Node.js**: `v20.x` or `v22.x`
- **npm**: `v10.x` or higher
- SQLite3 (bundled via `@prisma/adapter-better-sqlite3` and `better-sqlite3`)

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
   Set your API credentials:
   - `DATABASE_URL="file:./dev.db"`
   - `GEMINI_API_KEY` or `GOOGLE_API_KEY` (Primary AI advisory)
   - `ANTHROPIC_API_KEY` (Optional fallback)
   - `OPENAI_API_KEY` (Optional fallback)
   - `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` (Test mode keys)
   - `RAZORPAY_WEBHOOK_SECRET` (For signature verification)

3. Initialize the Prisma database:
   ```bash
   npx prisma generate
   ```

---

## 5. Running the Application & Test Suite

### Development Web Server
Start the executive dashboard with real-time SSE / polling updates:
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) (or navigate to `/dashboard`).

### Running the Recovery Engine Demo
Execute the full recovery loop across the 65-scenario dataset with AI advisory reasoning:
```bash
npm run demo
```
*Options:*
- `--hour=14`: Simulate execution at 14:00 IST (within TRAI compliant nudge window).
- `--hour=23`: Simulate execution at 23:00 IST (outside TRAI window; triggers compliance guards).

### Running Policy Compliance Check
Run the pure deterministic rules engine against all transactions in the database:
```bash
npm run policy:check
```

### Full Automated Regression Suite
Run all 8 automated end-to-end and resilience test suites:
```bash
npm run test:all
```

#### Individual Test Suites:
- `npm run test:off-window`: Validates TRAI window enforcement (blocks SMS between 21:00 and 10:00 IST).
- `npm run test:retry-exhaustion`: Tests terminal stopping rules when retry and nudge limits are exceeded.
- `npm run test:idempotency`: Verifies HMAC verification and webhook event deduplication.
- `npm run test:conflict-guard`: Confirms webhooks cannot overwrite finalized terminal states.
- `npm run test:demo-isolation`: Verifies interactive demo clicks never mutate or pollute baseline benchmark data.
- `npm run test:advisory-unavailable`: Confirms deterministic fallback when external AI providers are offline.
- `npm run test:webhook-processing-failure`: Validates atomicity and error handling on database query errors.
- `npm run test:provider-attribution`: Proves AI provider and model attribution are dynamically resolved.

---

## 6. Architecture Roadmap

The following enterprise capabilities are scheduled for subsequent major releases:

1. **Distributed Queue & Rescheduling Engine**:
   - BullMQ / Redis-backed persistent delayed-task scheduler to automatically dispatch TRAI-deferred communications at precisely 10:00:00 IST the following morning.
2. **B2B Invoice & ERP Dunning**:
   - Automated reconciliation and dunning workflows for GST e-invoices, Tally/Zoho integrations, and corporate netbanking mandates.
3. **Multilingual Interactive Voice Recovery (IVR)**:
   - DLT-compliant voice bot integrations capable of natural Hindi, Hinglish, and regional language payment link re-authorization for high-AOV retail drop-offs.
