import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("no secrets in the repo files", () => {
  it(".env.example carries no keys", () => {
    const t = read(".env.example");
    for (const line of t.split("\n").filter((l) => /KEY|SECRET|PASSWORD|TOKEN/.test(l) && !l.startsWith("#"))) {
      expect(line.split("=")[1]?.trim() ?? "", line).toBe("");
    }
  });

  it("the sandbox scripts read the buyer login from the environment only", () => {
    const lib = read("scripts/sandbox/buyer-lib.mjs");
    expect(lib).toMatch(/process\.env\.BUYER_PW/);
    expect(/sb-[a-z0-9]+@/.test(lib)).toBe(false);
  });
});

describe("console copy has no long dash", () => {
  const walk = (d: string): string[] => readdirSync(join(root, d)).flatMap((n) => {
    const p = `${d}/${n}`;
    return statSync(join(root, p)).isDirectory() ? (n === "node_modules" || n === "dist" ? [] : walk(p)) : /\.(tsx?|css|html)$/.test(n) ? [p] : [];
  });
  const consoleFiles = [...walk("web/src"), "web/index.html", ...walk("server")];
  it("scans every console and server source file", () => {
    expect(consoleFiles.length).toBeGreaterThan(20);
  });
  for (const f of consoleFiles) {
    it(`${f} has no en dash, em dash or minus sign`, () => {
      expect(/[\u2013\u2014\u2212]/.test(read(f)), f).toBe(false);
    });
  }
  it("a negative amount is spelled out, so no lone hyphen is drawn next to a dollar sign", async () => {
    const { money, moneyFlow } = await import("../web/src/api.js");
    expect(money(-2000)).toBe("minus $20.00");
    expect(money(2000)).toBe("$20.00");
    expect(moneyFlow(-2000)).toBe("paid $20.00");
    expect(moneyFlow(2000)).toBe("received $20.00");
    for (const t of [money(-2000), moneyFlow(-2000)]) expect(t).not.toMatch(/-/);
  });
  it("no table cell uses a lone hyphen as a placeholder", () => {
    for (const f of walk("web/src").filter((x) => x.endsWith(".tsx"))) expect(/: "-"\}|>-<\/t[dh]>/.test(read(f)), f).toBe(false);
  });
});
