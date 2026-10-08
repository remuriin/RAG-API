import express, { type NextFunction, type Request, type Response } from "express";
import { requireApiKey } from "../auth/middleware.js";
import { INSTANCE_ID } from "../config.js";
import { pool } from "../db/client.js";
import { generateAnswer } from "../generate/answer.js";
import { DocumentExistsError, EmptyDocumentError, ingestDocument } from "../ingest/pipeline.js";
import { deleteDocument, listDocuments } from "../ingest/store.js";
import { retrieveRelevantChunks } from "../retrieve/search.js";
import { isRetryable } from "../util/retry.js";

const SOURCE_RE = /^(?=.{4,100}$)[A-Za-z0-9][A-Za-z0-9._-]*\.md$/i; // only .md files
const MARKDOWN_TYPES = ["text/markdown", "text/x-markdown", "text/plain"];
const MAX_DOCUMENT_SIZE = "500kb";
const MAX_QUESTION_CHARS = 2000;
const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 20;

const BUSY_MESSAGE = "The model is busy or rate limited right now. Try again shortly.";

// Express 4 does not catch rejected promises from async handlers
const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

export function createApp() {
  const app = express();
  app.disable("x-powered-by");

  app.get(
    "/health",
    wrap(async (_req, res) => {
      try {
        await pool.query("SELECT 1");
        res.json({ status: "ok", instanceId: INSTANCE_ID });
      } catch {
        res.status(503).json({ status: "unavailable", instanceId: INSTANCE_ID });
      }
    })
  );

  app.use(requireApiKey);

  app.get(
    "/documents",
    wrap(async (_req, res) => {
      // The stored error is raw upstream detail for the operator; clients get a plain message
      const documents = (await listDocuments()).map((d) => ({
        ...d,
        error: d.error ? "Ingest failed. Upload the document again to retry." : null,
      }));
      res.json({ documents });
    })
  );

  // Add one markdown file. The body is the raw markdown. Existing documents are never
  // overwritten: to change one, delete it and add it again.
  app.post(
    "/documents/:source",
    express.text({ type: MARKDOWN_TYPES, limit: MAX_DOCUMENT_SIZE }),
    wrap(async (req, res) => {
      const source = req.params.source;
      if (!SOURCE_RE.test(source)) {
        res.status(400).json({
          error:
            "Invalid document name. It must end in .md and use only letters, numbers, dots, dashes and underscores (max 100 characters).",
        });
        return;
      }
      // express.text leaves the body unparsed when the Content-Type isn't one of MARKDOWN_TYPES
      const contentType = (req.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (!MARKDOWN_TYPES.includes(contentType)) {
        res.status(415).json({ error: "Only markdown is accepted. Send the file with Content-Type: text/markdown" });
        return;
      }
      if (typeof req.body !== "string" || !req.body.trim()) {
        res.status(400).json({ error: "Send the markdown as the request body" });
        return;
      }
      if (req.body.includes("\0")) {
        res.status(400).json({ error: "The file is not text. Only .md files are accepted." });
        return;
      }

      try {
        const document = await ingestDocument(source, req.body);
        res.status(201).json({ ...document, status: "ready" });
      } catch (err) {
        if (err instanceof EmptyDocumentError) {
          res.status(400).json({ error: err.message });
          return;
        }
        if (err instanceof DocumentExistsError) {
          res.status(409).json({ error: `${err.message}. Delete it first to upload a new version.` });
          return;
        }
        console.error(`Ingest of ${source} failed:`, err);
        const reason = isRetryable(err) ? BUSY_MESSAGE : "Ingest failed.";
        res.status(isRetryable(err) ? 503 : 500).json({ error: `${reason} Upload the document again to retry.` });
      }
    })
  );

  app.delete(
    "/documents/:source",
    wrap(async (req, res) => {
      if (await deleteDocument(req.params.source)) {
        res.status(204).end();
      } else {
        res.status(404).json({ error: "Document not found" });
      }
    })
  );

  app.post(
    "/query",
    express.json({ limit: "100kb" }),
    wrap(async (req, res) => {
      const { question, topK = DEFAULT_TOP_K } = req.body ?? {};

      if (typeof question !== "string" || !question.trim()) {
        res.status(400).json({ error: '"question" is required' });
        return;
      }
      if (question.length > MAX_QUESTION_CHARS) {
        res.status(400).json({ error: `"question" must be at most ${MAX_QUESTION_CHARS} characters` });
        return;
      }
      if (!Number.isInteger(topK) || topK < 1 || topK > MAX_TOP_K) {
        res.status(400).json({ error: `"topK" must be an integer between 1 and ${MAX_TOP_K}` });
        return;
      }

      const chunks = await retrieveRelevantChunks(question.trim(), topK);
      res.json(await generateAnswer(question.trim(), chunks, res.locals.productName));
    })
  );

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    // body-parser errors (malformed JSON, body too large) carry their own status
    if (err?.expose && typeof err.status === "number") {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if (isRetryable(err)) {
      res.status(503).json({ error: BUSY_MESSAGE });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
