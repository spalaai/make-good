/**
 * Runs the labelled cases through a live model and writes eval/results/*.json and docs/EVAL_REPORT.md.
 *   AI_PROVIDER=gemini npx tsx scripts/eval/run-eval.ts [--runs 2] [--concurrency 4] [--no-judge]
 * With the judge on (the default) every proposal is also sent to the independent judge, and the report compares the old rule with the judge-required rule.
 * The key comes from the environment. It is never printed or written.
 */
import "../../server/loadEnv.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { LiveAiAdapter } from "../../server/adapters/ai-live.js";
import { resolveJudgeConfig, resolveProviderConfig } from "../../server/adapters/index.js";
import { CASES } from "../../eval/cases.js";
import { renderReport, type EvalResult } from "../../eval/report.js";
import type { RunRecord } from "../../eval/score.js";

const arg = (name: string, d: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : d;
};
const runs = arg("runs", 2);
const concurrency = arg("concurrency", 4);

const cfg = resolveProviderConfig({ ...process.env, AI_PROVIDER: process.env.AI_PROVIDER ?? "gemini" });
if (!cfg) {
  console.error("No live provider key found in the environment.");
  process.exit(2);
}
const useJudge = !process.argv.includes("--no-judge");
const judgeCfg = resolveJudgeConfig(process.env, cfg);
const ai = new LiveAiAdapter({ config: cfg, judgeConfig: judgeCfg, timeoutMs: 120_000, retryDelayMs: 3000 });

async function one(c: (typeof CASES)[number]): Promise<RunRecord> {
  try {
    const input = { purchaseId: c.id, fixtureKey: null, amountCents: c.amountCents, merchantName: c.merchantName, operatorName: c.operatorName, records: c.records, complaint: c.complaint };
    const r = await ai.proposeFault(input);
    if (!useJudge) return { caseId: c.id, error: null, proposal: r.proposal };
    try {
      const j = await ai.judgeEvidence({ ...input, proposal: r.proposal });
      return { caseId: c.id, error: null, proposal: r.proposal, judge: j.verdict, judgeError: null };
    } catch (e) {
      return { caseId: c.id, error: null, proposal: r.proposal, judge: null, judgeError: String((e as Error).message).slice(0, 200) };
    }
  } catch (e) {
    return { caseId: c.id, error: String((e as Error).message).slice(0, 200), proposal: null };
  }
}

async function pass(): Promise<RunRecord[]> {
  const out: RunRecord[] = new Array(CASES.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < CASES.length) {
        const i = next++;
        out[i] = await one(CASES[i]);
      }
    }),
  );
  return out;
}

const result: EvalResult = { model: cfg.model, provider: cfg.label, ...(useJudge ? { judgeModel: judgeCfg.model, judgeProvider: judgeCfg.label } : {}), ranAt: new Date().toISOString(), runs: [] };
for (let r = 0; r < runs; r++) {
  const t = Date.now();
  result.runs.push(await pass());
  console.log(`pass ${r + 1} done in ${Math.round((Date.now() - t) / 1000)}s, errors: ${result.runs[r].filter((x) => x.error).length}, judge errors: ${result.runs[r].filter((x) => x.judgeError).length}`);
}
mkdirSync("eval/results", { recursive: true });
const file = `eval/results/${cfg.label}-${cfg.model}${useJudge ? `-judge-${judgeCfg.model}` : ""}-${result.ranAt.slice(0, 10)}.json`;
writeFileSync(file, JSON.stringify(result, null, 1) + "\n");
writeFileSync("docs/EVAL_REPORT.md", renderReport(result));
console.log(`Wrote ${file} and docs/EVAL_REPORT.md`);
