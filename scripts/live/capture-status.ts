/** Read-only: prints a sandbox capture's status and the order's refunds. npx tsx scripts/live/capture-status.ts <captureId> <orderId> */
import "../../server/loadEnv.js";
import { paypalFetch } from "../../server/adapters/paypal/http.js";
const [cap, order] = process.argv.slice(2);
if (!cap || !order) { console.error("Usage: capture-status.ts <captureId> <orderId>"); process.exit(2); }
const c = await (await paypalFetch(fetch, `/v2/payments/captures/${encodeURIComponent(cap)}`, { method: "GET" })).json() as any;
console.log("capture", c.id, c.status, c.amount?.value, c.seller_receivable_breakdown ? "" : "");
const o = await (await paypalFetch(fetch, `/v2/checkout/orders/${encodeURIComponent(order)}`, { method: "GET" })).json() as any;
for (const r of o.purchase_units?.[0]?.payments?.refunds ?? []) console.log("refund", r.id, r.status, r.amount?.value, r.create_time);
