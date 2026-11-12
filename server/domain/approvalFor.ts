import { hashApprovalBinding, type ApprovalBinding } from "./approval.js";
import type { Incident } from "./repo.js";

export function bindingFor(i: Pick<Incident, "id" | "remedy" | "amountCents" | "disputeId" | "version">): ApprovalBinding {
  return {
    incidentId: i.id,
    remedy: i.remedy ?? "abstain",
    amountCents: i.amountCents ?? 0,
    disputeId: i.disputeId ?? "",
    incidentVersion: i.version,
  };
}

export function approvalHashFor(i: Pick<Incident, "id" | "remedy" | "amountCents" | "disputeId" | "version">): string {
  return hashApprovalBinding(bindingFor(i));
}
