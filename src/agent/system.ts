import { execFile } from "child_process";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import { isUuid } from "../util/uuid.js";
import {
  DRY_RUN,
  ENV_DIR,
  GEMINI_API_KEY,
  INSTANCE_DATABASE_URL,
  INTERNAL_SECRET,
  NGINX_DIR,
  RAG_CTL,
  ROUTE_TEMPLATE,
} from "./config.js";

const execFileAsync = promisify(execFile);

const HEALTH_TIMEOUT_MS = 15000;
const HEALTH_INTERVAL_MS = 500;

// Instance ids end up in file paths and unit names, so nothing but a UUID is ever accepted.
function assertUuid(id: string): void {
  if (!isUuid(id)) throw new Error(`Refusing to act on a non-UUID instance id: ${id}`);
}

const envPath = (id: string) => join(ENV_DIR, `${id}.env`);
const routePath = (id: string) => join(NGINX_DIR, `${id}.conf`);

function envFileContent(id: string, port: number): string {
  // a dry run leaves no secrets lying around in the temp folder
  const secret = (value: string) => (DRY_RUN ? "<omitted in dry run>" : value);
  const lines = [
    `INSTANCE_ID=${id}`,
    `PORT=${port}`,
    `DATABASE_URL=${secret(INSTANCE_DATABASE_URL)}`,
    `GEMINI_API_KEY=${secret(GEMINI_API_KEY)}`,
  ];
  if (INTERNAL_SECRET) lines.push(`INTERNAL_SECRET=${secret(INTERNAL_SECRET)}`);
  return lines.join("\n") + "\n";
}

export async function writeEnvFile(id: string, port: number): Promise<void> {
  assertUuid(id);
  await mkdir(ENV_DIR, { recursive: true });
  await writeFile(envPath(id), envFileContent(id, port), { mode: 0o600 });
}

// Brings an existing env file up to date with the agent's current settings.
// Returns true if the file had to be rewritten (the service then needs a restart to pick it up).
export async function syncEnvFile(id: string, port: number): Promise<boolean> {
  assertUuid(id);
  const current = await readFile(envPath(id), "utf-8").catch(() => null);
  if (current === envFileContent(id, port)) return false;
  await writeEnvFile(id, port);
  return true;
}

export async function writeRoute(id: string, port: number): Promise<void> {
  assertUuid(id);
  const template = await readFile(ROUTE_TEMPLATE, "utf-8");
  const route = template.replaceAll("INSTANCE_ID", id).replaceAll("PORT", String(port));
  await mkdir(NGINX_DIR, { recursive: true });
  await writeFile(routePath(id), route, { mode: 0o644 });
}

export async function removeEnvFile(id: string): Promise<void> {
  assertUuid(id);
  await rm(envPath(id), { force: true });
}

export async function removeRoute(id: string): Promise<void> {
  assertUuid(id);
  await rm(routePath(id), { force: true });
}

// Runs the root-owned helper through sudo. execFile passes arguments as-is, with no shell involved.
async function ctl(...args: string[]): Promise<void> {
  if (DRY_RUN) {
    console.log(`  [dry run] rag-ctl ${args.join(" ")}`);
    return;
  }
  try {
    await execFileAsync("sudo", ["-n", RAG_CTL, ...args], { timeout: 60000 });
  } catch (err: any) {
    const detail = String(err?.stderr || err?.message || err).trim();
    throw new Error(`rag-ctl ${args[0]} failed: ${detail}`);
  }
}

export async function startService(id: string): Promise<void> {
  assertUuid(id);
  await ctl("start", id);
}

export async function stopService(id: string): Promise<void> {
  assertUuid(id);
  await ctl("stop", id);
}

// Tests the nginx config first; a failed test leaves the running config untouched.
export async function reloadNginx(): Promise<void> {
  await ctl("reload-nginx");
}

export async function waitForHealth(port: number): Promise<void> {
  if (DRY_RUN) {
    console.log(`  [dry run] skipping health check on port ${port}`);
    return;
  }
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS));
  }
  throw new Error(`The service did not answer on /health within ${HEALTH_TIMEOUT_MS / 1000}s`);
}
