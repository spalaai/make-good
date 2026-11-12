/** Re-renders docs/EVAL_REPORT.md from a saved results file, without calling any model. */
import { readFileSync, writeFileSync } from "node:fs";
import { renderReport, type EvalResult } from "../../eval/report.js";

const file = process.argv[2];
if (!file) {
  console.error("Usage: render-report.ts eval/results/<file>.json");
  process.exit(2);
}
writeFileSync("docs/EVAL_REPORT.md", renderReport(JSON.parse(readFileSync(file, "utf8")) as EvalResult));
console.log("Wrote docs/EVAL_REPORT.md");
