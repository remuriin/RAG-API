import { tmpdir } from "os";
import { join } from "path";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

// Dry run exercises the status handling without systemd or nginx (for development on a non-Linux machine).
export const DRY_RUN = process.env.AGENT_DRY_RUN === "true";
const dryRunDir = join(tmpdir(), "rag-agent-dry-run");

export const POLL_MS = Number(process.env.AGENT_POLL_MS ?? 2000);
export const FIRST_PORT = 4101;

export const ENV_DIR = process.env.AGENT_ENV_DIR ?? (DRY_RUN ? join(dryRunDir, "env") : "/etc/rag");
export const NGINX_DIR =
  process.env.AGENT_NGINX_DIR ?? (DRY_RUN ? join(dryRunDir, "nginx") : "/etc/nginx/rag-instances");
export const ROUTE_TEMPLATE =
  process.env.AGENT_ROUTE_TEMPLATE ?? join(process.cwd(), "deploy", "nginx", "instance.conf.example");

// The only way the agent performs root actions (see deploy/rag-ctl)
export const RAG_CTL = process.env.AGENT_RAG_CTL ?? "/usr/local/sbin/rag-ctl";

// Written into each instance's env file
export const INSTANCE_DATABASE_URL = process.env.INSTANCE_DATABASE_URL?.trim() || required("DATABASE_URL");
export const GEMINI_API_KEY = required("GEMINI_API_KEY");
// Shared with the management API so it can call instances on the owner's behalf. Optional:
// without it, instances are only reachable with their API key.
export const INTERNAL_SECRET = process.env.INTERNAL_SECRET?.trim() || undefined;
