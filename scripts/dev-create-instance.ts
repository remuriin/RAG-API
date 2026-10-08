// Development stand-in for the control agent (instances row) and the management API (API key).
import "dotenv/config";
import { randomUUID } from "crypto";
import { pool } from "../src/db/client.js";
import { generateApiKey } from "../src/auth/keys.js";

const FIRST_PORT = 4101;

async function main() {
  // Usage: npm run dev:create-instance -- "<instance name>" ["<product name>"]
  const [name, productName = null] = process.argv.slice(2).map((a) => a.trim());
  if (!name) {
    throw new Error('Usage: npm run dev:create-instance -- "<instance name>" ["<product name>"]');
  }
  const id = randomUUID();
  const { key, hash, prefix } = generateApiKey();

  const client = await pool.connect();
  let port: number;
  try {
    await client.query("BEGIN");
    const next = await client.query("SELECT COALESCE(MAX(port) + 1, $1::int) AS port FROM instances", [FIRST_PORT]);
    port = next.rows[0].port;
    await client.query(
      // 'active' so the control agent leaves it alone: this instance is run by hand
      "INSERT INTO instances (id, owner_uid, port, name, product_name, status) VALUES ($1, 'dev', $2, $3, $4, 'active')",
      [id, port, name, productName]
    );
    await client.query("INSERT INTO api_keys (instance_id, key_hash, key_prefix) VALUES ($1, $2, $3)", [
      id,
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

  console.log(`Created instance "${name}"${productName ? ` (assistant persona: ${productName})` : ""}.\n`);
  console.log("Add to .env to run this instance:");
  console.log(`INSTANCE_ID=${id}`);
  console.log(`PORT=${port}\n`);
  console.log("API key (shown once, only its hash is stored):");
  console.log(key);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
