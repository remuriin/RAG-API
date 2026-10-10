import type { NextFunction, Request, Response } from "express";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { pool } from "../db/client.js";
import { FIREBASE_PROJECT_ID } from "./config.js";

initializeApp({ projectId: FIREBASE_PROJECT_ID });

export interface AuthUser {
  uid: string;
  email: string | null;
}

// The uid always comes from the verified token, never from the URL or the body.
export async function requireUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  const match = (req.get("authorization") ?? "").match(/^Bearer\s+(\S+)$/i);
  if (!match) {
    res.status(401).json({ error: "Missing login token. Send it as: Authorization: Bearer <Firebase ID token>" });
    return;
  }

  let user: AuthUser;
  let emailVerified: boolean;
  try {
    // checks the signature, the expiry, and that the token was issued for this Firebase project
    const decoded = await getAuth().verifyIdToken(match[1]);
    user = { uid: decoded.uid, email: decoded.email ?? null };
    emailVerified = decoded.email_verified === true;
  } catch {
    res.status(401).json({ error: "Invalid or expired login token" });
    return;
  }

  // Firebase hands out a valid token the moment someone registers, before they have opened the
  // verification link. Until they do, the account can do nothing here and gets no client record.
  // The code lets the dashboard tell this apart from other 403s: a token issued before the email
  // was verified still says "not verified", so the dashboard fetches a new one and tries again.
  if (!emailVerified) {
    res.status(403).json({
      error: "Verify your email address first. Open the link in the email we sent you, then try again.",
      code: "email_not_verified",
    });
    return;
  }

  try {
    await pool.query(
      `INSERT INTO clients (uid, email) VALUES ($1, $2)
       ON CONFLICT (uid) DO UPDATE SET email = EXCLUDED.email`,
      [user.uid, user.email]
    );
    res.locals.user = user;
    next();
  } catch (err) {
    next(err);
  }
}
