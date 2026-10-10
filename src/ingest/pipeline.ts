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

export class IngestQueueFullError extends Error {
  constructor() {
    super(`Too many uploads at once. At most ${MAX_WAITING} can wait their turn; try again in a moment.`);
  }
}

// One ingest at a time per process, so several uploads in a row don't pile onto the CPU or the Gemini rate limit.
// The line has a maximum length: nginx gives up on a request after 5 minutes, and an upload that
// would only start after that is better refused at once than worked on for nobody.
const MAX_WAITING = 5;
let waiting = 0;
let queue: Promise<unknown> = Promise.resolve();

// Adds a new document. An existing document is never overwritten; it has to be deleted first.
export function ingestDocument(source: string, markdown: string): Promise<IngestResult> {
  if (waiting >= MAX_WAITING) return Promise.reject(new IngestQueueFullError());
  waiting++;
  const run = queue.then(() => {
    waiting--;
    return runIngest(source, markdown);
  });
  queue = run.catch(() => {});
  return run;
}

async function runIngest(source: string, markdown: string): Promise<IngestResult> {
  const chunks = chunkMarkdown(markdown); // throws DocumentTooFragmentedError past the chunk limit
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
