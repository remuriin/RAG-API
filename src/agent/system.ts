import { execFile } from "child_process";
import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import { isUuid } from "../util/uuid.js";
import { DRY_RUN, ENV_DIR, GEMINI_API_KEY, INSTANCE_DATABASE_URL, INTERNAL_SECRET, RAG_CTL } from "./config.js";

const execFileAsync = promisify(execFile);

const HEALTH_TIMEOUT_MS = 15000;
const HEALTH_INTERVAL_MS = 500;

// Instance ids end up in file paths and unit names, so nothing but a UUID is ever accepted.
function assertUuid(id: string): void {
  if (!isUuid(id)) throw new Error(`Refusing to act on a non-UUID instance id: ${id}`);
}

const envPath = (id: string) => join(ENV_DIR, `${id}.env`);

// systemd reads EnvironmentFile with shell-like quoting: inside double quotes only \" and \\ are special
function quoted(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error("an env value contains a line break");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function envFileContent(id: string, port: number): string {
  // a dry run leaves no secrets lying around in the temp folder
  const secret = (value: string) => (DRY_RUN ? "<omitted in dry run>" : value);
  const lines = [
    `INSTANCE_ID=${id}`,
    `PORT=${port}`,
    `DATABASE_URL=${quoted(secret(INSTANCE_DATABASE_URL))}`,
    `GEMINI_API_KEY=${quoted(secret(GEMINI_API_KEY))}`,
  ];
  if (INTERNAL_SECRET) lines.push(`INTERNAL_SECRET=${quoted(secret(INTERNAL_SECRET))}`);
  return lines.join("\n") + "\n";
}

// Written to a temporary name and renamed into place, so a crash halfway never leaves a half file
// that systemd would then read on the next restart.
export async function writeEnvFile(id: string, port: number): Promise<void> {
  assertUuid(id);
  await mkdir(ENV_DIR, { recursive: true });
  const target = envPath(id);
  await writeFile(`${target}.tmp`, envFileContent(id, port), { mode: 0o600 });
  await rename(`${target}.tmp`, target);
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

export async function removeEnvFile(id: string): Promise<void> {
  assertUuid(id);
  await rm(envPath(id), { force: true });
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

// The nginx route is written by the root helper from its own template, so this process never
// puts anything into nginx's config folder itself. Both calls test the config and reload nginx.
export async function addRoute(id: string, port: number): Promise<void> {
  assertUuid(id);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`Refusing to route to port ${port}`);
  await ctl("route", id, String(port));
}

export async function removeRoute(id: string): Promise<void> {
  assertUuid(id);
  await ctl("unroute", id);
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
