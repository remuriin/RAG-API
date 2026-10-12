import { INSTANCE_ID } from "../config.js";
import { pool } from "./client.js";

// What this instance's owner set for the assistant: what it calls itself, and the voice it answers in
export async function getInstanceSettings(): Promise<{ productName: string | null; persona: string }> {
  const result = await pool.query("SELECT product_name, persona FROM instances WHERE id = $1", [INSTANCE_ID]);
  if (result.rows.length === 0) {
    throw new Error(`Instance ${INSTANCE_ID} does not exist in the instances table`);
  }
  return { productName: result.rows[0].product_name, persona: result.rows[0].persona };
}

export async function getProductName(): Promise<string | null> {
  return (await getInstanceSettings()).productName;
}
