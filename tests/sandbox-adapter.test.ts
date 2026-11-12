import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PAYPAL_SANDBOX_HOST } from "../server/adapters/paypal/constants.js";
import { PayPalHostError, assertAllowedPayPalUrl, resetPayPalTokenCacheForTests } from "../server/adapters/paypal/http.js";
import { SandboxPayPalAdapter, batchIdFromLinks, isDuplicateBatchError, mapDispute, mapPayoutItem } from "../server/adapters/paypal/sandbox.js";

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function fakeFetch(answers: Array<{ status: number; body: unknown }>, calls: Call[]): typeof fetch {
  let i = 0;
  return (async (url: string, init: RequestInit = {}) => {
    if (String(url).endsWith("/v1/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
    }
    calls.push({ url: String(url), method: String(init.method ?? "GET"), headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : null });
    const a = answers[Math.min(i++, answers.length - 1)];
    return new Response(JSON.stringify(a.body), { status: a.status });
  }) as unknown as typeof fetch;
}

const saved = { id: process.env.PAYPAL_CLIENT_ID, secret: process.env.PAYPAL_CLIENT_SECRET };
beforeEach(() => {
  process.env.PAYPAL_CLIENT_ID = "test-id";
  process.env.PAYPAL_CLIENT_SECRET = "test-secret";
  resetPayPalTokenCacheForTests();
});
afterEach(() => {
  process.env.PAYPAL_CLIENT_ID = saved.id;
  process.env.PAYPAL_CLIENT_SECRET = saved.secret;
  if (saved.id === undefined) delete process.env.PAYPAL_CLIENT_ID;
  if (saved.secret === undefined) delete process.env.PAYPAL_CLIENT_SECRET;
});

const payoutInput = { senderBatchId: "mg_batch_1", senderItemId: "mg_item_1", requestId: "mg-req-1", receiverEmail: "buyer@example.test", amountCents: 100, note: "n" };

describe("sandbox adapter", () => {
  it("only talks to the sandbox host", () => {
    expect(PAYPAL_SANDBOX_HOST).toBe("api-m.sandbox.paypal.com");
    expect(() => assertAllowedPayPalUrl("https://api-m.paypal.com/v1/payments/payouts")).toThrow(PayPalHostError);
    expect(() => assertAllowedPayPalUrl("https://example.com/")).toThrow(PayPalHostError);
    expect(() => assertAllowedPayPalUrl("https://api-m.sandbox.paypal.com/v1/payments/payouts")).not.toThrow();
  });

  it("sends a payout with the saved ids and the request id", async () => {
    const calls: Call[] = [];
    const a = new SandboxPayPalAdapter(fakeFetch([{ status: 201, body: { batch_header: { payout_batch_id: "B1", batch_status: "PENDING" } } }], calls));
    const r = await a.createPayout(payoutInput);
    expect(r).toEqual({ outcome: "created", paypalBatchId: "B1", batchStatus: "PENDING" });
    const body = calls[0].body as { sender_batch_header: { sender_batch_id: string }; items: Array<{ sender_item_id: string; amount: { value: string }; recipient_type: string }> };
    expect(body.sender_batch_header.sender_batch_id).toBe("mg_batch_1");
    expect(body.items[0]).toMatchObject({ sender_item_id: "mg_item_1", recipient_type: "EMAIL", amount: { value: "1.00" } });
    expect(calls[0].headers["PayPal-Request-Id"]).toBe("mg-req-1");
  });

  it("reads PayPal's duplicate sender_batch_id answer as 'look it up', not as a failure", async () => {
    const dup = {
      name: "USER_BUSINESS_ERROR",
      message: "Business error",
      // The shape the real sandbox answered with: the link sits inside details, the top level links array is empty.
      details: [
        {
          field: "SENDER_BATCH_ID",
          location: "body",
          issue: "Batch with given sender_batch_id already exists",
          link: [{ href: "https://api.sandbox.paypal.com/v1/payments/payouts/B1", rel: "self", method: "GET" }],
        },
      ],
      links: [],
    };
    const a = new SandboxPayPalAdapter(fakeFetch([{ status: 400, body: dup }], []));
    expect(await a.createPayout(payoutInput)).toEqual({ outcome: "duplicate", paypalBatchId: "B1", batchStatus: null });
    expect(isDuplicateBatchError(400, dup)).toBe(true);
    expect(isDuplicateBatchError(400, { name: "VALIDATION_ERROR" })).toBe(false);
    expect(batchIdFromLinks({ links: [] })).toBeNull();
    expect(batchIdFromLinks({ links: [{ href: "https://api-m.sandbox.paypal.com/v1/payments/payouts/B2" }] })).toBe("B2");
  });

  it("treats a 5xx on payout as unknown, never as failed", async () => {
    const a = new SandboxPayPalAdapter(fakeFetch([{ status: 503, body: {} }], []));
    expect((await a.createPayout(payoutInput)).outcome).toBe("unknown");
  });

  it("raises other payout errors", async () => {
    const a = new SandboxPayPalAdapter(fakeFetch([{ status: 400, body: { name: "VALIDATION_ERROR" } }], []));
    await expect(a.createPayout(payoutInput)).rejects.toThrow(/payout failed/);
  });

  it("follows the payout item, not the batch", async () => {
    const a = new SandboxPayPalAdapter(
      fakeFetch([{ status: 200, body: { batch_header: { batch_status: "PROCESSING" }, items: [{ transaction_status: "SUCCESS", payout_item_id: "I1", transaction_id: "T1" }] } }], []),
    );
    const s = await a.getPayoutBatch("B1");
    expect(s).toMatchObject({ batchStatus: "PROCESSING", item: "success", paypalItemId: "I1", transactionId: "T1" });
    expect(mapPayoutItem("PENDING")).toBe("pending");
    expect(mapPayoutItem("RETURNED")).toBe("failed");
  });

  it("makes a REFUND offer with a partial amount and never an accept call", async () => {
    const calls: Call[] = [];
    const a = new SandboxPayPalAdapter(fakeFetch([{ status: 200, body: {} }], calls));
    const r = await a.makeOffer({ disputeId: "PP-R-1", amountCents: 1200, note: "n", idempotencyKey: "k" });
    expect(r.outcome).toBe("made");
    expect(calls[0].url).toMatch(/\/v1\/customer\/disputes\/PP-R-1\/make-offer$/);
    expect(calls[0].body).toMatchObject({ offer_type: "REFUND", offer_amount: { value: "12.00", currency_code: "USD" } });
    expect(Object.getOwnPropertyNames(SandboxPayPalAdapter.prototype).some((n) => /accept/i.test(n))).toBe(false);
  });

  it("maps a dispute with its allowed actions, offer types and outcome", () => {
    const d = mapDispute({
      dispute_id: "PP-R-1",
      status: "RESOLVED",
      dispute_amount: { value: "20.00", currency_code: "USD" },
      links: [{ rel: "self" }, { rel: "make_offer" }],
      allowed_response_options: { make_offer: { offer_types: ["REFUND"] } },
      dispute_outcome: { outcome_code: "RESOLVED_BUYER_FAVOUR", amount_refunded: { value: "12.00" } },
    });
    expect(d).toMatchObject({ amountCents: 2000, allowedActions: ["make_offer"], offerTypes: ["REFUND"], outcome: "RESOLVED_BUYER_FAVOUR", refundedCents: 1200 });
  });

  it("sends evidence and messages in the documented shape (mocked fetch, not run against the real sandbox)", async () => {
    const calls: Call[] = [];
    const a = new SandboxPayPalAdapter(fakeFetch([{ status: 200, body: {} }], calls));
    expect((await a.provideEvidence({ disputeId: "PP-R-1", notes: "n".repeat(3000), idempotencyKey: "k1" })).outcome).toBe("sent");
    expect(calls[0].url).toMatch(/\/v1\/customer\/disputes\/PP-R-1\/provide-evidence$/);
    const ev = calls[0].body as { evidences: Array<{ evidence_type: string; notes: string }> };
    expect(ev.evidences[0].evidence_type).toBe("OTHER");
    expect(ev.evidences[0].notes.length).toBe(2000);
    expect(calls[0].headers["PayPal-Request-Id"]).toBe("k1");
    expect((await a.sendMessage({ disputeId: "PP-R-1", message: "hello", idempotencyKey: "k2" })).outcome).toBe("sent");
    expect(calls[1].url).toMatch(/\/send-message$/);
    expect(calls[1].body).toEqual({ message: "hello" });
  });

  it("treats a 5xx on evidence as unknown and any other error as an error", async () => {
    expect((await new SandboxPayPalAdapter(fakeFetch([{ status: 503, body: {} }], [])).provideEvidence({ disputeId: "x", notes: "n", idempotencyKey: "k" })).outcome).toBe("unknown");
    await expect(new SandboxPayPalAdapter(fakeFetch([{ status: 422, body: { name: "X" } }], [])).sendMessage({ disputeId: "x", message: "m", idempotencyKey: "k" })).rejects.toThrow(/422/);
  });
});

describe("source guard", () => {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) files.push(p);
    }
  };
  walk(join(import.meta.dirname, "..", "server"));

  it("no server code calls accept-claim or accept-offer", () => {
    // friendly.ts only lists the tool names it must keep out of user-facing text.
    for (const f of files.filter((x) => !x.endsWith("friendly.ts"))) {
      const t = readFileSync(f, "utf8");
      expect(/accept[-_]claim|accept[-_]offer|acceptClaim/.test(t), f).toBe(false);
    }
  });

  it("no server code calls a production PayPal host", () => {
    for (const f of files.filter((x) => !x.endsWith("http.ts"))) {
      expect(/api-m\.paypal\.com|api\.paypal\.com/.test(readFileSync(f, "utf8")), f).toBe(false);
    }
  });

  it("finds the newest completed refund of the right amount on an order, and ignores failed ones (shape seen in the real run)", async () => {
    const order = {
      purchase_units: [{ payments: { refunds: [
        { id: "R-FAILED", status: "FAILED", amount: { value: "19.02" }, create_time: "2026-10-18T18:04:03-07:00" },
        { id: "R-OLD", status: "COMPLETED", amount: { value: "20.00" }, create_time: "2026-10-18T18:01:00-07:00" },
        { id: "R-NEW", status: "COMPLETED", amount: { value: "20.00" }, create_time: "2026-10-18T18:05:19-07:00" },
      ] } }],
    };
    const calls: Call[] = [];
    const a = new SandboxPayPalAdapter(fakeFetch([{ status: 200, body: order }, { status: 200, body: order }], calls));
    expect((await a.findRefund({ orderId: "O-1", amountCents: 2000 }))?.refundId).toBe("R-NEW");
    expect(await a.findRefund({ orderId: "O-1", amountCents: 1900 })).toBeNull();
    expect(calls[0].url).toMatch(/\/v2\/checkout\/orders\/O-1$/);
  });
});
