// Prints the buyer's recent activity lines from the account summary page (no screenshot while typing).
import { launch, login, blocked } from "./buyer-lib.mjs";
const { b, p } = await launch();
const U = "https://www.sandbox.paypal.com/myaccount/summary?locale.x=en_US";
try {
  await p.goto(U, { waitUntil: "domcontentloaded", timeout: 60000 });
  await p.waitForTimeout(3000);
  if (await p.locator("#password").count()) await login(p);
  await p.goto(U, { waitUntil: "domcontentloaded", timeout: 60000 });
  await p.waitForTimeout(7000);
  if (await blocked(p)) { console.log("BLOCKED"); process.exitCode = 1; }
  const t = (await p.locator("body").innerText()).replace(/\n+/g, " | ");
  const i = Math.max(t.indexOf("Aktivitas terakhir"), t.indexOf("Recent activity"));
  console.log(t.slice(i, i + 420));
} catch (e) { console.log("ERR:", e.message.split("\n")[0]); }
await b.close();
