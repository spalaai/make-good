import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { BundleRecord, Decision, FaultProposal, IncidentStatus, Remedy } from "../types.js";
import type { AiSource } from "../adapters/ai.js";
import type { JudgeChecked } from "./judge.js";

export type Purchase = {
  id: string;
  fixtureKey: string | null;
  orderId: string;
  captureId: string | null;
  amountCents: number;
  currency: string;
  buyerEmail: string | null;
  merchantName: string;
  operatorName: string;
  records: BundleRecord[];
  createdAt: string;
};

export type Incident = {
  id: string;
  purchaseId: string;
  complaint: string;
  claimedCents: number | null;
  status: IncidentStatus;
  version: number;
  disputeId: string | null;
  disputeStatus: string | null;
  disputeStage: string | null;
  disputeAllowed: string[];
  disputeSyncedAt: string | null;
  proposal: FaultProposal | null;
  aiSource: AiSource | null;
  decision: Decision | null;
  /** The independent judge's checked verdict and where it came from. Null before the first proposal, or when the judge could not be reached. */
  judge: JudgeChecked | null;
  judgeSource: AiSource | null;
  remedy: Remedy | null;
  amountCents: number | null;
  approvalHash: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  refundId: string | null;
  offerMadeAt: string | null;
  evidenceNote: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

type Row = Record<string, unknown>;

const json = <T>(v: unknown): T | null => (typeof v === "string" ? (JSON.parse(v) as T) : null);

export function rowToPurchase(r: Row): Purchase {
  return {
    id: String(r.id),
    fixtureKey: (r.fixture_key as string | null) ?? null,
    orderId: String(r.order_id),
    captureId: (r.capture_id as string | null) ?? null,
    amountCents: Number(r.amount_cents),
    currency: String(r.currency),
    buyerEmail: (r.buyer_email as string | null) ?? null,
    merchantName: String(r.merchant_name),
    operatorName: String(r.operator_name),
    records: json<BundleRecord[]>(r.records_json) ?? [],
    createdAt: String(r.created_at),
  };
}

export function rowToIncident(r: Row): Incident {
  return {
    id: String(r.id),
    purchaseId: String(r.purchase_id),
    complaint: String(r.complaint),
    claimedCents: r.claimed_cents == null ? null : Number(r.claimed_cents),
    status: String(r.status) as IncidentStatus,
    version: Number(r.version),
    disputeId: (r.dispute_id as string | null) ?? null,
    disputeStatus: (r.dispute_status as string | null) ?? null,
    disputeStage: (r.dispute_stage as string | null) ?? null,
    disputeAllowed: json<string[]>(r.dispute_allowed_json) ?? [],
    disputeSyncedAt: (r.dispute_synced_at as string | null) ?? null,
    proposal: json<FaultProposal>(r.proposal_json),
    aiSource: json<AiSource>(r.ai_source_json),
    decision: json<Decision>(r.decision_json),
    judge: json<JudgeChecked>(r.judge_json),
    judgeSource: json<AiSource>(r.judge_source_json),
    remedy: (r.remedy as Remedy | null) ?? null,
    amountCents: r.amount_cents == null ? null : Number(r.amount_cents),
    approvalHash: (r.approval_hash as string | null) ?? null,
    approvedBy: (r.approved_by as string | null) ?? null,
    approvedAt: (r.approved_at as string | null) ?? null,
    refundId: (r.refund_id as string | null) ?? null,
    offerMadeAt: (r.offer_made_at as string | null) ?? null,
    evidenceNote: (r.evidence_note as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function getPurchase(db: DatabaseSync, id: string): Purchase | null {
  const r = db.prepare("SELECT * FROM purchases WHERE id = ?").get(id) as Row | undefined;
  return r ? rowToPurchase(r) : null;
}

export function getIncident(db: DatabaseSync, id: string): Incident | null {
  const r = db.prepare("SELECT * FROM incidents WHERE id = ?").get(id) as Row | undefined;
  return r ? rowToIncident(r) : null;
}

export function listIncidents(db: DatabaseSync): Incident[] {
  return (db.prepare("SELECT * FROM incidents ORDER BY created_at DESC, rowid DESC").all() as Row[]).map(rowToIncident);
}

export function listPurchases(db: DatabaseSync): Purchase[] {
  return (db.prepare("SELECT * FROM purchases ORDER BY created_at DESC, rowid DESC").all() as Row[]).map(rowToPurchase);
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/** Move an incident from one status to another only if it is still in the expected status. Returns true when this call made the change. */
export function claim(db: DatabaseSync, id: string, from: IncidentStatus[], to: IncidentStatus): boolean {
  const marks = from.map(() => "?").join(",");
  const r = db
    .prepare(`UPDATE incidents SET status = ?, updated_at = ? WHERE id = ? AND status IN (${marks})`)
    .run(to, new Date().toISOString(), id, ...from);
  return Number(r.changes) === 1;
}

export function setStatus(db: DatabaseSync, id: string, status: IncidentStatus, error: string | null = null): void {
  db.prepare("UPDATE incidents SET status = ?, error = ?, updated_at = ? WHERE id = ?").run(status, error, new Date().toISOString(), id);
}
