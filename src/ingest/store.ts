import { INSTANCE_ID } from "../config.js";
import { pool } from "../db/client.js";
import type { DocumentSummary, EmbeddedChunk } from "../types/index.js";

// Saves the raw markdown first so it is kept even if chunking or embedding fails.
// Earlier unfinished or failed attempts for the same source are dropped.
export async function createProcessingDocument(source: string, content: string): Promise<string> {
  await pool.query(
    "DELETE FROM documents WHERE instance_id = $1 AND source = $2 AND status <> 'ready'",
    [INSTANCE_ID, source]
  );
  const result = await pool.query(
    `INSERT INTO documents (instance_id, source, content, status)
     VALUES ($1, $2, $3, 'processing')
     RETURNING id`,
    [INSTANCE_ID, source, content]
  );
  return result.rows[0].id;
}

// Each embedding is ~15 KB of text as a parameter, so the chunks go in batches rather than one statement
const INSERT_BATCH = 200;

// One transaction: store the chunks and mark the document ready, so a document is never searchable half-ingested.
export async function activateDocument(documentId: string, chunks: EmbeddedChunk[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (let start = 0; start < chunks.length; start += INSERT_BATCH) {
      const batch = chunks.slice(start, start + INSERT_BATCH);
      await client.query(
        `INSERT INTO chunks (document_id, instance_id, chunk_index, heading_path, chunk_text, embedding)
         SELECT $1, $2, c.chunk_index, c.heading_path, c.chunk_text, c.embedding::vector
         FROM unnest($3::int[], $4::text[], $5::text[], $6::text[])
           AS c(chunk_index, heading_path, chunk_text, embedding)`,
        [
          documentId,
          INSTANCE_ID,
          batch.map((c) => c.chunkIndex),
          batch.map((c) => c.headingPath),
          batch.map((c) => c.content),
          batch.map((c) => toVectorLiteral(c.embedding)),
        ]
      );
    }

    await client.query("UPDATE documents SET status = 'ready', error = NULL WHERE id = $1", [documentId]);

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function readyDocumentExists(source: string): Promise<boolean> {
  const result = await pool.query(
    "SELECT 1 FROM documents WHERE instance_id = $1 AND source = $2 AND status = 'ready'",
    [INSTANCE_ID, source]
  );
  return result.rows.length > 0;
}

export async function markDocumentFailed(documentId: string, error: string): Promise<void> {
  await pool.query("UPDATE documents SET status = 'failed', error = $2 WHERE id = $1", [documentId, error]);
}

// Anything still 'processing' when the process starts was cut off by a crash or restart.
export async function failInterruptedDocuments(): Promise<void> {
  await pool.query(
    `UPDATE documents SET status = 'failed', error = 'Interrupted before ingest finished'
     WHERE instance_id = $1 AND status = 'processing'`,
    [INSTANCE_ID]
  );
}

export async function listDocuments(): Promise<DocumentSummary[]> {
  const result = await pool.query(
    `SELECT d.id, d.source, d.status, d.error, d.created_at, COUNT(c.id)::int AS chunks
     FROM documents d
     LEFT JOIN chunks c ON c.document_id = d.id
     WHERE d.instance_id = $1
     GROUP BY d.id
     ORDER BY d.source, d.created_at`,
    [INSTANCE_ID]
  );
  return result.rows.map((row) => ({
    id: row.id,
    source: row.source,
    status: row.status,
    error: row.error,
    chunks: row.chunks,
    createdAt: row.created_at.toISOString(),
  }));
}

const MAX_TOPICS = 30;

// One title per stored file: its top-level heading, or the file name when it has none.
// Tells the assistant what this instance can be asked about without showing it any content.
export async function listTopics(): Promise<string[]> {
  const result = await pool.query(
    `SELECT DISTINCT ON (d.id) d.source, c.heading_path
     FROM documents d
     JOIN chunks c ON c.document_id = d.id
     WHERE d.instance_id = $1 AND d.status = 'ready'
     ORDER BY d.id, c.chunk_index`,
    [INSTANCE_ID]
  );

  const titles = result.rows.map((row) => {
    const title = String(row.heading_path).split(" > ")[0].trim();
    // "Introduction" is the chunker's placeholder for text that sits above any heading
    return title && title !== "Introduction" ? title : String(row.source).replace(/\.md$/i, "").replace(/[-_]+/g, " ");
  });

  return [...new Set(titles)].sort().slice(0, MAX_TOPICS);
}

export async function deleteDocument(source: string): Promise<boolean> {
  const result = await pool.query("DELETE FROM documents WHERE instance_id = $1 AND source = $2", [
    INSTANCE_ID,
    source,
  ]);
  return (result.rowCount ?? 0) > 0;
}

function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}
