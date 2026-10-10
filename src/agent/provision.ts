import { pool } from "../db/client.js";
import { FIRST_PORT } from "./config.js";
import {
  addRoute,
  removeEnvFile,
  removeRoute,
  startService,
  stopService,
  syncEnvFile,
  waitForHealth,
  writeEnvFile,
} from "./system.js";

export interface PendingWork {
  id: string;
  port: number | null;
  status: "pending" | "deleting";
}

// What the owner sees on a failed service. The real reason goes to the journal: it names paths and
// units on this machine, which is for whoever runs it, not for the person who asked for a service.
const FAILED_MESSAGE = "Setting it up failed on our side. Delete this service and create it again; if it fails twice, contact support.";

export async function findWork(): Promise<PendingWork[]> {
  const result = await pool.query(
    "SELECT id, port, status FROM instances WHERE status IN ('pending', 'deleting') ORDER BY created_at"
  );
  return result.rows;
}

// Written on every poll. /api/health reports the agent as stale when this stops moving.
export async function heartbeat(): Promise<void> {
  await pool.query(
    "INSERT INTO agent_heartbeat (id, seen_at) VALUES (1, now()) ON CONFLICT (id) DO UPDATE SET seen_at = now()"
  );
}

// Run once when the agent starts: any running service whose env file no longer matches the
// agent's settings (a new internal secret, a changed Gemini key) is rewritten and restarted.
export async function syncActiveInstances(): Promise<void> {
  const result = await pool.query(
    "SELECT id, port FROM instances WHERE status = 'active' AND port IS NOT NULL ORDER BY created_at"
  );
  for (const { id, port } of result.rows) {
    try {
      if (await syncEnvFile(id, port)) {
        console.log(`env file of ${id} was out of date, rewritten; restarting the service`);
        await startService(id);
      }
    } catch (err) {
      console.error(`  could not sync ${id}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

async function assignPort(id: string): Promise<number> {
  const result = await pool.query(
    `UPDATE instances
     SET port = (SELECT COALESCE(MAX(port) + 1, $2::int) FROM instances)
     WHERE id = $1 AND port IS NULL
     RETURNING port`,
    [id, FIRST_PORT]
  );
  if (result.rows[0]) return result.rows[0].port;

  // already assigned by an earlier, interrupted run
  const existing = await pool.query("SELECT port FROM instances WHERE id = $1", [id]);
  return existing.rows[0].port;
}

// Every step is safe to repeat, so a crash halfway is fixed by simply running it again.
export async function provision(work: PendingWork): Promise<void> {
  const port = work.port ?? (await assignPort(work.id));

  try {
    await writeEnvFile(work.id, port);
    await startService(work.id);
    await addRoute(work.id, port); // tests the config and reloads nginx; a bad route is dropped by the helper
    await waitForHealth(port);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`  provisioning ${work.id} failed: ${reason}`);
    // Leave nothing running: a service that never answered would otherwise sit there restarting forever
    await stopService(work.id).catch((e) => console.error(`  could not stop ${work.id}: ${e.message}`));
    await removeRoute(work.id).catch((e) => console.error(`  could not unroute ${work.id}: ${e.message}`));
    // The status guard matters: if the owner asked to delete meanwhile, 'deleting' must win
    await pool.query(
      "UPDATE instances SET status = 'failed', error_message = $2 WHERE id = $1 AND status = 'pending'",
      [work.id, FAILED_MESSAGE]
    );
    throw err;
  }

  await pool.query(
    "UPDATE instances SET status = 'active', error_message = NULL WHERE id = $1 AND status = 'pending'",
    [work.id]
  );
}

export async function teardown(work: PendingWork): Promise<void> {
  await stopService(work.id);
  await removeEnvFile(work.id);
  await removeRoute(work.id);
  // keys, documents and chunks go with the row (ON DELETE CASCADE)
  await pool.query("DELETE FROM instances WHERE id = $1 AND status = 'deleting'", [work.id]);
}
