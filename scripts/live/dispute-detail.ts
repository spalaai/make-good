/** Read-only: prints PayPal's own view of a dispute (outcome, offer history, refund, messages summary). npx tsx scripts/live/dispute-detail.ts <disputeId> */
import "../../server/loadEnv.js";
import { paypalFetch } from "../../server/adapters/paypal/http.js";
const id = process.argv[2];
if (!id) { console.error("Usage: dispute-detail.ts <disputeId>"); process.exit(2); }
const res = await paypalFetch(fetch, `/v1/customer/disputes/${encodeURIComponent(id)}`, { method: "GET" });
const d = (await res.json()) as Record<string, any>;
console.log(JSON.stringify({
  http: res.status, status: d.status, reason: d.reason, outcome: d.dispute_outcome, lifecycle: d.dispute_life_cycle_stage, channel: d.dispute_channel,
  amount: d.dispute_amount, created: d.create_time, updated: d.update_time,
  offer: { buyer_requested_amount: d.offer?.buyer_requested_amount, seller_offered_amount: d.offer?.seller_offered_amount, offer_type: d.offer?.offer_type, history: (d.offer?.history ?? []).map((h: any) => ({ actor: h.actor, event_type: h.event_type, offer_type: h.offer_type, time: h.event_time, amount: h.offer_amount })) },
  messages: (d.messages ?? []).map((m: any) => ({ posted_by: m.posted_by, time: m.time_posted, content: String(m.content ?? "").slice(0, 120) })),
  refund_ids: (d.disputed_transactions ?? []).map((t: any) => t.seller_transaction_id),
}, null, 2));
