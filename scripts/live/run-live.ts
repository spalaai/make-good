/**
 * Runs Make Good's own code against the real PayPal SANDBOX (play money) and writes the ids it got to docs/live/.
 *
 *   npx tsx scripts/live/run-live.ts payout
 *   npx tsx scripts/live/run-live.ts refund  <captureId>
 *   npx tsx scripts/live/run-live.ts dispute <disputeId>      (a dispute the sandbox buyer already filed)
 *
 * Needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (sandbox) in the environment or .env, and SANDBOX_BUYER_EMAIL for the payout path.
 * Optional: GEMINI_API_KEY with AI_PROVIDER=gemini for a live AI proposal. Nothing secret is printed or written.
 * The "dispute" path stops and waits for the buyer to accept the offer on PayPal's page.
 */
import "../../server/loadEnv.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createAiAdapter } from "../../server/adapters/index.js";
import { SandboxPayPalAdapter } from "../../server/adapters/paypal/sandbox.js";
import { paypalFetch } from "../../server/adapters/paypal/http.js";
import { migrate, openDatabase } from "../../server/db.js";
import { loadPolicy } from "../../server/domain/policy.js";
import { ensureDemoUsers } from "../../server/domain/users.js";
import { openIncident, recordPurchase } from "../../server/domain/intake.js";
import { proposeIncident } from "../../server/domain/propose.js";
import { approveIncident } from "../../server/domain/execute.js";
import { syncIncidentDispute } from "../../server/domain/disputes.js";
import { workerTick } from "../../server/domain/worker.js";
import { listLedger } from "../../server/domain/ledger.js";
import { getPayoutForIncident } from "../../server/domain/payouts.js";
import { listAudit } from "../../server/domain/audit.js";
import { getIncident } from "../../server/domain/repo.js";
import type { Ctx } from "../../server/domain/ctx.js";
import { FIXTURES, FIXTURE_MERCHANT, FIXTURE_OPERATOR } from "../../server/fixtures.js";

const [path, arg] = process.argv.slice(2);
if (!["payout", "refund", "dispute"].includes(path ?? "")) {
  console.error("Usage: run-live.ts payout | refund <captureId> | dispute <disputeId>");
  process.exit(2);
}
const OWNER = { name: "owner", role: "owner" as const };
const AGENT = { name: "agent", role: "agent" as const };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const maskEmail = (e: string | null | undefined) => (e ? e.replace(/^(.{3}).*(@.*)$/, "$1***$2") : e);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
mkdirSync("data", { recursive: true });
const dbPath = `data/live-${path}-${stamp}.db`;
const db = openDatabase(dbPath);
migrate(db);
ensureDemoUsers(db);
const payments = new SandboxPayPalAdapter();
const ai = createAiAdapter({ ...process.env, AI_FALLBACK: "error" });
const ctx: Ctx = { db, ai, payments, policy: loadPolicy() };

const events: Array<{ at: string; step: string; detail: Record<string, unknown> }> = [];
const log = (step: string, detail: Record<string, unknown> = {}) => {
  events.push({ at: new Date().toISOString(), step, detail });
  console.log(`${new Date().toISOString()} ${step} ${JSON.stringify(detail)}`);
};

/** The fixture's records with every price rewritten to the live amount, so the text matches the money that moves. */
function recordsFor(key: string, priceText: string) {
  const f = FIXTURES.find((x) => x.key === key)!;
  return { f, records: f.records.map((r) => ({ ...r, text: r.text.replace(/\$\d+\.\d\d/g, priceText) })) };
}

