import { launch, login, shot, blocked } from "./buyer-lib.mjs";
const { b, p } = await launch();
const CASE = process.argv[2]; // the dispute id the sandbox buyer filed
const URL=`https://www.sandbox.paypal.com/resolutioncenter/view/${CASE}?locale.x=en_US`;
const body=async()=> (await p.locator("body").innerText().catch(()=>"")).replace(/\n+/g," | ");
try {
await p.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
await p.waitForTimeout(3000);
if (await p.locator("#password").count()) { await login(p); await p.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 }); }
await p.waitForTimeout(6000);
await p.getByRole("button",{name:"Tolak"}).click({timeout:1000}).catch(()=>{});
console.log("url:",p.url().split("?")[0].replace("https://www.sandbox.paypal.com",""),"blocked:",await blocked(p));
console.log((await body()).slice(100,1200));
console.log("buttons:", await p.getByRole("button").allInnerTexts());
console.log("links:", await p.getByRole("link").allInnerTexts());
await shot(p,"acc-1");
await p.getByRole("button",{name:/^Accept$/}).first().click();
await p.waitForTimeout(4000);
await shot(p,"acc-2");
console.log("after click:", (await body()).slice(100,900));
await p.getByRole("button",{name:"Confirm"}).click();
await p.waitForTimeout(6000);
await shot(p,"acc-3");
console.log("after confirm:", (await body()).slice(100,700));
} catch(e){ console.log("ERR:", e.message.split("\n")[0]); await shot(p,"acc-err"); }
await b.close();
