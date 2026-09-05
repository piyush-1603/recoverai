/**
 * /scripts/test-end-to-end-trace.ts
 *
 * End-to-End Lifecycle Trace for a single transaction — with real assertions.
 *
 * Lifecycle Stages (each one asserted, not merely printed):
 *  1. Seed Record Creation (status: failed, retries: 0, nudges: 0)
 *  2. Policy Engine Diagnosis (pure evaluation -> auto_retry)
 *  3. Action Execution & Link Creation (retryCount: 1, externalPaymentId recorded)
 *  4. Inbound Webhook Execution (payment.captured -> status: recovered)
 *  5. Webhook Replay Idempotency Verification (duplicate ignored, NO new audit row)
 *  6. Full Audit Trail Verification (coherent, chronological, no duplicate eventIds)
 *
 * Exits non-zero if any assertion fails, so a broken pipeline can no longer
 * report success. The trace record is flagged isDemoArtifact and removed in a
 * `finally` block, so even a mid-run failure cannot leak it into the baseline.
 *
 * Run via: npm run test:e2e
 */

import 'dotenv/config';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { diagnoseAndDecide } from '../lib/policy-engine';
import { executeAction, auditReasonSuffix } from '../lib/action-executor';
import { writeEvent } from '../lib/audit-logger';
import { isSimulatedFallbackOutcome, isSuccessfulRecoveryOutcome } from '../lib/recovery-outcomes';
import { POST } from '../app/api/webhook/route';
import { NextRequest } from 'next/server';

function hr(char = '─', len = 70): string {
  return char.repeat(len);
}

function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}

let failures = 0;
function assert(label: string, condition: boolean, detail: string) {
  if (!condition) failures++;
  console.log(`    ${condition ? '✓ PASS' : '✗ FAIL'}  ${label.padEnd(42)} ${detail}`);
}

