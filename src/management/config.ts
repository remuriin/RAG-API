function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

export const MGMT_PORT = integer("MGMT_PORT", 4050);
export const MGMT_HOST = process.env.MGMT_HOST ?? "127.0.0.1"; // nginx is the public entry

// Only the project id is needed to verify ID tokens; no service account key
export const FIREBASE_PROJECT_ID = required("FIREBASE_PROJECT_ID");

// Where clients reach their instance: <PUBLIC_BASE_URL>/i/<instanceId>
export const PUBLIC_BASE_URL = required("PUBLIC_BASE_URL").replace(/\/+$/, "");

// Optional: a dashboard origin allowed to call this API from the browser (e.g. http://localhost:5173)
export const CORS_ORIGIN = process.env.CORS_ORIGIN?.trim() || undefined;

function integer(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a whole number`);
  return value;
}

export const MAX_INSTANCES_PER_USER = integer("MAX_INSTANCES_PER_USER", 3);
