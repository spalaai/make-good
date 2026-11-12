import { launch, login, shot, blocked } from "./buyer-lib.mjs";
const { b, p } = await launch();
const FILING = `https://www.sandbox.paypal.com/resolutioncenter/filing/${process.argv[2]}/create?locale.x=en_US`; // argv[2] is the buyer-side transaction id
const body=async()=> (await p.locator("body").innerText().catch(()=>"")).replace(/\n+/g," | ");
const cont=async()=>p.getByRole("button",{name:/^(Continue|Submit|Submit report|Send)$/i}).first().click();
try {
await p.goto(FILING, { waitUntil: "domcontentloaded", timeout: 60000 });
await p.waitForTimeout(3000);
if (await p.locator("#password").count()) { await login(p); await p.goto(FILING, { waitUntil: "domcontentloaded", timeout: 60000 }); }
for (let i=0;i<14;i++){
  await p.waitForTimeout(3500);
  await p.getByRole("button",{name:"Tolak"}).click({timeout:1000}).catch(()=>{});
  const t=await body(); console.log(`[${i}]`, p.url().split("?")[0].replace("https://www.sandbox.paypal.com",""), "|", t.slice(120,420));
  await shot(p,`f-step-${i}`);
  if (await blocked(p)) { console.log("BLOCKED"); break; }
  if (/Issues with your purchase/.test(t) && /I haven’t received the item or service/.test(t)) { await p.getByText("I haven’t received the item or service").first().click(); await p.waitForTimeout(1500); continue; }
  if (/Continue Reporting this Issue/.test(t)) { await p.getByText("Continue Reporting this Issue").first().click(); continue; }
  if (/Select the items you want to report/.test(t)) {
    await p.getByLabel("Item name").fill("Bali market report");
    await p.locator("select").nth(0).selectOption({label:"Service"});
    await p.locator("select").nth(1).selectOption({label:"Other"});
    await cont(); continue; }
  if (/I haven’t received the service/.test(t) && /Tell us a bit more/.test(t)) { await p.getByText("I haven’t received the service").first().click(); await cont(); continue; }
  if (/Provide other details/.test(t)) { console.log("inputs:", await p.locator("input").evaluateAll(e=>e.map(x=>`${x.id}|${x.name}|${x.type}|${x.getAttribute("aria-label")}`))); const amt=p.locator("input").filter({hasNot:p.locator("[type=hidden]")}).last(); await p.getByLabel(/Enter amount/i).first().fill("20.00"); await cont(); continue; }
  if (/Have you contacted the seller/.test(t)) { await p.getByText("Yes",{exact:true}).first().click(); await p.waitForTimeout(1500); console.log("after yes:", (await body()).slice(250,700)); await cont(); continue; }
  if (/Add documents to support your case/.test(t)) { await p.locator("textarea").first().fill("Sandbox test: the Bali market report I paid for was never delivered."); await cont(); continue; }
  console.log("UNHANDLED STEP, stopping"); break;
}
} catch(e){ console.log("ERR:", e.message.split("\n")[0]); await shot(p,"f-err"); }
await b.close();
