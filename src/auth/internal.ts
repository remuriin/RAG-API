// Short-lived tokens the management API uses to call a RAG instance on the same machine.
// The management API has no API key for an instance (only hashes are stored), so the two
// share a secret that never leaves the VPS. A token is valid for one instance and one minute.
import { createHmac, timingSafeEqual } from "crypto";

const PREFIX = "int_"; // API keys start with "rag_", so the two can't be confused
const TTL_SECONDS = 60;

const secret = () => process.env.INTERNAL_SECRET?.trim() || undefined;

function signature(key: string, instanceId: string, expires: number): Buffer {
  return createHmac("sha256", key).update(`${instanceId}.${expires}`).digest();
}

export function internalAuthConfigured(): boolean {
  return secret() !== undefined;
}

export function isInternalToken(token: string): boolean {
  return token.startsWith(PREFIX);
}

export function signInternalToken(instanceId: string): string {
  const key = secret();
  if (!key) throw new Error("INTERNAL_SECRET must be set");
  const expires = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  return `${PREFIX}${expires}.${signature(key, instanceId, expires).toString("hex")}`;
}

export function verifyInternalToken(token: string, instanceId: string): boolean {
  const key = secret();
  if (!key) return false; // internal access is off unless the secret is configured

  const match = token.match(/^int_(\d{1,12})\.([0-9a-f]{64})$/);
  if (!match) return false;

  const expires = Number(match[1]);
  const now = Math.floor(Date.now() / 1000);
  // expired, or dated further ahead than any token this code would issue
  if (expires < now || expires > now + TTL_SECONDS + 5) return false;

  return timingSafeEqual(signature(key, instanceId, expires), Buffer.from(match[2], "hex"));
}
