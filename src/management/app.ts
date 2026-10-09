import express, { type NextFunction, type Request, type Response } from "express";
import { internalAuthConfigured } from "../auth/internal.js";
import { isUuid } from "../util/uuid.js";
import { requireUser, type AuthUser } from "./auth.js";
import { CORS_ORIGIN, MAX_INSTANCES_PER_USER } from "./config.js";
import { forwardToInstance, InstanceUnreachableError } from "./forward.js";
import {
  createInstance,
  getInstance,
  listInstances,
  markDeleting,
  rotateApiKey,
  updateInstance,
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

// The owner's view of a record; ownerUid and the local port stay server-side
function present({ ownerUid, port, ...record }: InstanceRecord) {
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

// For routes that talk to the running service: it must be the caller's, and up.
async function loadRunning(req: Request, res: Response): Promise<{ id: string; port: number } | null> {
  const instance = await loadOwned(req, res);
  if (!instance) return null;
  if (instance.status !== "active" || instance.port === null) {
    res.status(409).json({ error: `The service is not active yet (it is ${instance.status})` });
    return null;
  }
  if (!internalAuthConfigured()) {
    res.status(503).json({ error: "Managing files from the dashboard is not set up on this server" });
    return null;
  }
  return { id: instance.id, port: instance.port };
}

// Passes the request to the service and hands its reply back unchanged
async function relay(
  res: Response,
  instance: { id: string; port: number },
  method: string,
  path: string,
  options: { body?: string; contentType?: string } = {}
): Promise<void> {
  try {
    const forwarded = await forwardToInstance(instance, method, path, options);
    res.status(forwarded.status);
    if (forwarded.contentType) res.set("Content-Type", forwarded.contentType);
    res.send(forwarded.body);
  } catch (err) {
    if (!(err instanceof InstanceUnreachableError)) throw err;
    console.error(`instance ${instance.id} did not respond:`, err.message);
    res.status(502).json({ error: "The service is not responding right now" });
  }
}

export function createManagementApp() {
  const app = express();
  app.disable("x-powered-by");

  if (CORS_ORIGIN) {
    app.use((req, res, next) => {
      if (req.get("origin") === CORS_ORIGIN) {
        res.set("Access-Control-Allow-Origin", CORS_ORIGIN);
        res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
        res.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE");
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

  // Rename the service and/or change what the assistant calls itself
  api.patch(
    "/instances/:id",
    wrap(async (req, res) => {
      const instance = await loadOwned(req, res);
      if (!instance) return;

      const changes: { name?: string; productName?: string | null } = {};
      if (req.body?.name !== undefined) {
        const name = cleanName(req.body.name);
        if (!name) {
          res.status(400).json({ error: `"name" must be text of at most ${MAX_NAME_CHARS} characters` });
          return;
        }
        changes.name = name;
      }
      if (req.body?.productName !== undefined) {
        if (req.body.productName === null || req.body.productName === "") {
          changes.productName = null;
        } else {
          const productName = cleanName(req.body.productName);
          if (!productName) {
            res.status(400).json({ error: `"productName" must be text of at most ${MAX_NAME_CHARS} characters` });
            return;
          }
          changes.productName = productName;
        }
      }
      if (changes.name === undefined && changes.productName === undefined) {
        res.status(400).json({ error: 'Send "name" and/or "productName"' });
        return;
      }

      await updateInstance(instance.id, changes);
      const updated = await getInstance(instance.id);
      res.json(present(updated ?? instance));
    })
  );

  // The dashboard's file and chat pages. The login token replaces the API key here: the request
  // is checked for ownership and then handed to the service itself, which does the actual work.
  api.get(
    "/instances/:id/documents",
    wrap(async (req, res) => {
      const instance = await loadRunning(req, res);
      if (instance) await relay(res, instance, "GET", "/documents");
    })
  );

  api.post(
    "/instances/:id/documents/:name",
    express.text({ type: "*/*", limit: "500kb" }),
    wrap(async (req, res) => {
      const instance = await loadRunning(req, res);
      if (!instance) return;
      if (typeof req.body !== "string") {
        // express.json already consumed a JSON body, and an empty request has no body at all
        res.status(415).json({ error: "Only markdown is accepted. Send the file with Content-Type: text/markdown" });
        return;
      }
      await relay(res, instance, "POST", `/documents/${encodeURIComponent(req.params.name)}`, {
        body: req.body,
        contentType: req.get("content-type") ?? "text/markdown",
      });
    })
  );

  api.delete(
    "/instances/:id/documents/:name",
    wrap(async (req, res) => {
      const instance = await loadRunning(req, res);
      if (instance) await relay(res, instance, "DELETE", `/documents/${encodeURIComponent(req.params.name)}`);
    })
  );

  api.post(
    "/instances/:id/query",
    wrap(async (req, res) => {
      const instance = await loadRunning(req, res);
      if (!instance) return;
      await relay(res, instance, "POST", "/query", {
        body: JSON.stringify(req.body ?? {}),
        contentType: "application/json",
      });
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
