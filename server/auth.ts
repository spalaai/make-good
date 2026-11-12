import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export type SessionPayload = {
  userId: string;
  username: string;
  role: "agent" | "owner";
  exp: number;
};

function getSecret(): string {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  // Demo only: a fixed secret outside production so a dev restart does not log everyone out.
  if (process.env.NODE_ENV !== "production") return "make-good-dev-secret-not-for-production";
  return randomBytes(32).toString("hex");
}

let secret = getSecret();

export function resetAuthSecretForTests(s: string): void {
  secret = s;
}

function b64url(data: string): string {
  return Buffer.from(data, "utf8").toString("base64url");
}

function fromB64url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

export function signToken(payload: Omit<SessionPayload, "exp">): string {
  const full: SessionPayload = { ...payload, exp: Date.now() + TOKEN_TTL_MS };
  const body = b64url(JSON.stringify(full));
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyToken(token: string): SessionPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  try {
    const a = Buffer.from(sig, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  try {
    const payload = JSON.parse(fromB64url(body)) as SessionPayload;
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function hashPassword(password: string, salt: string): string {
  return createHmac("sha256", salt).update(password).digest("hex");
}

export const DEMO_SALT = "make-good-demo-salt";
