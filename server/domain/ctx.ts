import type { DatabaseSync } from "node:sqlite";
import type { AiAdapter } from "../adapters/ai.js";
import type { PaymentsAdapter } from "../adapters/payments.js";
import type { Policy } from "./policy.js";

export type WebhookHeaders = Record<string, string | string[] | undefined>;
/** Says whether PayPal really sent this delivery. Without one, every webhook is refused. */
export type WebhookVerifier = (headers: WebhookHeaders, event: unknown) => Promise<boolean>;

export type Ctx = { db: DatabaseSync; ai: AiAdapter; payments: PaymentsAdapter; policy: Policy; webhookVerifier?: WebhookVerifier };
export type Actor = { name: string; role: "agent" | "owner" | "system" };

export class DomainError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