async function runEndToEndTrace() {
  console.log('\n' + hr('═'));
  console.log('  🎯  TEST 6: END-TO-END TRANSACTION LIFECYCLE TRACE');
  console.log(hr('═'));

  const webhookSecret =
    process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET || 'test_webhook_secret_123';

  // ── STAGE 1: Seed / Isolate Single Transaction ───────────────────────────
  console.log('\n  [STAGE 1] Seed Record Setup');
  console.log('  ' + hr('─', 60));

  const externalId = `pay_e2e_demo_${Date.now()}`;
  const transaction = await prisma.transaction.create({
    data: {
      externalPaymentId: externalId,
      amountPaise: 149900, // ₹1,499.00
      status: 'failed',
      reasonCode: 'gateway_technical_error',
      source: 'gateway',
      type: 'payment',
      customerId: 'cust_demo_live',
      retryCount: 0,
      nudgeCount: 0,
      recovered: false,
      expectedRecoveryOutcome: 'recovers_on_retry',
      simulatedRecoveryAmountPaise: 149900,
      // Excluded from the frozen headline metrics for as long as it exists.
      isDemoArtifact: true,
    },
  });

  try {
    console.log(`    • Transaction ID     : ${transaction.id}`);
    console.log(`    • External Payment ID: ${transaction.externalPaymentId}`);
    console.log(`    • Amount             : ${rupees(transaction.amountPaise)}`);
    console.log(`    • Source / Reason    : ${transaction.source} / ${transaction.reasonCode}`);
    console.log(`    • Initial Status     : ${transaction.status} (recovered=${transaction.recovered})`);
    console.log(`    • Retries / Nudges   : retryCount=${transaction.retryCount}, nudgeCount=${transaction.nudgeCount}`);
    console.log();
    assert('starts in failed state', transaction.status === 'failed', `status=${transaction.status}`);
    assert('starts unrecovered', transaction.recovered === false, `recovered=${transaction.recovered}`);
    assert('starts with zero retries/nudges', transaction.retryCount === 0 && transaction.nudgeCount === 0, `${transaction.retryCount}/${transaction.nudgeCount}`);
    assert('excluded from headline metrics', transaction.isDemoArtifact === true, `isDemoArtifact=${transaction.isDemoArtifact}`);

    // ── STAGE 2: Policy Engine Diagnosis ─────────────────────────────────────
    console.log('\n  [STAGE 2] Policy Engine Diagnosis (Pure Function)');
    console.log('  ' + hr('─', 60));

    const policyConfig = {
      afaThresholdPaise: 1500000,
      maxRetries: 1,
      maxNudges: 2,
      nudgeWindowStartHour: 10,
      nudgeWindowEndHour: 21,
    };

    const decision = diagnoseAndDecide(transaction, policyConfig, 14);
    console.log('    Decision Object:');
    console.log(JSON.stringify(decision, null, 6));
    console.log();

    // A transient gateway error on a standard-tier record with retryCount 0 must
    // route to auto_retry via priority rule 5.
    assert('routes to auto_retry', decision.action === 'auto_retry', `action=${decision.action}`);
    assert('cites the transient-gateway rule', /transient gateway error/.test(decision.reason), `"${decision.reason}"`);
    assert('needs no approval', decision.requiresApproval === false, `${decision.requiresApproval}`);
    assert('not compliance-blocked', decision.blockedByCompliance === false, `${decision.blockedByCompliance}`);
    assert('carries a policy version', decision.policyVersion === 'v1', `${decision.policyVersion}`);

    // Log diagnosis audit
    await writeEvent(
      transaction.id,
      'policy_engine',
      decision.action,
      decision.reason,
      'decision_rendered',
      undefined,
      decision.policyVersion,
      null,
      null,
      {
        amountPaise: transaction.amountPaise,
        ruleId: decision.ruleId,
        extra: {
          currentHourIst: 14,
          holdReason: decision.holdReason,
          resumeAtHour: decision.resumeAtHour,
          blockedByCompliance: decision.blockedByCompliance,
          requiresApproval: decision.requiresApproval,
        },
      },
    );

    // ── STAGE 3: Action Execution ────────────────────────────────────────────
    console.log('\n  [STAGE 3] Action Execution (State Mutation Gatekeeper)');
    console.log('  ' + hr('─', 60));

    const execution = await executeAction(decision, transaction);
    console.log(`    • Action Executed    : ${execution.action}`);
    console.log(`    • Outcome            : ${execution.outcome}`);
    console.log(`    • Note               : ${execution.note}`);

    await writeEvent(
      transaction.id,
      'action_executor',
      execution.action,
      execution.note,
      execution.outcome,
      undefined,
      decision.policyVersion,
      null,
      null,
      {
        amountPaise: transaction.amountPaise,
        recoveredAmountPaise: execution.recoveredAmountPaise,
        simulated: execution.simulated,
        ruleId: decision.ruleId,
        channel: execution.channel,
        messagingCostPaise: execution.messagingCostPaise,
        razorpayEntityId: execution.externalPaymentId ?? transaction.externalPaymentId,
        extra: {
          outcome: execution.outcome,
          resolvedStatus: execution.persistedState?.status ?? null,
          holdReason: execution.persistedState?.holdReason ?? null,
          deferredUntil: execution.persistedState?.deferredUntil?.toISOString() ?? null,
          statePersisted: execution.statePersisted,
        },
      },
    );

    const txAfterExecution = await prisma.transaction.findUniqueOrThrow({
      where: { id: transaction.id },
    });
    console.log(`    • Updated DB State   : retryCount=${txAfterExecution.retryCount}, status=${txAfterExecution.status}`);
    console.log();

    assert('executes the policy decision', execution.action === decision.action, `${execution.action}`);
    assert('retryCount incremented to 1', txAfterExecution.retryCount === 1, `retryCount=${txAfterExecution.retryCount}`);
    assert('nudgeCount untouched', txAfterExecution.nudgeCount === 0, `nudgeCount=${txAfterExecution.nudgeCount}`);
    assert('a payment reference is recorded', Boolean(txAfterExecution.externalPaymentId), `${txAfterExecution.externalPaymentId}`);

    // auto_retry has three legitimate outcomes and which one runs depends on the
    // environment, so assert the invariant that binds them rather than pinning
    // one path:
    //   • reachable Razorpay credentials -> a real payment link is created and
    //     the record stays 'pending' until the webhook lands;
    //   • the live call throws -> the executor falls back to the deterministic
    //     simulation and reports it as an UNCONFIRMED simulated fallback, so
    //     nothing is marked recovered off the back of a failed API call;
    //   • no usable credentials at all -> pure offline simulation resolves the
    //     record immediately.
    // Recovery state must agree with whichever outcome was reported.
    const awaitingPayment = execution.outcome === 'link_created_awaiting_payment';
    const fellBack = execution.simulatedFallback;
    const confirmedRecovery = !awaitingPayment && !fellBack;
    console.log(`    • Executor Path      : ${awaitingPayment ? 'live Razorpay link (awaiting webhook)' : fellBack ? 'live call FAILED -> simulated fallback (unconfirmed)' : 'offline deterministic simulation'}`);
    assert(
      'outcome is a known auto_retry outcome',
      awaitingPayment || fellBack || execution.outcome === 'retry_succeeded',
      `outcome=${execution.outcome}`,
    );
    assert(
      'recovery state agrees with outcome',
      txAfterExecution.recovered === confirmedRecovery,
      `recovered=${txAfterExecution.recovered} for outcome=${execution.outcome}`,
    );
    assert(
      'status agrees with outcome',
      txAfterExecution.status === (awaitingPayment ? 'pending' : fellBack ? 'failed' : 'recovered'),
      `status=${txAfterExecution.status}`,
    );

    // Fallback-specific guarantees. A failed live call must not be dressed up as
    // a recovery, and the cause must survive into the ledger — both of which
    // this branch previously got wrong (it reported 'retry_succeeded' with
    // success=true and a note reading "Razorpay call fallback: undefined").
    if (fellBack) {
      assert('fallback is not reported as success', execution.success === false, `success=${execution.success}`);
      assert('fallback is not counted as a recovery', !isSuccessfulRecoveryOutcome(execution.outcome), `outcome=${execution.outcome}`);
      assert('fallback outcome is distinctly labelled', isSimulatedFallbackOutcome(execution.outcome), `outcome=${execution.outcome}`);
      assert('fallback reports no recovered amount', execution.recoveredAmountPaise === null, `${execution.recoveredAmountPaise}`);
      assert('fallback records the real API cause', Boolean(execution.fallbackError) && !/undefined/.test(execution.fallbackError!), `cause="${execution.fallbackError}"`);
      assert('fallback note carries that cause', execution.note.includes(execution.fallbackError!), 'note embeds the cause');
      assert('fallback note is persisted to the ledger', auditReasonSuffix(execution).includes(execution.fallbackError!), 'reason suffix carries the note');
    }

    // ── STAGE 4: Webhook Event Ingestion (payment.captured) ──────────────────
    console.log('\n  [STAGE 4] Inbound Razorpay Webhook (payment.captured)');
    console.log('  ' + hr('─', 60));

    const eventId = `evt_live_e2e_${Date.now()}`;
    const webhookBody = JSON.stringify({
      entity: 'event',
      account_id: 'acc_demo_merchant',
      event: 'payment.captured',
      event_id: eventId,
      contains: ['payment'],
      payload: {
        payment: {
          entity: {
            id: `pay_gateway_captured_${Date.now()}`,
            amount: transaction.amountPaise,
            currency: 'INR',
            status: 'captured',
            order_id: null,
            notes: {
              transactionId: transaction.id,
            },
          },
        },
        payment_link: {
          entity: {
            id: txAfterExecution.externalPaymentId,
            status: 'paid',
            notes: {
              transactionId: transaction.id,
            },
          },
        },
      },
      created_at: Math.floor(Date.now() / 1000),
    });

    const validSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(webhookBody)
      .digest('hex');

    const auditCountBeforeWebhook = await prisma.auditLog.count({
      where: { transactionId: transaction.id },
    });

    const webhookReq = new NextRequest('http://localhost:3000/api/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': validSignature,
        'x-razorpay-event-id': eventId,
      },
      body: webhookBody,
    });

    const webhookRes = await POST(webhookReq);
    const webhookResBody = await webhookRes.json();
    console.log(`    • Webhook HTTP Status: ${webhookRes.status} (Response: ${JSON.stringify(webhookResBody)})`);

    const txAfterWebhook = await prisma.transaction.findUniqueOrThrow({
      where: { id: transaction.id },
    });
    console.log(`    • Status After Webhook: ${txAfterWebhook.status} (recovered=${txAfterWebhook.recovered}, resolvedAt=${txAfterWebhook.resolvedAt ? 'Recorded ✓' : 'None'})`);
    console.log();

    const auditCountAfterWebhook = await prisma.auditLog.count({
      where: { transactionId: transaction.id },
    });

    assert('webhook accepted with HTTP 200', webhookRes.status === 200, `HTTP ${webhookRes.status}`);
    assert('webhook echoes ok status', webhookResBody.status === 'ok', `status=${webhookResBody.status}`);
    assert('webhook matched this transaction', webhookResBody.transactionId === transaction.id, `${webhookResBody.transactionId === transaction.id ? 'matched' : webhookResBody.transactionId}`);
    assert('transaction now recovered', txAfterWebhook.status === 'recovered', `status=${txAfterWebhook.status}`);
    assert('recovered flag set', txAfterWebhook.recovered === true, `recovered=${txAfterWebhook.recovered}`);
    assert('resolvedAt timestamped', txAfterWebhook.resolvedAt !== null, `${txAfterWebhook.resolvedAt ? 'recorded' : 'missing'}`);
    assert('webhook wrote exactly one row', auditCountAfterWebhook === auditCountBeforeWebhook + 1, `${auditCountBeforeWebhook} -> ${auditCountAfterWebhook}`);

    // ── STAGE 5: Webhook Replay (Idempotency) ────────────────────────────────
    console.log('\n  [STAGE 5] Duplicate Webhook Replay');
    console.log('  ' + hr('─', 60));

    const duplicateReq = new NextRequest('http://localhost:3000/api/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': validSignature,
        'x-razorpay-event-id': eventId,
      },
      body: webhookBody,
    });

    const duplicateRes = await POST(duplicateReq);
    const duplicateResBody = await duplicateRes.json();
    console.log(`    • Duplicate HTTP Status: ${duplicateRes.status} (Response: ${JSON.stringify(duplicateResBody)})`);
    console.log();

    const auditCountAfterReplay = await prisma.auditLog.count({
      where: { transactionId: transaction.id },
    });
    const txAfterReplay = await prisma.transaction.findUniqueOrThrow({
      where: { id: transaction.id },
    });

    // A replay must be acknowledged (so Razorpay stops retrying) but must not
    // duplicate the ledger or re-stamp the resolution time.
    assert('replay acknowledged with HTTP 200', duplicateRes.status === 200, `HTTP ${duplicateRes.status}`);
    assert('replay reported as already processed', /already processed/i.test(duplicateResBody.message ?? ''), `"${duplicateResBody.message}"`);
    assert('NO duplicate audit row written', auditCountAfterReplay === auditCountAfterWebhook, `${auditCountAfterWebhook} -> ${auditCountAfterReplay}`);
    assert('resolvedAt not re-stamped', txAfterReplay.resolvedAt?.getTime() === txAfterWebhook.resolvedAt?.getTime(), 'original timestamp preserved');
    assert('final state still recovered', txAfterReplay.status === 'recovered' && txAfterReplay.recovered === true, `status=${txAfterReplay.status}`);

    // ── STAGE 6: Chronological Audit Trail Verification ──────────────────────
    console.log('\n  [STAGE 6] Complete Chronological Audit Trail');
    console.log('  ' + hr('─', 60));

    const auditLogs = await prisma.auditLog.findMany({
      where: { transactionId: transaction.id },
      orderBy: { timestamp: 'asc' },
    });

    console.log(`  Total AuditLog entries written: ${auditLogs.length}\n`);

    for (let i = 0; i < auditLogs.length; i++) {
      const log = auditLogs[i];
      console.log(`  [Step ${i + 1}] Event ID: ${log.eventId}`);
      console.log(`    • Actor     : ${log.actor}`);
      console.log(`    • Action    : ${log.action}`);
      console.log(`    • Reason    : ${log.reason}`);
      console.log(`    • Result    : ${log.result}`);
      console.log(`    • Timestamp : ${log.timestamp.toISOString()}`);
      console.log();
    }

    const actors = auditLogs.map((l) => l.actor);
    const eventIds = auditLogs.map((l) => l.eventId);
    const isChronological = auditLogs.every(
      (l, i) => i === 0 || l.timestamp.getTime() >= auditLogs[i - 1].timestamp.getTime(),
    );

    assert('three lifecycle rows recorded', auditLogs.length === 3, `${auditLogs.length} rows`);
    assert('policy_engine step present', actors.includes('policy_engine'), `actors=[${actors.join(', ')}]`);
    assert('action_executor step present', actors.includes('action_executor'), 'executor logged');
    assert('webhook step present', actors.includes('webhook'), 'webhook logged');
    assert('rows are chronological', isChronological, 'timestamps non-decreasing');
    assert('every eventId is unique', new Set(eventIds).size === eventIds.length, `${new Set(eventIds).size}/${eventIds.length} unique`);
    assert('webhook row keyed by Razorpay eventId', eventIds.includes(eventId), 'idempotency key retained');
    assert(
      'webhook row records recovery',
      auditLogs.some((l) => l.actor === 'webhook' && l.result === 'recovered'),
      'result=recovered',
    );
  } finally {
    // Cleanup lives here so an assertion throw mid-trace can never leak the
    // trace record (or its audit rows) into the frozen benchmark dataset.
    await prisma.auditLog.deleteMany({ where: { transactionId: transaction.id } });
    await prisma.transaction.delete({ where: { id: transaction.id } }).catch(() => {});
    console.log('  🧹 Cleanup: trace transaction and its audit rows deleted.');
  }

  console.log('\n' + hr('═'));
  if (failures === 0) {
    console.log('  ✅ END-TO-END TRACE VALIDATION: PASS');
    console.log('     Verified Policy -> Executor -> Webhook -> Idempotent Audit Trail, with assertions.');
  } else {
    console.log(`  ❌ END-TO-END TRACE VALIDATION: FAIL — ${failures} assertion(s) failed.`);
  }
  console.log(hr('═') + '\n');
  if (failures > 0) process.exit(1);
}

runEndToEndTrace()
  .catch((e) => {
    console.error('Trace execution failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
