import type { PaymentsAdapter } from "../payments.js";
import { MockPayPalAdapter } from "./mock.js";
import { SandboxPayPalAdapter } from "./sandbox.js";

export function resolvePayPalMode(): "mock" | "sandbox" {
  const explicit = (process.env.PAYPAL_MODE ?? "").toLowerCase();
  if (explicit === "mock") return "mock";
  if (explicit === "sandbox") return "sandbox";
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
    return "mock";
  }
  return "sandbox";
}

export function createPayPalPaymentsAdapter(fetchImpl?: typeof fetch): PaymentsAdapter {
  const mode = resolvePayPalMode();
  if (mode === "mock") return new MockPayPalAdapter();
  return new SandboxPayPalAdapter(fetchImpl);
}
