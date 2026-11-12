import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHandler, createCtx } from "../server/routes.js";
import { MockAiAdapter } from "../server/adapters/ai-mock.js";
import { MockPayPalAdapter } from "../server/adapters/paypal/mock.js";
import { migrate, openDatabase } from "../server/db.js";
import { ensureDemoUsers } from "../server/domain/users.js";
import { FIXTURES, FIXTURE_MERCHANT, FIXTURE_OPERATOR } from "../server/fixtures.js";

let server: Server;
let base = "";
const payments = new MockPayPalAdapter();

async function api(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(base + path, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: { "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as any };
}

beforeAll(async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  ensureDemoUsers(db);
  const ctx = createCtx(db, { payments, ai: new MockAiAdapter() });
  server = createServer((req, res) => void createHandler(ctx)(req, res));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const login = async (username: string, password: string) => (await api("/api/login", { body: { username, password } })).json.token as string;

describe("HTTP API", () => {
  it("needs a login and refuses a wrong password", async () => {
    expect((await api("/api/incidents")).status).toBe(401);
    expect((await api("/api/login", { body: { username: "owner", password: "nope" } })).status).toBe(401);
  });

  it("agent files a purchase and complaint, the owner approves, the money line shows up", async () => {
    const agent = await login("agent", "agent-demo");
    const owner = await login("owner", "owner-demo");
    const f = FIXTURES.find((x) => x.key === "wrong-edition")!;
    const p = await api("/api/purchases", {
      token: agent,
      body: { orderId: f.orderId, captureId: f.captureId, amountCents: f.amountCents, buyerEmail: "buyer@example.test", merchantName: FIXTURE_MERCHANT, operatorName: FIXTURE_OPERATOR, fixtureKey: f.key, records: f.records },
    });
    expect(p.status).toBe(201);
    const inc = await api("/api/incidents", { token: agent, body: { purchaseId: p.json.id, complaint: f.complaint } });
    expect(inc.status).toBe(201);

    const proposed = await api(`/api/incidents/${inc.json.id}/propose`, { token: agent, method: "POST", body: {} });
    expect(proposed.json.status).toBe("needs_owner");
    expect(proposed.json.approvalToken).toBeNull(); // the agent is not given the owner's token
    expect(proposed.json.quotes.every((q: { ok: boolean }) => q.ok)).toBe(true);
    expect("approvalHash" in proposed.json).toBe(false);

    const asOwner = await api(`/api/incidents/${inc.json.id}`, { token: owner });
    const token = asOwner.json.approvalToken as string;
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    expect((await api(`/api/incidents/${inc.json.id}/approve`, { token: agent, body: { approvalToken: token } })).status).toBe(403);
    expect((await api(`/api/incidents/${inc.json.id}/approve`, { token: owner, body: { approvalToken: "bad" } })).status).toBe(409);

    const ok = await api(`/api/incidents/${inc.json.id}/approve`, { token: owner, body: { approvalToken: token } });
    expect(ok.status).toBe(200);
    expect(["payout_sent", "done"]).toContain(ok.json.status);
    expect(ok.json.payout.senderBatchId).toMatch(/^mg_batch_/);

    const sync = await api(`/api/incidents/${inc.json.id}/sync`, { token: owner, body: {} });
    expect(sync.status).toBe(200);
    const ledger = await api("/api/ledger", { token: owner });
    expect(ledger.json.payouts).toHaveLength(1);
  });

  it("the mock buyer shortcut is for the owner in mock mode only", async () => {
    const agent = await login("agent", "agent-demo");
    expect((await api("/api/dev/buyer-accepts", { token: agent, body: { disputeId: "MG-DISPUTE-1" } })).status).toBe(404);
  });

  it("rejects a bad purchase", async () => {
    const agent = await login("agent", "agent-demo");
    expect((await api("/api/purchases", { token: agent, body: { orderId: "x" } })).status).toBe(400);
  });

  it("reports the modes and the policy without a login", async () => {
    const m = await api("/api/mode");
    expect(m.json.paymentsMode).toBe("mock");
    expect(m.json.policy.operatorGuaranteeCapCents).toBe(2500);
  });
});
