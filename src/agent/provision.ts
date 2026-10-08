import { pool } from "../db/client.js";
import { FIRST_PORT } from "./config.js";
import {
  reloadNginx,
  removeEnvFile,
  removeRoute,
  startService,
  stopService,
  waitForHealth,
  writeEnvFile,
  writeRoute,
} from "./system.js";

export interface PendingWork {
  id: string;
  port: number | null;
  status: "pending" | "deleting";
}

export async function findWork(): Promise<PendingWork[]> {
  const result = await pool.query(
    "SELECT id, port, status FROM instances WHERE status IN ('pending', 'deleting') ORDER BY created_at"
  );
  return result.rows;
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

    await writeRoute(work.id, port);
    try {
      await reloadNginx();
    } catch (err) {
      await removeRoute(work.id); // never leave a route behind that breaks the next reload
      throw err;
    }

    await waitForHealth(port);
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    // The status guard matters: if the owner asked to delete meanwhile, 'deleting' must win
    await pool.query(
      "UPDATE instances SET status = 'failed', error_message = $2 WHERE id = $1 AND status = 'pending'",
      [work.id, message]
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
  await reloadNginx();
  // keys, documents and chunks go with the row (ON DELETE CASCADE)
  await pool.query("DELETE FROM instances WHERE id = $1 AND status = 'deleting'", [work.id]);
}
