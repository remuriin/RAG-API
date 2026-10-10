import { randomUUID } from "crypto";
import { generateApiKey } from "../auth/keys.js";
import { pool, STATS_TIMEZONE } from "../db/client.js";
import { MAX_INSTANCES_PER_USER, PUBLIC_BASE_URL } from "./config.js";

export type InstanceStatus = "pending" | "active" | "failed" | "deleting";

export interface InstanceRecord {
  id: string;
  ownerUid: string;
  name: string | null;
  productName: string | null;
  status: InstanceStatus;
  errorMessage: string | null;
  url: string;
  port: number | null; // where the instance listens on this machine; not shown to clients
  keyPrefix: string | null;
  documents: number;
  chunks: number;
  queries: { today: number; last7Days: number; total: number };
  createdAt: string;
}

const TODAY = `(now() AT TIME ZONE '${STATS_TIMEZONE}')::date`;
const queryCount = (filter = "") =>
  `(SELECT COALESCE(SUM(q.count), 0)::int FROM query_counts q WHERE q.instance_id = i.id${filter})`;

const SELECT_INSTANCE = `
  SELECT i.id, i.owner_uid, i.name, i.product_name, i.status, i.error_message, i.port, i.created_at,
         ${queryCount(` AND q.day = ${TODAY}`)} AS queries_today,
         ${queryCount(` AND q.day > ${TODAY} - 7`)} AS queries_7d,
         ${queryCount()} AS queries_total,
         (SELECT k.key_prefix FROM api_keys k
           WHERE k.instance_id = i.id AND k.revoked_at IS NULL
           ORDER BY k.created_at DESC LIMIT 1) AS key_prefix,
         (SELECT COUNT(*)::int FROM documents d WHERE d.instance_id = i.id AND d.status = 'ready') AS documents,
         (SELECT COUNT(*)::int FROM chunks c WHERE c.instance_id = i.id) AS chunks
  FROM instances i`;

function toRecord(row: any): InstanceRecord {
  return {
    id: row.id,
    ownerUid: row.owner_uid,
    name: row.name,
    productName: row.product_name,
    status: row.status,
    errorMessage: row.error_message,
    url: `${PUBLIC_BASE_URL}/i/${row.id}`,
    port: row.port,
    keyPrefix: row.key_prefix,
    documents: row.documents,
    chunks: row.chunks,
    queries: { today: row.queries_today, last7Days: row.queries_7d, total: row.queries_total },
    createdAt: row.created_at.toISOString(),
  };
}

export async function listInstances(ownerUid: string): Promise<InstanceRecord[]> {
  const result = await pool.query(`${SELECT_INSTANCE} WHERE i.owner_uid = $1 ORDER BY i.created_at`, [ownerUid]);
  return result.rows.map(toRecord);
}

export async function getInstance(id: string): Promise<InstanceRecord | null> {
  const result = await pool.query(`${SELECT_INSTANCE} WHERE i.id = $1`, [id]);
  return result.rows[0] ? toRecord(result.rows[0]) : null;
}

// Only writes the request. Setting the service up is the control agent's job.
// Returns null when the owner is already at the limit.
export async function createInstance(
  ownerUid: string,
  name: string,
  productName: string | null
): Promise<InstanceRecord | null> {
  const id = randomUUID();
  const client = await pool.connect();
  let created = false;
  try {
    await client.query("BEGIN");
    // one create at a time per owner, so the count below can't be read twice before either insert lands
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [ownerUid]);
    const result = await client.query(
      `INSERT INTO instances (id, owner_uid, name, product_name, status)
       SELECT $1, $2, $3, $4, 'pending'
       WHERE (SELECT COUNT(*) FROM instances WHERE owner_uid = $2 AND status <> 'deleting') < $5
       RETURNING id`,
      [id, ownerUid, name, productName, MAX_INSTANCES_PER_USER]
    );
    created = result.rows.length > 0;
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return created ? getInstance(id) : null;
}

// Changes the label and/or the assistant's product name. The instance reads its product name
// on every request, so the next answer already uses it. productName: null clears it.
export async function updateInstance(
  id: string,
  changes: { name?: string; productName?: string | null }
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [id];
  if (changes.name !== undefined) {
    values.push(changes.name);
    sets.push(`name = $${values.length}`);
  }
  if (changes.productName !== undefined) {
    values.push(changes.productName);
    sets.push(`product_name = $${values.length}`);
  }
  if (sets.length === 0) return;
  await pool.query(`UPDATE instances SET ${sets.join(", ")} WHERE id = $1`, values);
}

export async function markDeleting(id: string): Promise<void> {
  await pool.query("UPDATE instances SET status = 'deleting', error_message = NULL WHERE id = $1", [id]);
}

// Revokes the current key (if any) and issues a new one. Only the hash is stored;
// the key itself is returned once and cannot be recovered afterwards.
export async function rotateApiKey(instanceId: string): Promise<{ key: string; prefix: string }> {
  const { key, hash, prefix } = generateApiKey();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE api_keys SET revoked_at = now() WHERE instance_id = $1 AND revoked_at IS NULL", [
      instanceId,
    ]);
    await client.query("INSERT INTO api_keys (instance_id, key_hash, key_prefix) VALUES ($1, $2, $3)", [
      instanceId,
      hash,
      prefix,
    ]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return { key, prefix };
}
