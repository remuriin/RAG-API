import { chunkMarkdown } from "./chunker.js";
import { embedBatch } from "./embedder.js";
import {
  activateDocument,
  createProcessingDocument,
  markDocumentFailed,
  readyDocumentExists,
} from "./store.js";

export interface IngestResult {
  id: string;
  source: string;
  chunks: number;
}

export class EmptyDocumentError extends Error {
  constructor() {
    super("The document has no content to ingest");
  }
}

export class DocumentExistsError extends Error {
  constructor(source: string) {
    super(`A document named "${source}" already exists`);
  }
}

// One ingest at a time per process, so several uploads in a row don't pile onto the CPU or the Gemini rate limit.
let queue: Promise<unknown> = Promise.resolve();

// Adds a new document. An existing document is never overwritten; it has to be deleted first.
export function ingestDocument(source: string, markdown: string): Promise<IngestResult> {
  const run = queue.then(() => runIngest(source, markdown));
  queue = run.catch(() => {});
  return run;
}

async function runIngest(source: string, markdown: string): Promise<IngestResult> {
  const chunks = chunkMarkdown(markdown);
  if (chunks.length === 0) throw new EmptyDocumentError();
  if (await readyDocumentExists(source)) throw new DocumentExistsError(source);

  const documentId = await createProcessingDocument(source, markdown);

  try {
    const vectors = await embedBatch(
      chunks.map((c) => `${c.headingPath}\n${c.content}`),
      "RETRIEVAL_DOCUMENT"
    );
    await activateDocument(
      documentId,
      chunks.map((c, i) => ({ ...c, embedding: vectors[i] }))
    );
    return { id: documentId, source, chunks: chunks.length };
  } catch (err) {
    // The raw markdown stays stored as 'failed' so the upload isn't lost
    const message = err instanceof Error ? err.message : String(err);
    await markDocumentFailed(documentId, message).catch(() => {});
    throw err;
  }
}
