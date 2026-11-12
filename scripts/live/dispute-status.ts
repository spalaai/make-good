/**
 * Read-only: prints a dispute's status, reason and linked capture, and (with --wait) polls until the seller can act.
 *   npx tsx scripts/live/dispute-status.ts <disputeId> [--wait]
 */
import "../../server/loadEnv.js";
import { paypalFetch } from "../../server/adapters/paypal/http.js";

const id = process.argv[2];
const wait = process.argv.includes("--wait");
if (!id) { console.error("Usage: dispute-status.ts <disputeId> [--wait]"); process.exit(2); }
type D = { status?: string; reason?: string; dispute_stage?: string; create_time?: string; disputed_transactions?: Array<{ seller_transaction_id?: string }>; links?: Array<{ rel: string }> };
const t0 = Date.now();
for (;;) {
  const res = await paypalFetch(fetch, `/v1/customer/disputes/${encodeURIComponent(id)}`, { method: "GET" });
  const d = (await res.json()) as D;
  const acts = (d.links ?? []).map((l) => l.rel).filter((r) => r !== "self");
  console.log(`${new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Makassar" })} WITA +${Math.round((Date.now() - t0) / 1000)}s http=${res.status} status=${d.status} stage=${d.dispute_stage} reason=${d.reason} capture=${d.disputed_transactions?.[0]?.seller_transaction_id} created=${d.create_time} actions=[${acts.join(",")}]`);
  if (!wait || d.status === "WAITING_FOR_SELLER_RESPONSE" || d.status === "RESOLVED" || Date.now() - t0 > 12 * 60_000) break;
  await new Promise((r) => setTimeout(r, 20_000));
}
