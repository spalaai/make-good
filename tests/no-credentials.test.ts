import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const SKIP = new Set(["node_modules", ".git", "data", "dist", "shots", "parts"]);
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name === ".env") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js|json|md|py|html|css|txt|example)$/.test(name) || name === ".env.example") out.push(p);
  }
  return out;
}

describe("no sandbox buyer credentials in the repo", () => {
  it("has neither the buyer's password nor the full buyer email in any text file", () => {
    // Sandbox account emails start with "sb-" and end in example.com. Buyer secrets set in the environment are checked too.
    const escape = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const fromEnv = [process.env.BUYER_PW, process.env.BUYER_EMAIL].filter((v): v is string => !!v && v.length >= 6).map((v) => new RegExp(escape(v)));
    const patterns = [/sb-[a-z0-9]+@(personal|business)\.example\.com/, ...fromEnv];
    const hits: string[] = [];
    for (const f of walk(root)) {
      const text = readFileSync(f, "utf8");
      if (patterns.some((p) => p.test(text))) hits.push(f.replace(root + "/", ""));
    }
    expect(hits).toEqual([]);
  });
});
