import { pool } from "../db/client.js";
import { startService, stopService, updateService, waitForHealth } from "./system.js";

export interface PendingWork {
  id: string;
  status: "pending" | "deleting";
}

// What the owner sees on a failed service. The real reason goes to the log: it names things inside
// the cluster, which is for whoever runs it, not for the person who asked for a service.
const FAILED_MESSAGE = "Setting it up failed on our side. Delete this service and create it again; if it fails twice, contact support.";

export async function findWork(): Promise<PendingWork[]> {
  const result = await pool.query(
    "SELECT id, status FROM instances WHERE status IN ('pending', 'deleting') ORDER BY created_at"
  );
  return result.rows;
}

// Written on every poll. /api/health reports the agent as stale when this stops moving.
export async function heartbeat(): Promise<void> {
  await pool.query(
    "INSERT INTO agent_heartbeat (id, seen_at) VALUES (1, now()) ON CONFLICT (id) DO UPDATE SET seen_at = now()"
  );
}

// Run once when the agent starts: every running service is brought to this agent's image, one at a
// time. After a deploy that is what updates the services; on any other start it changes nothing.
// It stops at the first service that does not come up (that one is put back on its old image).
export async function syncActiveInstances(): Promise<void> {
  const result = await pool.query("SELECT id FROM instances WHERE status = 'active' ORDER BY created_at");
  for (const { id } of result.rows) {
    // a long round must not make the agent look dead
    await heartbeat();
    await updateService(id);
  }
}

// Every step is safe to repeat, so a crash halfway is fixed by simply running it again.
export async function provision(work: PendingWork): Promise<void> {
  try {
    await startService(work.id);
    await waitForHealth(work.id);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`  provisioning ${work.id} failed: ${reason}`);
    // Leave nothing running: a service that never answered would otherwise sit there restarting forever
    await stopService(work.id).catch((e) => console.error(`  could not remove ${work.id}: ${e.message}`));
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
  // keys, documents and chunks go with the row (ON DELETE CASCADE)
  await pool.query("DELETE FROM instances WHERE id = $1 AND status = 'deleting'", [work.id]);
}
