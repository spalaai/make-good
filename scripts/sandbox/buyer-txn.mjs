// Finds the buyer-side transaction id of the newest payment of a given amount, from the buyer's activity page.
// usage: node scripts/sandbox/buyer-txn.mjs 20.00
import { launch, login, shot, blocked } from "./buyer-lib.mjs";
const amount = process.argv[2] ?? "20.00";
const { b, p } = await launch();
const URL = "https://www.sandbox.paypal.com/myaccount/summary?locale.x=en_US";
try {
  const SUMMARY = "https://www.sandbox.paypal.com/myaccount/summary?locale.x=en_US";
  await p.goto(SUMMARY, { waitUntil: "domcontentloaded", timeout: 60000 });
  await p.waitForTimeout(3000);
  if (await p.locator("#password").count()) await login(p);
  await p.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await p.waitForFunction(() => /US\$|\$\d/.test(document.body.innerText), null, { timeout: 40000 }).catch(() => {});
  await p.waitForTimeout(3000);
  await p.getByRole("button", { name: "Tolak" }).click({ timeout: 1000 }).catch(() => {});
  if (await blocked(p)) { console.log("BLOCKED"); process.exitCode = 1; }
  // The summary page lists recent activity as clickable rows (not links). Click the newest outgoing payment of this amount.
  const amt = amount.replace(".", "[.,]");
  const row = p.getByText(new RegExp(`[-\\u2212]\\s?US\\$${amt}`)).first();
  await row.waitFor({ timeout: 15000 });
  await row.click();
  await p.waitForURL(/\/activity\/|\/transactions?\//, { timeout: 20000 }).catch(() => {});
  await p.waitForTimeout(3000);
  const url = p.url();
  const m = url.match(/\/(?:payment|payments|details|transactions?)\/([A-Z0-9]{12,20})/i) ?? url.match(/\b([0-9][A-Z0-9]{16})\b/);
  console.log("url:", url.split("?")[0].replace("https://www.sandbox.paypal.com", ""));
  console.log("buyer transaction id:", m ? m[1] : "NOT FOUND");
  if (process.env.DEBUG_PAGE) { console.log("URL:", p.url().split("?")[0]); console.log((await p.locator("body").innerText()).replace(/\n+/g, " | ").slice(0, 3000)); console.log(await p.locator("a").evaluateAll((els) => els.map((e) => e.getAttribute("href")).filter((h) => h && /activity|transaction|detail|payment/i.test(h)).slice(0, 15))); }
  await shot(p, "buyer-activity");
} catch (e) { console.log("ERR:", e.message.split("\n")[0]); await shot(p, "buyer-activity-err"); }
await b.close();
