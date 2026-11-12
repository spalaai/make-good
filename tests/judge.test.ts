import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { LiveAiAdapter } from "../server/adapters/ai-live.js";
import { MockAiAdapter } from "../server/adapters/ai-mock.js";
import { buildJudgePrompt, JUDGE_SYSTEM_PROMPT } from "../server/adapters/ai-prompt.js";
import { resolveJudgeConfig, resolveProviderConfig } from "../server/adapters/index.js";
import type { AiAdapter, JudgeInput } from "../server/adapters/ai.js";
import { migrate } from "../server/db.js";
import { listAudit } from "../server/domain/audit.js";
import { addEvidence } from "../server/domain/evidence.js";
import { approveIncident } from "../server/domain/execute.js";
import { checkJudge, judgeSupports, unaddressedContradictions } from "../server/domain/judge.js";
import { judgeJsonSchema, judgeVerdictSchema, type JudgeVerdict } from "../server/domain/judgeSchema.js";
import { proposeIncident } from "../server/domain/propose.js";
import { getIncident, getPurchase } from "../server/domain/repo.js";
import { DEFAULT_POLICY } from "../server/domain/policy.js";
import { decide } from "../server/domain/rules.js";
import { createCtx, createHandler, incidentView } from "../server/routes.js";
import { openDatabase } from "../server/db.js";
import { ensureDemoUsers } from "../server/domain/users.js";
import { FIXTURES } from "../server/fixtures.js";
import type { BundleRecord, FaultProposal } from "../server/types.js";
import { AGENT, OWNER, makeCtx, seedFixture } from "./helpers.js";

const SYSTEM = { name: "make-good", role: "system" as const };
const fx = (key: string) => FIXTURES.find((f) => f.key === key)!;
const holds = (p: FaultProposal): JudgeVerdict => ({
  quotes: p.citations.map((c, i) => ({ recordId: c.recordId, quote: c.quote, role: i === 0 ? "supports" : "background", reason: "ok" })),
  contradictions: [],
  overall: "holds",
  missing: [],
  reasoning: "The records back it.",
});

function decideWith(key: string, judge: ReturnType<typeof checkJudge> | null | undefined, proposal: FaultProposal = fx(key).recorded) {
  const f = fx(key);
  return decide({ proposal, records: f.records, purchaseAmountCents: f.amountCents, claimedCents: null, complaint: f.complaint, policy: DEFAULT_POLICY, openDisputeOnPurchase: false, judge });
}
const checked = (key: string, v: JudgeVerdict) => checkJudge(fx(key).recorded, fx(key).records, v);

