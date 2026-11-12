import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { DEMO_SALT, hashPassword, signToken, verifyToken, type SessionPayload } from "./auth.js";
import { createAiAdapter, createPaymentsAdapter } from "./adapters/index.js";
import { MockPayPalAdapter } from "./adapters/paypal/mock.js";
import type { AiAdapter } from "./adapters/ai.js";
import type { PaymentsAdapter } from "./adapters/payments.js";
import { appendAudit, listAudit } from "./domain/audit.js";
import { DomainError, type Actor, type Ctx } from "./domain/ctx.js";
import { syncAllDisputes, syncIncidentDispute } from "./domain/disputes.js";
import { approveIncident, executeIncident, rejectIncident } from "./domain/execute.js";
import { addEvidence } from "./domain/evidence.js";
import { openIncident, recordPurchase } from "./domain/intake.js";
import { listLedger, totalsByAccount } from "./domain/ledger.js";
import { getPayoutForIncident, listPayouts } from "./domain/payouts.js";
import { loadPolicy } from "./domain/policy.js";
import { proposeIncident } from "./domain/propose.js";
import { getIncident, getPurchase, listIncidents, listPurchases, type Incident } from "./domain/repo.js";
import { createPayPalWebhookVerifier } from "./adapters/paypal/webhook.js";
import { handleWebhook } from "./domain/webhooks.js";
import { verifyQuotes } from "./domain/rules.js";
import { buildEvidenceNote } from "./domain/execute.js";
import { FRIENDLY, logTechnical } from "./domain/friendly.js";

export function createCtx(db: DatabaseSync, overrides: Partial<Omit<Ctx, "db">> = {}): Ctx {
  const payments = overrides.payments ?? createPaymentsAdapter();
  return {
    db,
    ai: overrides.ai ?? createAiAdapter(),
    payments,
    policy: overrides.policy ?? loadPolicy(),
    // Without a webhook id, or in mock mode, no delivery can be verified, so every one is refused.
    webhookVerifier: overrides.webhookVerifier ?? (process.env.PAYPAL_WEBHOOK_ID && payments.mode === "sandbox" ? createPayPalWebhookVerifier(process.env.PAYPAL_WEBHOOK_ID) : undefined),
  };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 200_000) throw new DomainError("Request is too large.", 413);
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new DomainError("Body is not valid JSON.");
  }
}

function session(req: IncomingMessage): SessionPayload | null {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) return null;
  return verifyToken(h.slice(7));
}

export function incidentView(ctx: Ctx, i: Incident, role: "owner" | "agent") {
  const purchase = getPurchase(ctx.db, i.purchaseId)!;
  const quotes = i.proposal ? verifyQuotes(i.proposal, purchase.records) : [];
  const payout = getPayoutForIncident(ctx.db, i.id);
  const ledger = listLedger(ctx.db).filter((l) => l.incidentId === i.id);
  const { approvalHash, ...rest } = i;
  return {
    ...rest,
    purchase,
    quotes,
    payout,
    ledger,
    // The owner's approval token is the hash of the exact action. Only the owner is given it.
    approvalToken: role === "owner" && i.status === "needs_owner" ? approvalHash : null,
    paymentsMode: ctx.payments.mode,
    // The exact words that would go to PayPal if the owner approves a defence. Built only from quotes that were found word for word.
    evidencePreview: i.remedy === "defend" && i.proposal ? buildEvidenceNote(i, purchase) : null,
  };
}

