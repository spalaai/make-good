import { PAYPAL_SANDBOX_HOST, PAYPAL_SANDBOX_ORIGIN } from "./constants.js";

export class PayPalHostError extends Error {
  constructor(host: string) {
    super(`PayPal API host not allowed: ${host}. Only ${PAYPAL_SANDBOX_HOST} is permitted.`);
    this.name = "PayPalHostError";
  }
}

export function resolvePayPalApiBase(): string {
  const override = process.env.PAYPAL_API_BASE_URL?.replace(/\/$/, "");
  if (override) {
    if (process.env.PAYPAL_TEST_ALLOW_CUSTOM_HOST !== "true") {
      throw new PayPalHostError(new URL(override).host);
    }
    return override;
  }
  return PAYPAL_SANDBOX_ORIGIN;
}

export function assertAllowedPayPalUrl(url: string): void {
  const parsed = new URL(url);
  const override = process.env.PAYPAL_API_BASE_URL?.replace(/\/$/, "");
  if (parsed.host === "api-m.paypal.com" || parsed.host === "api.paypal.com") {
    throw new PayPalHostError(parsed.host);
  }
  if (override && process.env.PAYPAL_TEST_ALLOW_CUSTOM_HOST === "true") {
    const allowed = new URL(override).origin;
    if (parsed.origin !== allowed) {
      throw new PayPalHostError(parsed.host);
    }
    return;
  }
  if (parsed.host !== PAYPAL_SANDBOX_HOST) {
    throw new PayPalHostError(parsed.host);
  }
  if (parsed.protocol !== "https:") {
    throw new PayPalHostError(parsed.host);
  }
}

type TokenCache = {
  accessToken: string;
  expiresAtMs: number;
};

let tokenCache: TokenCache | null = null;

export function resetPayPalTokenCacheForTests(): void {
  tokenCache = null;
}

export async function getAccessToken(fetchImpl: typeof fetch): Promise<string> {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("PayPal sandbox credentials missing");
  }
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAtMs > now + 60_000) {
    return tokenCache.accessToken;
  }
  const base = resolvePayPalApiBase();
  const url = `${base}/v1/oauth2/token`;
  assertAllowedPayPalUrl(url);
  const body = new URLSearchParams({ grant_type: "client_credentials" });
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
    signal: AbortSignal.timeout(Number(process.env.PAYPAL_TIMEOUT_MS ?? 20000)),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPal OAuth failed: ${res.status} ${text}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = {
    accessToken: json.access_token,
    expiresAtMs: now + json.expires_in * 1000,
  };
  return tokenCache.accessToken;
}

export async function paypalFetch(
  fetchImpl: typeof fetch,
  path: string,
  init: RequestInit & { idempotencyKey?: string } = {},
): Promise<Response> {
  const base = resolvePayPalApiBase();
  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  assertAllowedPayPalUrl(url);

  const doRequest = async (forceNewToken: boolean) => {
    if (forceNewToken) tokenCache = null;
    const token = await getAccessToken(fetchImpl);
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    };
    if (init.idempotencyKey) {
      headers["PayPal-Request-Id"] = init.idempotencyKey;
    }
    const { idempotencyKey: _drop, ...rest } = init;
    const timeoutMs = Number(process.env.PAYPAL_TIMEOUT_MS ?? 20000);
    const signal = rest.signal ?? AbortSignal.timeout(timeoutMs);
    return fetchImpl(url, { ...rest, headers, signal });
  };

  let res = await doRequest(false);
  if (res.status === 401) {
    res = await doRequest(true);
  }
  return res;
}

/** True when a thrown fetch error means "it is unknown whether PayPal processed it" (timeout, reset, DNS drop). */
export function isIndeterminateNetworkError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e.name === "TimeoutError" || e.name === "AbortError") return true;
  // undici reports dropped connections as TypeError("fetch failed"). Other TypeErrors are bugs in this code.
  if (e instanceof TypeError && e.message === "fetch failed") return true;
  return false;
}