describe("checking the judge's answer", () => {
  it("matches the judge's rulings to the quotes the proposer cited, and a quote it skipped is not judged", () => {
    const f = fx("never-delivered");
    const v = holds(f.recorded);
    v.quotes = v.quotes.slice(0, 1);
    const c = checkJudge(f.recorded, f.records, v);
    expect(c.quoteChecks.map((q) => q.role)).toEqual(["supports", "not_judged"]);
    expect(judgeSupports(c).ok).toBe(false);
    expect(judgeSupports(c).detail).toMatch(/did not rule/);
  });

  it("still matches when the judge echoes a record id with brackets, as the prompt writes it", () => {
    const f = fx("never-delivered");
    const v = holds(f.recorded);
    v.quotes = v.quotes.map((q) => ({ ...q, recordId: `[${q.recordId}]` }));
    v.contradictions = [{ recordId: "[r6]", quote: "Delivery status: not delivered", why: "x", addressed: false }];
    const c = checkJudge(f.recorded, f.records, v);
    expect(c.quoteChecks.map((q) => q.role)).toEqual(["supports", "background"]);
    expect(judgeSupports(c).ok).toBe(true);
    expect(c.contradictions[0]).toMatchObject({ recordId: "r6", verified: true });
  });

  it("counts a contradiction only when its quote is really in that record", () => {
    const f = fx("never-delivered");
    const v = holds(f.recorded);
    v.contradictions = [
      { recordId: "r6", quote: "Delivery status: not delivered", why: "x", addressed: false },
      { recordId: "r6", quote: "The parcel was signed for by a neighbour", why: "invented by the judge", addressed: false },
    ];
    const c = checkJudge(f.recorded, f.records, v);
    expect(c.contradictions.map((x) => x.verified)).toEqual([true, false]);
    expect(unaddressedContradictions(c)).toHaveLength(1);
  });

  it("backs a conclusion only when one quote supports it, none fail it, and the call is holds", () => {
    const f = fx("never-delivered");
    const ok = checked("never-delivered", holds(f.recorded));
    expect(judgeSupports(ok).ok).toBe(true);
    const onlyBackground = checked("never-delivered", { ...holds(f.recorded), quotes: f.recorded.citations.map((c) => ({ ...c, role: "background" as const, reason: "x" })) });
    expect(judgeSupports(onlyBackground).ok).toBe(false);
    const failing = checked("never-delivered", { ...holds(f.recorded), quotes: [{ ...f.recorded.citations[0], role: "does_not_support", reason: "It is only a promise." }, { ...f.recorded.citations[1], role: "supports", reason: "x" }] });
    expect(judgeSupports(failing).ok).toBe(false);
    expect(judgeSupports({ ...ok, overall: "weak" }).ok).toBe(false);
    expect(judgeSupports(null).ok).toBe(false);
  });

  it("the judge's answer has no amount and no remedy, and anything extra is dropped", () => {
    expect(Object.keys(judgeJsonSchema.properties)).toEqual(["quotes", "contradictions", "overall", "missing", "reasoning"]);
    const parsed = judgeVerdictSchema.parse({ ...holds(fx("never-delivered").recorded), refundAmount: 99999, remedy: "merchant_refund" });
    expect("refundAmount" in parsed || "remedy" in parsed).toBe(false);
    expect(JUDGE_SYSTEM_PROMPT).toMatch(/Do not name a refund amount or a remedy/);
    expect(JUDGE_SYSTEM_PROMPT).toMatch(/untrusted/);
    const f = fx("never-delivered");
    expect(buildJudgePrompt({ purchaseId: "p", fixtureKey: null, amountCents: 1, merchantName: "S", operatorName: "O", records: f.records, complaint: f.complaint, proposal: f.recorded })).toContain("Quotes cited:");
  });
});

