import type { Ctx } from "./ctx.js";
import { syncIncidentDispute } from "./disputes.js";
import { logTechnical } from "./friendly.js";
import { executeIncident } from "./execute.js";
import { getPayoutForIncident, pollPayout, sendPayout } from "./payouts.js";
import { listIncidents } from "./repo.js";
import { proposeIncident } from "./propose.js";

/**
 * One pass of the background agent. Every step is claimed with a conditional update first, so two passes
 * (or a pass and a click) cannot do the same thing twice.
 */
export async function workerTick(ctx: Ctx): Promise<{ proposed: number; progressed: number }> {
  let proposed = 0;
  let progressed = 0;
  for (const inc of listIncidents(ctx.db)) {
    try {
      if (inc.status === "new") {
        await proposeIncident(ctx, inc.id, { name: "make-good", role: "system" });
        proposed += 1;
      } else if (inc.status === "waiting_paypal") {
        await executeIncident(ctx, inc.id);
        progressed += 1;
      } else if (inc.status === "offer_made" && inc.disputeId) {
        await syncIncidentDispute(ctx, inc);
        progressed += 1;
      } else if (inc.status === "payout_sent") {
        await pollPayout(ctx, inc.id);
        progressed += 1;
      } else if (inc.status === "unknown") {
        const payout = getPayoutForIncident(ctx.db, inc.id);
        if (payout) {
          // Same sender_batch_id as before. If PayPal already has it, the answer is "duplicate" and the app looks it up.
          await sendPayout(ctx, inc.id);
          progressed += 1;
        } else if (inc.disputeId) {
          await syncIncidentDispute(ctx, inc);
          progressed += 1;
        }
      }
    } catch (e) {
      logTechnical("worker", e);
    }
  }
  return { proposed, progressed };
}
