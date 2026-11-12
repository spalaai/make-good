import { MockAiAdapter } from "../server/adapters/ai-mock.js";
import { MockPayPalAdapter } from "../server/adapters/paypal/mock.js";
import { migrate, openDatabase } from "../server/db.js";
import type { Ctx } from "../server/domain/ctx.js";
import { openIncident, recordPurchase } from "../server/domain/intake.js";
import { DEFAULT_POLICY } from "../server/domain/policy.js";
import { ensureDemoUsers } from "../server/domain/users.js";
import { FIXTURES, FIXTURE_MERCHANT, FIXTURE_OPERATOR } from "../server/fixtures.js";

export const OWNER = { name: "owner", role: "owner" as const };
export const AGENT = { name: "agent", role: "agent" as const };

export function makeCtx(over: Partial<Ctx> = {}): Ctx & { payments: MockPayPalAdapter } {
  const db = openDatabase(":memory:");
  migrate(db);
  ensureDemoUsers(db);
  return { db, ai: new MockAiAdapter(), payments: new MockPayPalAdapter(), policy: DEFAULT_POLICY, ...over } as Ctx & { payments: MockPayPalAdapter };
}

export function seedFixture(ctx: Ctx, key: string, opts: { disputeId?: string | null; buyerEmail?: string | null; amountCents?: number } = {}) {
  const f = FIXTURES.find((x) => x.key === key)!;
  const purchase = recordPurchase(
    ctx,
    {
      orderId: f.orderId,
      captureId: f.captureId,
      amountCents: opts.amountCents ?? f.amountCents,
      buyerEmail: opts.buyerEmail === undefined ? "buyer@example.test" : opts.buyerEmail,
      merchantName: FIXTURE_MERCHANT,
      operatorName: FIXTURE_OPERATOR,
      fixtureKey: f.key,
      records: f.records,
    },
    AGENT,
  );
  const incident = openIncident(ctx, { purchaseId: purchase.id, complaint: f.complaint, disputeId: opts.disputeId ?? null }, AGENT);
  return { purchase, incident };
}