describe("the rule with the judge", () => {
  it("pays only when the quotes exist AND the judge says they support it AND nothing ignored contradicts it", () => {
    const f = fx("never-delivered");
    const d = decideWith("never-delivered", checked("never-delivered", holds(f.recorded)));
    expect(d.remedy).toBe("merchant_refund");
    expect(d.checks.find((c) => c.id === "judge_supports")?.passed).toBe(true);
    expect(d.checks.find((c) => c.id === "no_contradiction")?.passed).toBe(true);
  });

  it("stops when a quote exists but the judge says it does not support the conclusion", () => {
    const f = fx("never-delivered");
    const v = holds(f.recorded);
    v.quotes = v.quotes.map((q) => ({ ...q, role: "does_not_support" as const, reason: "The words do not show the shop failed." }));
    const d = decideWith("never-delivered", checked("never-delivered", v));
    expect(d.checks.find((c) => c.id === "quotes_verbatim")?.passed).toBe(true);
    expect(d.remedy).toBe("abstain");
    expect(d.abstainReason).toMatch(/judge/i);
  });

  it("stops on a record the AI ignored that points the other way, even if the judge calls it holds", () => {
    const f = fx("never-delivered");
    const v = holds(f.recorded);
    v.contradictions = [{ recordId: "r6", quote: "Delivery status: not delivered", why: "This record is about delivery.", addressed: false }];
    const d = decideWith("never-delivered", checked("never-delivered", v));
    expect(d.remedy).toBe("abstain");
    expect(d.checks.find((c) => c.id === "no_contradiction")?.passed).toBe(false);
    // the same record, dealt with in the summary, does not stop it
    v.contradictions[0].addressed = true;
    expect(decideWith("never-delivered", checked("never-delivered", v)).remedy).toBe("merchant_refund");
    // a contradiction quote that is not in the record is ignored
    v.contradictions = [{ recordId: "r6", quote: "Signed for by a neighbour at the door", why: "invented", addressed: false }];
    expect(decideWith("never-delivered", checked("never-delivered", v)).remedy).toBe("merchant_refund");
  });

  it("fails closed when the judge could not be reached, and the old rule is unchanged when no judge is asked", () => {
    const d = decideWith("never-delivered", null);
    expect(d.remedy).toBe("abstain");
    expect(d.abstainReason).toMatch(/judge could not be reached/i);
    expect(decideWith("never-delivered", undefined).remedy).toBe("merchant_refund");
  });

  it("turns a thin case into a list of records to ask for, and a plain stop into a person", () => {
    const f = fx("ambiguous");
    const v: JudgeVerdict = { ...holds(f.recorded), overall: "weak", missing: [{ kind: "tracking", title: "Carrier scan", why: "It shows who signed." }] };
    const d = decideWith("ambiguous", checked("ambiguous", v));
    expect(d.remedy).toBe("abstain");
    expect(d.stop).toBe("need_evidence");
    expect(d.evidenceRequests?.map((r) => r.title)).toEqual(["Carrier scan"]);
    const none = decideWith("ambiguous", checked("ambiguous", { ...v, missing: [] }));
    expect(none.stop).toBe("ask_person");
    expect(none.evidenceRequests).toEqual([]);
  });

  it("asks for the kind of record the conclusion needs when the bundle has none, and sends a double-pay risk to a person", () => {
    const records: BundleRecord[] = [{ id: "r1", kind: "instruction", label: "x", text: "Buy the report for me please." }];
    const proposal: FaultProposal = { fault: "merchant", confidence: 0.9, summary: "x", citations: [{ recordId: "r1", quote: "Buy the report for me please" }] };
    const d = decide({ proposal, records, purchaseAmountCents: 1000, claimedCents: null, complaint: "x", policy: DEFAULT_POLICY, openDisputeOnPurchase: false, judge: checkJudge(proposal, records, { ...holds(proposal), overall: "weak", missing: [] }) });
    expect(d.stop).toBe("need_evidence");
    expect(d.evidenceRequests?.some((r) => r.kind === "listing" || r.kind === "tracking" || r.kind === "delivery")).toBe(true);
    const f = fx("wrong-edition");
    const dp = decide({ proposal: f.recorded, records: f.records, purchaseAmountCents: f.amountCents, claimedCents: null, complaint: f.complaint, policy: DEFAULT_POLICY, openDisputeOnPurchase: true, judge: checkJudge(f.recorded, f.records, holds(f.recorded)) });
    expect(dp.stop).toBe("ask_person");
  });
});

/** An adapter with chosen answers, to drive the whole flow. */
function stubAi(over: { propose?: (i: JudgeInput) => FaultProposal; judge?: (i: JudgeInput) => JudgeVerdict | Error }): AiAdapter {
  return {
    kind: "live", provider: "stub", model: "stub-proposer", modeLabel: "stub", fallbackToRecorded: false,
    async proposeFault(i) { return { proposal: over.propose ? over.propose(i as JudgeInput) : fx("never-delivered").recorded, source: { kind: "live", provider: "stub", model: "stub-proposer" } }; },
    async judgeEvidence(i) {
      const v = over.judge ? over.judge(i) : holds(i.proposal);
      if (v instanceof Error) throw v;
      return { verdict: v, source: { kind: "live", provider: "stub", model: "stub-judge" } };
    },
  };
}

