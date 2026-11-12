import { chromium } from "playwright";
export const SHOTS = process.env.SHOTS_DIR ?? "./scripts/sandbox/shots";
export async function launch() {
  const b = await chromium.launch({ channel: "chrome", headless: true });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  const p = await ctx.newPage();
  return { b, ctx, p };
}
// Logs in on whichever PayPal sandbox login page is showing. Never screenshots while credentials are typed.
export async function login(p) {
  const email = process.env.BUYER_EMAIL, pw = process.env.BUYER_PW;
  await p.waitForSelector("#email, input[name=login_email], #password", { timeout: 30000 });
  if (await p.locator("#email").count()) {
    await p.fill("#email", email);
    if (await p.locator("#btnNext").isVisible().catch(() => false)) await p.click("#btnNext");
  }
  await p.waitForSelector("#password", { state: "visible", timeout: 30000 });
  await p.fill("#password", pw);
  await p.click("#btnLogin");
  await p.waitForLoadState("domcontentloaded");
  await p.waitForTimeout(5000);
}
import { mkdirSync } from "node:fs";
export async function shot(p, name) { mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: `${SHOTS}/${name}.png` }); }
export async function blocked(p) {
  const t = (await p.locator("body").innerText().catch(() => "")).toLowerCase();
  return /captcha|verify you are human|security challenge|enter the code|confirm your identity|we sent a code/.test(t);
}