async function run() {
  log("start", { path, payments: payments.modeLabel, ai: ai.modeLabel, db: dbPath });
  if (payments.mode !== "sandbox") throw new Error("Not in sandbox mode. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.");

  let key: string, amountCents: number, buyerEmail: string | null = null, captureId: string | null = null, disputeId: string | null = null;
  if (path === "payout") {
    key = "wrong-edition";
    amountCents = 100;
    buyerEmail = process.env.SANDBOX_BUYER_EMAIL ?? null;
    if (!buyerEmail) throw new Error("Set SANDBOX_BUYER_EMAIL to the throwaway sandbox buyer's email.");
  } else if (path === "refund") {
    key = "never-delivered";
    amountCents = 100;
    captureId = arg ?? null;
    if (!captureId) throw new Error("Give the capture id to refund (sandbox).");
  } else {
    key = "never-delivered";
    disputeId = arg ?? null;
    if (!disputeId) throw new Error("Give the sandbox dispute id the buyer filed.");
    const d = await payments.getDispute(disputeId);
    amountCents = d.amountCents; // the dispute is for the whole purchase, so the offer covers it all
    log("dispute_found", { disputeId, status: d.status, amountCents: d.amountCents, allowed: d.allowedActions });
  }
  const { f, records } = recordsFor(key, `$${(amountCents / 100).toFixed(2)}`);
  const purchase = recordPurchase(
    ctx,
    { orderId: `live-${stamp}`, captureId, amountCents, buyerEmail, merchantName: FIXTURE_MERCHANT, operatorName: FIXTURE_OPERATOR, fixtureKey: f.key, records },
    AGENT,
  );
  const incident0 = openIncident(ctx, { purchaseId: purchase.id, complaint: f.complaint, disputeId }, AGENT);
  log("incident_opened", { incidentId: incident0.id });

  const proposed = await proposeIncident(ctx, incident0.id, { name: "make-good", role: "system" });
  log("proposed", {
    status: proposed.status,
    fault: proposed.proposal?.fault,
    confidence: proposed.proposal?.confidence,
    remedy: proposed.remedy,
    amountCents: proposed.amountCents,
    aiSource: proposed.aiSource,
    citationsOk: proposed.decision?.checks.find((c) => c.id === "quotes_verbatim")?.passed,
  });
  if (proposed.status !== "needs_owner") throw new Error(`The rule did not route to the owner: ${proposed.status} ${proposed.decision?.abstainReason ?? ""}`);
  const expect = path === "payout" ? "operator_payout" : "merchant_refund";
  if (proposed.remedy !== expect) throw new Error(`Expected ${expect}, the rule chose ${proposed.remedy}.`);

  // The owner approves the exact action. Here the script plays the owner with the token the app gave for this proposal.
  const afterApprove = await approveIncident(ctx, proposed.id, proposed.approvalHash!, OWNER);
  log("approved", { status: afterApprove.status });
  if (path === "payout") {
    const p = getPayoutForIncident(db, proposed.id);
    log("payout_row", { senderBatchId: p?.senderBatchId, senderItemId: p?.senderItemId, status: p?.status, paypalBatchId: p?.paypalBatchId });
  }

  const deadline = Date.now() + (path === "dispute" ? 25 * 60_000 : 3 * 60_000);
  let last = "";
  while (Date.now() < deadline) {
    let inc = getIncident(db, proposed.id)!;
    if (path === "dispute") inc = await syncIncidentDispute(ctx, inc);
    await workerTick(ctx);
    inc = getIncident(db, proposed.id)!;
    const line = `${inc.status} dispute=${inc.disputeStatus ?? "-"}`;
    if (line !== last) log("status", { status: inc.status, dispute: inc.disputeStatus });
    last = line;
    if (inc.status === "offer_made" && !events.some((e) => e.step === "waiting_for_buyer")) {
      log("waiting_for_buyer", { note: "The buyer must accept the offer on PayPal's page. Run scripts/sandbox/g1-accept.mjs with the dispute id." });
    }
    if (["done", "closed", "failed", "rejected"].includes(inc.status)) break;
    await sleep(path === "dispute" ? 15_000 : 5_000);
  }

  const inc = getIncident(db, proposed.id)!;
  const payout = getPayoutForIncident(db, proposed.id);
  const evidence: Record<string, unknown> = { finalStatus: inc.status, refundId: inc.refundId, disputeId: inc.disputeId, payout: payout && { ...payout, receiverEmail: maskEmail(payout.receiverEmail) } };

  // Ask PayPal directly, outside the app's own bookkeeping, so the evidence does not rest on the app alone.
  if (payout?.paypalBatchId) {
    const r = await paypalFetch(fetch, `/v1/payments/payouts/${payout.paypalBatchId}`);
    const j = (await r.json()) as { batch_header?: { batch_status?: string }; items?: Array<{ transaction_status?: string; payout_item_id?: string; transaction_id?: string }> };
    evidence.paypalSays = { http: r.status, batchStatus: j.batch_header?.batch_status, itemStatus: j.items?.[0]?.transaction_status, itemId: j.items?.[0]?.payout_item_id, transactionId: j.items?.[0]?.transaction_id };
  }
  if (inc.refundId) {
    const r = await paypalFetch(fetch, `/v2/payments/refunds/${inc.refundId}`);
    const j = (await r.json()) as { status?: string; amount?: { value?: string } };
    evidence.paypalSays = { http: r.status, refundStatus: j.status, amount: j.amount?.value };
  }
  if (inc.disputeId) {
    const d = await payments.getDispute(inc.disputeId);
    evidence.paypalSays = { disputeStatus: d.status, outcome: d.outcome, refundedCents: d.refundedCents };
  }
  // Resend the saved ids on purpose: PayPal should refuse the reused sender_batch_id, and the app should find the original batch from its answer.
  if (path === "payout" && payout) {
    const again = await payments.createPayout({
      senderBatchId: payout.senderBatchId,
      senderItemId: payout.senderItemId,
      requestId: payout.requestId,
      receiverEmail: payout.receiverEmail,
      amountCents: payout.amountCents,
      note: "resend check",
    });
    evidence.resendWithSameSenderBatchId = { outcome: again.outcome, foundOriginalBatch: again.paypalBatchId === payout.paypalBatchId, paypalBatchId: again.paypalBatchId };
    log("resend_same_sender_batch_id", evidence.resendWithSameSenderBatchId as Record<string, unknown>);
  }
  const out = {
    path,
    ranAt: new Date().toISOString(),
    note: "PayPal sandbox, play money. Records are synthetic text written for the demo. Emails are masked.",
    ai: { mode: ai.modeLabel, source: inc.aiSource },
    proposal: inc.proposal,
    decision: inc.decision && { remedy: inc.decision.remedy, amountCents: inc.amountCents, capped: inc.decision.capped, checks: inc.decision.checks.map((c) => ({ id: c.id, passed: c.passed })) },
    evidence,
    ledger: listLedger(db).map(({ account, amountCents: a, kind, ref, label }) => ({ account, amountCents: a, kind, ref, label })),
    audit: listAudit(db, 100).reverse().map((a) => ({ at: a.at, actor: a.actor, event: a.event })),
    events,
  };
  const file = `docs/live/live-${path}-${stamp}.json`;
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log(`Evidence written to ${file}`);
  if (inc.status !== "done") process.exitCode = 1;
}

run()
  .catch((e) => {
    console.error("FAILED:", String((e as Error).message).slice(0, 400));
    process.exitCode = 1;
  })
  .finally(() => {
    if (process.env.KEEP_LIVE_DB !== "true" && process.exitCode === 0) rmSync(dbPath, { force: true });
  });