describe("the whole flow with the judge", () => {
  it("the recorded demo answers still pay, defend or stop as before, with the judge's reasoning saved", async () => {
    const ctx = makeCtx();
    const { incident } = seedFixture(ctx, "never-delivered");
    const i = await proposeIncident(ctx, incident.id, SYSTEM);
    expect(i.status).toBe("needs_owner");
    expect(i.judge?.overall).toBe("holds");
    expect(i.judgeSource?.kind).toBe("recorded");
    expect(listAudit(ctx.db).some((a) => a.event === "judge_verdict")).toBe(true);
  });

  it("a quote that exists but does not support the conclusion cannot reach the owner for approval", async () => {
    const ctx = makeCtx({ ai: stubAi({ judge: (i) => ({ ...holds(i.proposal), quotes: i.proposal.citations.map((c) => ({ ...c, role: "does_not_support" as const, reason: "Only a promise." })), overall: "fails" }) }) });
    const { incident } = seedFixture(ctx, "never-delivered");
    const i = await proposeIncident(ctx, incident.id, SYSTEM);
    expect(i.status).toBe("needs_person");
    expect(i.approvalHash).toBeNull();
    await expect(approveIncident(ctx, i.id, "x", OWNER)).rejects.toThrow(/not waiting for approval/);
    expect(ctx.payments.refunds).toHaveLength(0);
    expect(ctx.payments.offers).toHaveLength(0);
  });

  it("a judge that cannot be reached stops the case and says so in the audit log", async () => {
    const ctx = makeCtx({ ai: stubAi({ judge: () => new Error("AI API error (503): busy") }) });
    const { incident } = seedFixture(ctx, "never-delivered");
    const i = await proposeIncident(ctx, incident.id, SYSTEM);
    expect(i.status).toBe("needs_person");
    expect(i.judge).toBeNull();
    expect(i.decision?.abstainReason).toMatch(/judge/i);
    expect(listAudit(ctx.db).some((a) => a.event === "judge_failed")).toBe(true);
    expect(i.error ?? "").not.toMatch(/503|API/);
  });

  it("thin evidence produces a request list, the owner attaches a record, and the check runs again", async () => {
    let round = 0;
    const ctx = makeCtx({
      ai: stubAi({
        propose: (i) => {
          const rec = i.records.find((r) => r.addedBy);
          return rec
            ? { fault: "merchant", confidence: 0.9, summary: "The carrier scan shows no delivery.", citations: [{ recordId: rec.id, quote: rec.text.slice(0, 40) }, { recordId: "r3", quote: "Download link emailed within 1 hour of payment" }] }
            : { fault: "unclear", confidence: 0.4, summary: "Not enough.", citations: [{ recordId: "r1", quote: "Buy the 2026 edition of the Packaging Suppliers Report for me" }] };
        },
        judge: (i) => {
          round += 1;
          return i.records.some((r) => r.addedBy)
            ? holds(i.proposal)
            : { quotes: [{ recordId: "r1", quote: "Buy the 2026 edition of the Packaging Suppliers Report for me", role: "background", reason: "x" }], contradictions: [], overall: "weak", missing: [{ kind: "tracking", title: "Carrier scan", why: "It would show whether anything shipped." }], reasoning: "Not enough to say." };
        },
      }),
    });
    const { incident } = seedFixture(ctx, "never-delivered");
    let i = await proposeIncident(ctx, incident.id, SYSTEM);
    expect(i.status).toBe("needs_evidence");
    expect(i.decision?.evidenceRequests?.[0].title).toBe("Carrier scan");
    expect(i.approvalHash).toBeNull();

    // only the owner can attach, and the agent cannot re-run
    expect(() => addEvidence(ctx, i.id, { kind: "tracking", text: "x" }, AGENT)).toThrow(/Only the owner/);
    await expect(proposeIncident(ctx, i.id, AGENT)).rejects.toThrow(/Only the owner/);

    i = addEvidence(ctx, i.id, { kind: "tracking", source: "Carrier scan, 12 Oct", text: "Carrier scan: label created, parcel never handed over to the carrier." }, OWNER);
    const records = getPurchase(ctx.db, i.purchaseId)!.records;
    expect(records.at(-1)).toMatchObject({ id: "r7", kind: "tracking", addedBy: "owner" });
    expect(records.at(-1)!.label).toMatch(/added: Carrier scan, 12 Oct/);
    const audit = listAudit(ctx.db).find((a) => a.event === "evidence_added")!;
    expect(audit.detailsJson).toContain("never handed over");
    expect(i.status).toBe("needs_evidence"); // attaching decides nothing

    i = await proposeIncident(ctx, i.id, OWNER);
    expect(i.status).toBe("needs_owner");
    expect(i.remedy).toBe("merchant_refund");
    expect(round).toBe(2);
    expect(i.version).toBeGreaterThan(1);
  });

  it("evidence can be attached only while the case is waiting for it, and must be valid", async () => {
    const ctx = makeCtx();
    const { incident } = seedFixture(ctx, "never-delivered");
    expect(() => addEvidence(ctx, incident.id, { kind: "tracking", text: "x" }, OWNER)).toThrow(/waiting for it/);
    const i = await proposeIncident(ctx, incident.id, SYSTEM);
    expect(i.status).toBe("needs_owner");
    expect(() => addEvidence(ctx, i.id, { kind: "tracking", text: "x" }, OWNER)).toThrow(/waiting for it/);
    const a = seedFixture(ctx, "ambiguous");
    const j = await proposeIncident(ctx, a.incident.id, SYSTEM);
    expect(j.status).toBe("needs_evidence");
    expect(() => addEvidence(ctx, j.id, { kind: "nonsense", text: "x" }, OWNER)).toThrow(/not valid/);
    expect(() => addEvidence(ctx, j.id, { kind: "tracking", text: "" }, OWNER)).toThrow(/not valid/);
  });

  it("the recorded answer does not apply once records were added, so nothing is paid on it", async () => {
    const ctx = makeCtx();
    const a = seedFixture(ctx, "ambiguous");
    let j = await proposeIncident(ctx, a.incident.id, SYSTEM);
    j = addEvidence(ctx, j.id, { kind: "instruction", text: "The buyer wrote: I want the 2026 edition." }, OWNER);
    j = await proposeIncident(ctx, j.id, OWNER);
    expect(j.status).not.toBe("needs_owner");
    expect(j.proposal?.summary).toMatch(/No saved answer/);
  });

  it("the incident view carries the judge's verdict and where it came from", async () => {
    const ctx = makeCtx();
    const { incident } = seedFixture(ctx, "wrong-edition");
    const i = await proposeIncident(ctx, incident.id, SYSTEM);
    const v = incidentView(ctx, i, "owner") as unknown as { judge: { overall: string }; judgeSource: { kind: string } };
    expect(v.judge.overall).toBe("holds");
    expect(v.judgeSource.kind).toBe("recorded");
  });

  it("the saved judge verdict fails closed for an altered answer and for an unknown purchase", async () => {
    const ai = new MockAiAdapter();
    const f = fx("never-delivered");
    const base = { purchaseId: "p", fixtureKey: f.key, amountCents: f.amountCents, merchantName: "S", operatorName: "O", records: f.records, complaint: f.complaint };
    const altered = { ...f.recorded, citations: [{ recordId: "r5", quote: "the shop confirmed it never sent the link" }] };
    for (const input of [{ ...base, proposal: altered }, { ...base, fixtureKey: null, proposal: f.recorded }]) {
      const r = await ai.judgeEvidence(input);
      expect(r.verdict.overall).toBe("weak");
      expect(judgeSupports(checkJudge(input.proposal, f.records, r.verdict)).ok).toBe(false);
    }
  });
});

