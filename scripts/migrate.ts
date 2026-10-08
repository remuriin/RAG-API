import "dotenv/config";
import { pool, SCHEMA_SQL } from "../src/db/client.js";

async function main() {
  await pool.query(SCHEMA_SQL);
  console.log("Schema is up to date.");
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
