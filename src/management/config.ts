function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

export const MGMT_PORT = Number(process.env.MGMT_PORT ?? 4000);
export const MGMT_HOST = process.env.MGMT_HOST ?? "127.0.0.1"; // nginx is the public entry

// Only the project id is needed to verify ID tokens; no service account key
export const FIREBASE_PROJECT_ID = required("FIREBASE_PROJECT_ID");

// Where clients reach their instance: <PUBLIC_BASE_URL>/i/<instanceId>
export const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? "https://rag.140-245-60-8.sslip.io").replace(/\/+$/, "");

// Optional: a dashboard origin allowed to call this API from the browser (e.g. http://localhost:5173)
export const CORS_ORIGIN = process.env.CORS_ORIGIN?.trim() || undefined;

export const MAX_INSTANCES_PER_USER = Number(process.env.MAX_INSTANCES_PER_USER ?? 3);