describe("which model judges", () => {
  const key = { GEMINI_API_KEY: "k" };
  it("uses a different Gemini model from the proposer by default, and JUDGE_MODEL overrides it", () => {
    const p = resolveProviderConfig({ ...key, AI_PROVIDER: "gemini" })!;
    expect(resolveJudgeConfig(key, p).model).not.toBe(p.model);
    expect(resolveJudgeConfig({ ...key, JUDGE_MODEL: "some-model" }, p).model).toBe("some-model");
  });
  it("falls back to the proposer's model where no other is known, and refuses a judge provider with no key", () => {
    const p = resolveProviderConfig({ OPENAI_API_KEY: "k", AI_PROVIDER: "openai" })!;
    expect(resolveJudgeConfig({ OPENAI_API_KEY: "k" }, p).model).toBe(p.model);
    expect(() => resolveJudgeConfig({ JUDGE_PROVIDER: "anthropic" }, p)).toThrow(/no key/);
  });
  it("the live adapter sends the judge's own model and schema, and reads its verdict", async () => {
    let url = "";
    let body = "";
    const f = fx("never-delivered");
    const cfg = { provider: "gemini" as const, label: "gemini", model: "proposer-model", apiKey: "SECRETKEY", baseUrl: "https://example.test", jsonMode: "schema" as const };
    const ai = new LiveAiAdapter({
      config: cfg,
      judgeConfig: { ...cfg, model: "judge-model" },
      timeoutMs: 1000,
      fetchImpl: async (u, init) => {
        url = u; body = String(init.body);
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ ...holds(f.recorded), refundAmount: 5 }) }] }, finishReason: "STOP" }] }), { status: 200 });
      },
    });
    const r = await ai.judgeEvidence({ purchaseId: "p", fixtureKey: null, amountCents: 1, merchantName: "S", operatorName: "O", records: f.records, complaint: f.complaint, proposal: f.recorded });
    expect(url).toContain("judge-model");
    expect(body).toContain("contradictions");
    expect(body).not.toContain("SECRETKEY");
    expect(r.source.model).toBe("judge-model");
    expect("refundAmount" in r.verdict).toBe(false);
    expect(ai.modeLabel).toContain("judge gemini judge-model");
  });
});

