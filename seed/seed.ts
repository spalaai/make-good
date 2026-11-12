import "../server/loadEnv.js";
import { DEFAULT_DB_PATH, migrate, openDatabase } from "../server/db.js";
import { FIXTURES, FIXTURE_MERCHANT, FIXTURE_OPERATOR } from "../server/fixtures.js";
import { ensureDemoUsers } from "../server/domain/users.js";
import { openIncident, recordPurchase } from "../server/domain/intake.js";
import { createCtx } from "../server/routes.js";
import { MockPayPalAdapter } from "../server/adapters/paypal/mock.js";
import { MockAiAdapter } from "../server/adapters/ai-mock.js";
import { loadPolicy } from "../server/domain/policy.js";

// Four example purchases that went wrong. Records are plain text written for the demo.
const path = process.env.MG_DB_PATH ?? DEFAULT_DB_PATH;
const db = openDatabase(path);
migrate(db);
ensureDemoUsers(db);
const existing = (db.prepare("SELECT COUNT(*) AS n FROM purchases").get() as { n: number }).n;
if (existing > 0) {
  console.log(`Database at ${path} already has ${existing} purchases. Delete it to start over.`);
  process.exit(0);
}
const ctx = createCtx(db, { payments: new MockPayPalAdapter(), ai: new MockAiAdapter(), policy: loadPolicy() });
const buyerEmail = process.env.SANDBOX_BUYER_EMAIL ?? "buyer@example.test";
const disputeFor: Record<string, string> = { "never-delivered": "MG-DISPUTE-1", "false-claim": "MG-DISPUTE-3" };
for (const f of FIXTURES) {
  const purchase = recordPurchase(
    ctx,
    { orderId: f.orderId, captureId: f.captureId, amountCents: f.amountCents, buyerEmail, merchantName: FIXTURE_MERCHANT, operatorName: FIXTURE_OPERATOR, fixtureKey: f.key, records: f.records },
    { name: "agent", role: "agent" },
  );
  openIncident(ctx, { purchaseId: purchase.id, complaint: f.complaint, disputeId: disputeFor[f.key] ?? null }, { name: "agent", role: "agent" });
}
console.log(`Seeded ${FIXTURES.length} purchases and incidents into ${path}.`);