export function createHandler(ctx: Ctx) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";
    try {
      if (method === "POST" && path === "/api/login") {
        const b = (await readBody(req)) as { username?: string; password?: string };
        const row = ctx.db.prepare("SELECT id, username, password_hash, role FROM users WHERE username = ?").get(String(b.username ?? "")) as
          | { id: string; username: string; password_hash: string; role: "agent" | "owner" }
          | undefined;
        if (!row || row.password_hash !== hashPassword(String(b.password ?? ""), DEMO_SALT)) throw new DomainError("Wrong username or password.", 401);
        return send(res, 200, { token: signToken({ userId: row.id, username: row.username, role: row.role }), username: row.username, role: row.role });
      }
      if (method === "POST" && path === "/api/webhooks/paypal") {
        const out = await handleWebhook(ctx, req.headers, await readBody(req));
        return send(res, out.status, out.body);
      }
      if (method === "GET" && path === "/api/mode") {
        return send(res, 200, { payments: ctx.payments.modeLabel, paymentsMode: ctx.payments.mode, ai: ctx.ai.modeLabel, policy: ctx.policy });
      }

      const s = session(req);
      if (!s) throw new DomainError("Please sign in.", 401);
      const actor: Actor = { name: s.username, role: s.role };

      if (method === "GET" && path === "/api/me") return send(res, 200, { username: s.username, role: s.role });

      if (method === "POST" && path === "/api/purchases") {
        return send(res, 201, recordPurchase(ctx, await readBody(req), actor));
      }
      if (method === "GET" && path === "/api/purchases") return send(res, 200, listPurchases(ctx.db));

      if (method === "POST" && path === "/api/incidents") {
        const inc = openIncident(ctx, await readBody(req), actor);
        return send(res, 201, incidentView(ctx, inc, s.role));
      }
      if (method === "GET" && path === "/api/incidents") {
        return send(res, 200, listIncidents(ctx.db).map((i) => incidentView(ctx, i, s.role)));
      }
      const m = /^\/api\/incidents\/([A-Za-z0-9_]+)(?:\/(propose|approve|reject|sync|retry|evidence))?$/.exec(path);
      if (m) {
        const id = m[1];
        const action = m[2];
        if (method === "GET" && !action) {
          const i = getIncident(ctx.db, id);
          if (!i) throw new DomainError("No such incident.", 404);
          return send(res, 200, incidentView(ctx, i, s.role));
        }
        if (method === "POST" && action === "propose") {
          return send(res, 200, incidentView(ctx, await proposeIncident(ctx, id, actor), s.role));
        }
        if (method === "POST" && action === "evidence") {
          return send(res, 200, incidentView(ctx, addEvidence(ctx, id, await readBody(req), actor), s.role));
        }
        if (method === "POST" && action === "approve") {
          const b = (await readBody(req)) as { approvalToken?: string };
          return send(res, 200, incidentView(ctx, await approveIncident(ctx, id, b.approvalToken, actor), s.role));
        }
        if (method === "POST" && action === "reject") {
          return send(res, 200, incidentView(ctx, rejectIncident(ctx, id, actor), s.role));
        }
        if (method === "POST" && action === "sync") {
          const i = getIncident(ctx.db, id);
          if (!i) throw new DomainError("No such incident.", 404);
          return send(res, 200, incidentView(ctx, await syncIncidentDispute(ctx, i), s.role));
        }
        if (method === "POST" && action === "retry") {
          if (s.role !== "owner") throw new DomainError("Only the owner can retry.", 403);
          return send(res, 200, incidentView(ctx, await executeIncident(ctx, id), s.role));
        }
      }
      if (method === "POST" && path === "/api/disputes/sync") {
        const n = await syncAllDisputes(ctx);
        appendAudit(ctx.db, { actor: actor.name, role: actor.role, incidentId: null, event: "dispute_synced", details: { incidents: n, manual: true } });
        return send(res, 200, { synced: n });
      }
      if (method === "GET" && path === "/api/ledger") {
        return send(res, 200, { entries: listLedger(ctx.db), totals: totalsByAccount(ctx.db), payouts: listPayouts(ctx.db) });
      }
      if (method === "GET" && path === "/api/audit") return send(res, 200, listAudit(ctx.db));
      if (method === "GET" && path === "/api/policy") return send(res, 200, ctx.policy);

      // Mock mode only: stands in for the buyer pressing Accept on PayPal's page. The real flow needs the buyer in PayPal.
      if (method === "POST" && path === "/api/dev/buyer-accepts") {
        if (ctx.payments.mode !== "mock" || s.role !== "owner") throw new DomainError("Not available.", 404);
        const b = (await readBody(req)) as { disputeId?: string };
        (ctx.payments as MockPayPalAdapter).buyerAccepts(String(b.disputeId ?? ""));
        return send(res, 200, { ok: true });
      }

      throw new DomainError("Not found.", 404);
    } catch (e) {
      if (e instanceof DomainError) return send(res, e.status, { error: e.message });
      logTechnical("request", e);
      return send(res, 500, { error: FRIENDLY.generic });
    }
  };
}

export type { AiAdapter, PaymentsAdapter };
