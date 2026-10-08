import express, { type NextFunction, type Request, type Response } from "express";
import { isUuid } from "../util/uuid.js";
import { requireUser, type AuthUser } from "./auth.js";
import { CORS_ORIGIN, MAX_INSTANCES_PER_USER } from "./config.js";
import {
  createInstance,
  getInstance,
  listInstances,
  markDeleting,
  rotateApiKey,
  type InstanceRecord,
} from "./instances.js";

const MAX_NAME_CHARS = 60;

// Express 4 does not catch rejected promises from async handlers
const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_NAME_CHARS ? trimmed : null;
}

// The owner's view of a record; ownerUid stays server-side
function present({ ownerUid, ...record }: InstanceRecord) {
  return record;
}

// Loads the instance in the URL and checks the caller owns it. Sends the error response itself.
async function loadOwned(req: Request, res: Response): Promise<InstanceRecord | null> {
  const user = res.locals.user as AuthUser;
  const instance = isUuid(req.params.id) ? await getInstance(req.params.id) : null;
  if (!instance) {
    res.status(404).json({ error: "Service not found" });
    return null;
  }
  if (instance.ownerUid !== user.uid) {
    res.status(403).json({ error: "This service belongs to another account" });
    return null;
  }
  return instance;
}

export function createManagementApp() {
  const app = express();
  app.disable("x-powered-by");

  if (CORS_ORIGIN) {
    app.use((req, res, next) => {
      if (req.get("origin") === CORS_ORIGIN) {
        res.set("Access-Control-Allow-Origin", CORS_ORIGIN);
        res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
        res.set("Access-Control-Allow-Methods", "GET, POST, DELETE");
        res.set("Vary", "Origin");
      }
      if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
      }
      next();
    });
  }

  const api = express.Router();
  api.use(requireUser);
  api.use(express.json({ limit: "10kb" }));

  api.get(
    "/me",
    wrap(async (_req, res) => {
      res.json(res.locals.user);
    })
  );

  api.get(
    "/instances",
    wrap(async (_req, res) => {
      const user = res.locals.user as AuthUser;
      res.json({ instances: (await listInstances(user.uid)).map(present) });
    })
  );

  // Writes the request as 'pending'; the control agent does the actual setup.
  api.post(
    "/instances",
    wrap(async (req, res) => {
      const user = res.locals.user as AuthUser;
      const name = cleanName(req.body?.name);
      if (!name) {
        res.status(400).json({ error: `"name" is required (max ${MAX_NAME_CHARS} characters)` });
        return;
      }

      let productName: string | null = null;
      if (req.body?.productName != null && req.body.productName !== "") {
        productName = cleanName(req.body.productName);
        if (!productName) {
          res.status(400).json({ error: `"productName" must be text of at most ${MAX_NAME_CHARS} characters` });
          return;
        }
      }

      const instance = await createInstance(user.uid, name, productName);
      if (!instance) {
        res.status(409).json({ error: `You already have the maximum of ${MAX_INSTANCES_PER_USER} services` });
        return;
      }
      res.status(201).json(present(instance));
    })
  );

  api.get(
    "/instances/:id",
    wrap(async (req, res) => {
      const instance = await loadOwned(req, res);
      if (instance) res.json(present(instance));
    })
  );

  api.delete(
    "/instances/:id",
    wrap(async (req, res) => {
      const instance = await loadOwned(req, res);
      if (!instance) return;
      if (instance.status !== "deleting") await markDeleting(instance.id);
      res.status(202).json({ id: instance.id, status: "deleting" });
    })
  );

  // First key and "regenerate" are the same call: any existing key stops working.
  api.post(
    "/instances/:id/key",
    wrap(async (req, res) => {
      const instance = await loadOwned(req, res);
      if (!instance) return;
      if (instance.status !== "active") {
        res.status(409).json({ error: `A key can only be generated once the service is active (it is ${instance.status})` });
        return;
      }
      const { key, prefix } = await rotateApiKey(instance.id);
      res.status(201).json({ apiKey: key, keyPrefix: prefix, note: "Copy this key now. It is not stored and cannot be shown again." });
    })
  );

  app.use("/api", api);

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    // body-parser errors (malformed JSON, body too large) carry their own status
    if (err?.expose && typeof err.status === "number") {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
