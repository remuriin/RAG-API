import { randomUUID } from "crypto";
import { generateApiKey } from "../auth/keys.js";
import { pool } from "../db/client.js";
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
  keyPrefix: string | null;
  documents: number;
  chunks: number;
  createdAt: string;
}

const SELECT_INSTANCE = `
  SELECT i.id, i.owner_uid, i.name, i.product_name, i.status, i.error_message, i.created_at,
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
    keyPrefix: row.key_prefix,
    documents: row.documents,
    chunks: row.chunks,
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
  const result = await pool.query(
    `INSERT INTO instances (id, owner_uid, name, product_name, status)
     SELECT $1, $2, $3, $4, 'pending'
     WHERE (SELECT COUNT(*) FROM instances WHERE owner_uid = $2 AND status <> 'deleting') < $5
     RETURNING id`,
    [id, ownerUid, name, productName, MAX_INSTANCES_PER_USER]
  );
  return result.rows[0] ? getInstance(id) : null;
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
