import { createHash } from "node:crypto";
import type { Remedy } from "../types.js";

/**
 * The owner approves exactly this: one incident, one remedy, one amount, one dispute (or none), at one version.
 * If any of them changes after the proposal, the token no longer matches and the approval is refused.
 */
export type ApprovalBinding = {
  incidentId: string;
  remedy: Remedy;
  amountCents: number;
  disputeId: string;
  incidentVersion: number;
};

export function hashApprovalBinding(binding: ApprovalBinding): string {
  const payload = JSON.stringify({
    incidentId: binding.incidentId,
    remedy: binding.remedy,
    amountCents: binding.amountCents,
    disputeId: binding.disputeId,
    incidentVersion: binding.incidentVersion,
  });
  return createHash("sha256").update(payload).digest("hex");
}

export function approvalTokenMatches(presented: string | null | undefined, stored: string | null, binding: ApprovalBinding): boolean {
  if (!presented || !stored) return false;
  const current = hashApprovalBinding(binding);
  return presented === stored && stored === current;
}
