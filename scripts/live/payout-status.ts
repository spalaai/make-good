/** Read-only: prints PayPal's own view of a payout batch and its items. npx tsx scripts/live/payout-status.ts <paypalBatchId> */
import "../../server/loadEnv.js";
import { paypalFetch } from "../../server/adapters/paypal/http.js";
const id = process.argv[2];
if (!id) { console.error("Usage: payout-status.ts <paypalBatchId>"); process.exit(2); }
const res = await paypalFetch(fetch, `/v1/payments/payouts/${encodeURIComponent(id)}`, { method: "GET" });
const j = (await res.json()) as any;
console.log(JSON.stringify({
  http: res.status, batch_status: j.batch_header?.batch_status, sender_batch_id: j.batch_header?.sender_batch_header?.sender_batch_id,
  amount: j.batch_header?.amount, items: (j.items ?? []).map((i: any) => ({ payout_item_id: i.payout_item_id, transaction_id: i.transaction_id, transaction_status: i.transaction_status, amount: i.payout_item?.amount })),
}, null, 2));
