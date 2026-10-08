import { createHash, randomBytes } from "crypto";

// Only the hash is stored. Keys are long and random, so a plain SHA-256 is enough.
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function generateApiKey(): { key: string; hash: string; prefix: string } {
  const key = `rag_${randomBytes(32).toString("base64url")}`;
  return { key, hash: hashApiKey(key), prefix: key.slice(0, 12) };
}
