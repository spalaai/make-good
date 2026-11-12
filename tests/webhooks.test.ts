import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createPayPalWebhookVerifier } from "../server/adapters/paypal/webhook.js";
import { resetPayPalTokenCacheForTests } from "../server/adapters/paypal/http.js";
import { listAudit } from "../server/domain/audit.js";
import { approveIncident } from "../server/domain/execute.js";
import { listLedger } from "../server/domain/ledger.js";
import { proposeIncident } from "../server/domain/propose.js";
import { getIncident } from "../server/domain/repo.js";
import { handleWebhook } from "../server/domain/webhooks.js";
import { createHandler } from "../server/routes.js";
import { OWNER, makeCtx, seedFixture } from "./helpers.js";

const event = (id: string, type = "CUSTOMER.DISPUTE.RESOLVED", disputeId = "MG-DISPUTE-1") => ({ id, event_type: type, resource: { dispute_id: disputeId } });
const yes = async () => true;

async function offerMade() {
  const ctx = makeCtx();
  const { incident } = seedFixture(ctx, "never-delivered", { disputeId: "MG-DISPUTE-1" });
  const p = await proposeIncident(ctx, incident.id, { name: "make-good", role: "system" });
  await approveIncident(ctx, p.id, p.approvalHash!, OWNER);
  return { ctx, id: p.id };
}

describe("webhooks", () => {
  it("refuses every delivery when nothing can verify it", async () => {
    const { ctx, id } = await offerMade();
    ctx.payments.buyerAccepts("MG-DISPUTE-1");
    const out = await handleWebhook(ctx, {}, event("E1"));
    expect(out.status).toBe(401);
    expect(getIncident(ctx.db, id)!.status).toBe("offer_made");
    expect(listAudit(ctx.db).some((a) => a.event === "webhook_rejected")).toBe(true);
  });

  it("refuses a delivery the verifier says is not from PayPal", async () => {
    const { ctx, id } = await offerMade();
    ctx.webhookVerifier = async () => false;
    ctx.payments.buyerAccepts("MG-DISPUTE-1");
    expect((await handleWebhook(ctx, {}, event("E1"))).status).toBe(401);
    expect(getIncident(ctx.db, id)!.status).toBe("offer_made");
  });

  it("a verified dispute event makes the app read the dispute again and settle", async () => {
    const { ctx, id } = await offerMade();
    ctx.webhookVerifier = yes;
    ctx.payments.buyerAccepts("MG-DISPUTE-1");
    const out = await handleWebhook(ctx, {}, event("E1"));
    expect(out.status).toBe(200);
    expect(getIncident(ctx.db, id)!.status).toBe("done");
    expect(listLedger(ctx.db).length).toBeGreaterThan(0);
  });

  it("does not trust the event's own words: an event that says resolved changes nothing if PayPal still shows the offer waiting", async () => {
    const { ctx, id } = await offerMade();
    ctx.webhookVerifier = yes;
    await handleWebhook(ctx, {}, { ...event("E2"), resource: { dispute_id: "MG-DISPUTE-1", status: "RESOLVED", outcome: { outcome_code: "RESOLVED_BUYER_FAVOUR" } } });
    expect(getIncident(ctx.db, id)!.status).toBe("offer_made");
    expect(listLedger(ctx.db)).toHaveLength(0);
  });

  it("handles the same event id once", async () => {
    const { ctx } = await offerMade();
    ctx.webhookVerifier = yes;
    expect((await handleWebhook(ctx, {}, event("E3"))).body.note).toBe("Synced.");
    expect((await handleWebhook(ctx, {}, event("E3"))).body.note).toBe("Already handled.");
    expect(listAudit(ctx.db).filter((a) => a.event === "webhook_received")).toHaveLength(1);
  });

  it("ignores other event types and unknown disputes without error", async () => {
    const { ctx } = await offerMade();
    ctx.webhookVerifier = yes;
    expect((await handleWebhook(ctx, {}, event("E4", "PAYMENT.CAPTURE.COMPLETED"))).body.note).toBe("Ignored event type.");
    expect((await handleWebhook(ctx, {}, event("E5", "CUSTOMER.DISPUTE.CREATED", "PP-R-OTHER"))).body.note).toBe("No incident for that dispute.");
    expect((await handleWebhook(ctx, {}, { type: "x" })).status).toBe(400);
  });

  describe("the HTTP route", () => {
    let server: Server;
    let base = "";
    let ctxRef: Awaited<ReturnType<typeof offerMade>>["ctx"];
    beforeAll(async () => {
      const { ctx } = await offerMade();
      ctxRef = ctx;
      server = createServer((req, res) => void createHandler(ctx)(req, res));
      await new Promise<void>((r) => server.listen(0, r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(() => server.close());

    it("needs no login but refuses an unverified delivery", async () => {
      const res = await fetch(`${base}/api/webhooks/paypal`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(event("H1")) });
      expect(res.status).toBe(401);
      expect(ctxRef.db.prepare("SELECT COUNT(*) AS n FROM webhook_events").get()).toEqual({ n: 0 });
    });
  });

  describe("the PayPal verifier", () => {
    const headers = { "paypal-transmission-id": "t1", "paypal-transmission-sig": "sig", "paypal-transmission-time": "now", "paypal-cert-url": "https://api.sandbox.paypal.com/cert", "paypal-auth-algo": "SHA256withRSA" };
    const fake = (status: string, calls: unknown[]) =>
      (async (url: string, init: RequestInit = {}) => {
        if (String(url).endsWith("/v1/oauth2/token")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
        calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ verification_status: status }), { status: 200 });
      }) as unknown as typeof fetch;

    it("asks PayPal, with the webhook id, and accepts only SUCCESS", async () => {
      process.env.PAYPAL_CLIENT_ID = "i";
      process.env.PAYPAL_CLIENT_SECRET = "s";
      resetPayPalTokenCacheForTests();
      const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
      expect(await createPayPalWebhookVerifier("WH-1", fake("SUCCESS", calls))(headers, event("E"))).toBe(true);
      expect(calls[0].url).toMatch(/verify-webhook-signature$/);
      expect(calls[0].body).toMatchObject({ webhook_id: "WH-1", transmission_id: "t1", auth_algo: "SHA256withRSA" });
      expect(await createPayPalWebhookVerifier("WH-1", fake("FAILURE", []))(headers, event("E"))).toBe(false);
    });

    it("says no without a webhook id or without the signature headers", async () => {
      expect(await createPayPalWebhookVerifier(undefined, fake("SUCCESS", []))(headers, event("E"))).toBe(false);
      expect(await createPayPalWebhookVerifier("WH-1", fake("SUCCESS", []))({}, event("E"))).toBe(false);
    });
  });
});