describe("older databases and the HTTP route", () => {
  it("adds the judge columns to an incidents table made before the judge existed", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE incidents (id TEXT PRIMARY KEY, purchase_id TEXT, complaint TEXT, status TEXT, created_at TEXT, updated_at TEXT)");
    migrate(db);
    const cols = (db.prepare("PRAGMA table_info(incidents)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("judge_json");
    expect(cols).toContain("judge_source_json");
  });

  it("POST /evidence is owner only, adds the record, and the agent cannot re-run", async () => {
    const db = openDatabase(":memory:");
    migrate(db);
    ensureDemoUsers(db);
    const ctx = createCtx(db, { ai: new MockAiAdapter() });
    const { incident } = seedFixture(ctx, "ambiguous");
    await proposeIncident(ctx, incident.id, SYSTEM);
    const server = createServer((req, res) => void createHandler(ctx)(req, res));
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (path: string, token: string, body: unknown) => {
      const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      return { status: res.status, json: (await res.json()) as any };
    };
    const login = async (u: string, p: string) => ((await (await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: u, password: p }) })).json()) as any).token as string;
    const agent = await login("agent", "agent-demo");
    const owner = await login("owner", "owner-demo");
    expect((await call(`/api/incidents/${incident.id}/evidence`, agent, { kind: "instruction", text: "x" })).status).toBe(403);
    expect((await call(`/api/incidents/${incident.id}/propose`, agent, {})).status).toBe(403);
    const ok = await call(`/api/incidents/${incident.id}/evidence`, owner, { kind: "instruction", source: "Original chat", text: "The buyer wrote: the 2026 edition please." });
    expect(ok.status).toBe(200);
    expect(ok.json.purchase.records.at(-1).addedBy).toBe("owner");
    expect(getIncident(db, incident.id)!.status).toBe("needs_evidence");
    server.close();
  });
});
