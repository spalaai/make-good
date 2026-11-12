export type Policy = {
  /** Below this the rule abstains and a person decides. */
  minConfidence: number;
  /** Most the shop can be asked to refund through one offer or refund. */
  merchantRefundCapCents: number;
  /** Most the operator guarantee reimburses for one incident. A voluntary capped policy, not insurance. */
  operatorGuaranteeCapCents: number;
};

export const DEFAULT_POLICY: Policy = {
  minConfidence: 0.7,
  merchantRefundCapCents: 50_000,
  operatorGuaranteeCapCents: 2_500,
};

export function loadPolicy(env: Record<string, string | undefined> = process.env): Policy {
  const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  return {
    minConfidence: num(env.MG_MIN_CONFIDENCE, DEFAULT_POLICY.minConfidence),
    merchantRefundCapCents: Math.round(num(env.MG_MERCHANT_REFUND_CAP_CENTS, DEFAULT_POLICY.merchantRefundCapCents)),
    operatorGuaranteeCapCents: Math.round(num(env.MG_OPERATOR_GUARANTEE_CAP_CENTS, DEFAULT_POLICY.operatorGuaranteeCapCents)),
  };
}
