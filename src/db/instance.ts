import { INSTANCE_ID } from "../config.js";
import { pool } from "./client.js";

export async function getProductName(): Promise<string | null> {
  const result = await pool.query("SELECT product_name FROM instances WHERE id = $1", [INSTANCE_ID]);
  if (result.rows.length === 0) {
    throw new Error(`Instance ${INSTANCE_ID} does not exist in the instances table`);
  }
  return result.rows[0].product_name;
}
