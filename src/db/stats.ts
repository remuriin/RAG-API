import { INSTANCE_ID } from "../config.js";
import { pool, STATS_TIMEZONE } from "./client.js";

// Adds one to today's count for this instance.
export async function recordQuery(): Promise<void> {
  await pool.query(
    `INSERT INTO query_counts (instance_id, day, count)
     VALUES ($1, (now() AT TIME ZONE '${STATS_TIMEZONE}')::date, 1)
     ON CONFLICT (instance_id, day) DO UPDATE SET count = query_counts.count + 1`,
    [INSTANCE_ID]
  );
}
