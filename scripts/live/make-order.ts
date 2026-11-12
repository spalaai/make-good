/**
 * Dispute factory, merchant half. The buyer half (approve, file, accept) has to be done in PayPal's pages, see scripts/sandbox/.
 *
 *   npx tsx scripts/live/make-order.ts create 20.00     -> creates a sandbox order, prints its id
 *   npx tsx scripts/live/make-order.ts status <orderId>  -> prints the order status
 *   npx tsx scripts/live/make-order.ts capture <orderId> -> after the buyer approved it, captures it, prints the capture id
 *
 * Sandbox only (the PayPal client refuses any other host).
 */
import "../../server/loadEnv.js";
import { randomUUID } from "node:crypto";
import { paypalFetch } from "../../server/adapters/paypal/http.js";

const [cmd, arg] = process.argv.slice(2);

async function main() {
  if (cmd === "create") {
    const value = Number(arg ?? "20.00").toFixed(2);
    const res = await paypalFetch(fetch, "/v2/checkout/orders", {
      method: "POST",
      idempotencyKey: `mg-order-${randomUUID()}`,
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{ description: "Make Good sandbox purchase", amount: { currency_code: "USD", value } }],
      }),
    });
    const j = (await res.json()) as { id?: string; status?: string };
    if (!res.ok) throw new Error(`create failed: ${res.status}`);
    console.log(`order ${j.id} ${j.status} ${value} USD. The sandbox buyer approves it with: node scripts/sandbox/g1-approve.mjs ${j.id}`);
  } else if (cmd === "status" && arg) {
    const res = await paypalFetch(fetch, `/v2/checkout/orders/${encodeURIComponent(arg)}`, { method: "GET" });
    const j = (await res.json()) as { id?: string; status?: string };
    if (!res.ok) throw new Error(`status failed: ${res.status}`);
    console.log(`order ${j.id} ${j.status}`);
  } else if (cmd === "capture" && arg) {
    const res = await paypalFetch(fetch, `/v2/checkout/orders/${encodeURIComponent(arg)}/capture`, { method: "POST", idempotencyKey: `mg-capture-${arg}`, body: "{}" });
    const j = (await res.json()) as { status?: string; purchase_units?: Array<{ payments?: { captures?: Array<{ id: string; status: string }> } }> };
    if (!res.ok) throw new Error(`capture failed: ${res.status}`);
    const c = j.purchase_units?.[0]?.payments?.captures?.[0];
    console.log(`order ${arg} ${j.status}, capture ${c?.id} ${c?.status}`);
  } else {
    console.error("Usage: make-order.ts create <amount> | status <orderId> | capture <orderId>");
    process.exit(2);
  }
}
main().catch((e) => {
  console.error("FAILED:", String((e as Error).message).slice(0, 300));
  process.exit(1);
});
