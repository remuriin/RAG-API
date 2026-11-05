// Loaded first by the CLI: reads RAG-API/.env and points every src/ module at the eval
// instance, before any of them is imported (src/config.ts reads INSTANCE_ID when it loads).
import { config } from "dotenv";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const RAG_DIR = join(HARNESS_DIR, "..");

config({ path: join(RAG_DIR, ".env"), quiet: true });

// The test content (corpus, facts, cases) and the results live in a private repo, so held-out
// cases and the test product never become public. EVAL_DATA_DIR points at it.
const dataDir = process.env.EVAL_DATA_DIR?.trim();
if (!dataDir && !process.argv.includes("help") && process.argv.length > 2) {
  console.error("EVAL_DATA_DIR is not set in RAG-API/.env. See eval/README.md, \"Running the suite\".");
  process.exit(1);
}
export const EVAL_DIR = resolve(RAG_DIR, dataDir ?? ".");
export const RESULTS_DIR = join(EVAL_DIR, "results");

const evalInstance = process.env.EVAL_INSTANCE_ID?.trim();
if (evalInstance) {
  process.env.INSTANCE_ID = evalInstance;
} else if (!process.argv.includes("help") && process.argv.length > 2) {
  console.error("EVAL_INSTANCE_ID is not set in RAG-API/.env. See eval/README.md, \"Running the suite\".");
  process.exit(1);
}

// Hard cap on Anthropic spend recorded in results/ledger.jsonl, in US dollars
export const BUDGET_USD = Number(process.env.EVAL_BUDGET_USD ?? 95);
export const GEMINI_JUDGE_MODEL = process.env.EVAL_GEMINI_JUDGE ?? "gemini-3.8-flash";
export const CLAUDE_JUDGE_MODEL = "claude-opus-5-5";
// Pause between Gemini calls, for the free tier's per-minute limit
export const GEMINI_DELAY_MS = Number(process.env.EVAL_GEMINI_DELAY_MS ?? 4000);
