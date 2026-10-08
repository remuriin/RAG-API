import { INSTANCE_ID } from "../config.js";
import { pool } from "../db/client.js";
import { embedText } from "../ingest/embedder.js";
import type { RetrievedChunk } from "../types/index.js";

export async function retrieveRelevantChunks(
  question: string,
  topK: number = 5
): Promise<RetrievedChunk[]> {
  const queryVector = await embedText(question, "RETRIEVAL_QUERY");
  const vectorLiteral = `[${queryVector.join(",")}]`;

  const result = await pool.query(
    `SELECT c.id, d.source, c.heading_path, c.chunk_text,
            1 - (c.embedding <=> $1::vector) AS similarity
     FROM chunks c
     JOIN documents d ON d.id = c.document_id
     WHERE c.instance_id = $3
     ORDER BY c.embedding <=> $1::vector
     LIMIT $2`,
    [vectorLiteral, topK, INSTANCE_ID]
  );

  return result.rows.map((row) => ({
    id: row.id,
    source: row.source,
    headingPath: row.heading_path,
    content: row.chunk_text,
    similarity: row.similarity,
  }));
}
