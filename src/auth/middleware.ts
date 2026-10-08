import type { NextFunction, Request, Response } from "express";
import { INSTANCE_ID } from "../config.js";
import { pool } from "../db/client.js";
import { hashApiKey } from "./keys.js";

export async function requireApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const match = (req.get("authorization") ?? "").match(/^Bearer\s+(\S+)$/i);
    if (!match) {
      res.status(401).json({ error: "Missing API key. Send it as: Authorization: Bearer <key>" });
      return;
    }

    const result = await pool.query(
      `SELECT k.instance_id, i.product_name
       FROM api_keys k
       JOIN instances i ON i.id = k.instance_id
       WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
      [hashApiKey(match[1])]
    );

    // A valid key for another instance is rejected the same way as an unknown one
    const row = result.rows[0];
    if (!row || row.instance_id !== INSTANCE_ID) {
      res.status(401).json({ error: "Invalid API key" });
      return;
    }

    res.locals.productName = row.product_name;
    next();
  } catch (err) {
    next(err);
  }
}
