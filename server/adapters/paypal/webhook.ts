import type { WebhookHeaders, WebhookVerifier } from "../../domain/ctx.js";
import { paypalFetch } from "./http.js";

const h = (headers: WebhookHeaders, name: string): string => {
  const v = headers[name];
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
};

/**
 * Asks PayPal to verify a webhook delivery (POST /v1/notifications/verify-webhook-signature).
 * Needs PAYPAL_WEBHOOK_ID, the id PayPal gave when the webhook was registered. Without it nothing is verified.
 * Written from PayPal's documented request and tested with a mocked fetch. It has not been run against a real delivery,
 * because that needs a public URL registered with PayPal.
 */
export function createPayPalWebhookVerifier(webhookId: string | undefined, fetchImpl: typeof fetch = globalThis.fetch): WebhookVerifier {
  return async (headers, event) => {
    if (!webhookId) return false;
    const body = {
      auth_algo: h(headers, "paypal-auth-algo"),
      cert_url: h(headers, "paypal-cert-url"),
      transmission_id: h(headers, "paypal-transmission-id"),
      transmission_sig: h(headers, "paypal-transmission-sig"),
      transmission_time: h(headers, "paypal-transmission-time"),
      webhook_id: webhookId,
      webhook_event: event,
    };
    if (!body.transmission_id || !body.transmission_sig) return false;
    try {
      const res = await paypalFetch(fetchImpl, "/v1/notifications/verify-webhook-signature", { method: "POST", body: JSON.stringify(body) });
      if (!res.ok) return false;
      return ((await res.json()) as { verification_status?: string }).verification_status === "SUCCESS";
    } catch {
      return false;
    }
  };
}
