// Control agent: no port, no endpoints. It watches the instances table and sets services up or tears them down.
import "dotenv/config";
import { pool } from "../db/client.js";
import { DRY_RUN, POLL_MS } from "./config.js";
import { findWork, provision, syncActiveInstances, teardown, type PendingWork } from "./provision.js";

const MAX_BACKOFF_MS = 60000;

// A teardown that keeps failing is retried with growing pauses instead of every poll
const retryAfter = new Map<string, { at: number; failures: number }>();

let stopping = false;

async function handle(work: PendingWork): Promise<void> {
  const waiting = retryAfter.get(work.id);
  if (waiting && Date.now() < waiting.at) return;

  try {
    if (work.status === "pending") {
      console.log(`provisioning ${work.id}`);
      await provision(work);
      console.log(`  ${work.id} is active`);
    } else {
      console.log(`tearing down ${work.id}`);
      await teardown(work);
      console.log(`  ${work.id} removed`);
    }
    retryAfter.delete(work.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  ${work.status === "pending" ? "provisioning" : "teardown"} of ${work.id} failed: ${message}`);
    // a failed provision is marked 'failed' and drops out of the work list; only teardowns come back
    const failures = (waiting?.failures ?? 0) + 1;
    retryAfter.set(work.id, { at: Date.now() + Math.min(POLL_MS * 2 ** failures, MAX_BACKOFF_MS), failures });
  }
}

async function main() {
  console.log(`control agent started${DRY_RUN ? " (dry run)" : ""}, polling every ${POLL_MS / 1000}s`);

  try {
    await syncActiveInstances();
  } catch (err) {
    console.error("startup sync failed:", err instanceof Error ? err.message : err);
  }

  // The first pass picks up anything requested while the agent was down
  while (!stopping) {
    try {
      // one at a time, so port assignment and nginx reloads never overlap
      for (const work of await findWork()) {
        if (stopping) break;
        await handle(work);
      }
    } catch (err) {
      console.error("poll failed:", err instanceof Error ? err.message : err);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  await pool.end();
}

function shutdown() {
  stopping = true;
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
