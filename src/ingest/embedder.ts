import { GoogleGenAI } from "@google/genai";
import { withRetry } from "../util/retry.js";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const EMBED_MODEL = "gemini-embedding-001";
const DIMENSIONS = 768; // must match VECTOR(768) in db/client.ts
const BATCH_SIZE = 50; // conservative; check the embeddings docs for the real max
const DELAY_MS = 1000; // pause between batches to respect free-tier RPM

export type EmbedTaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

export async function embedText(text: string, taskType: EmbedTaskType): Promise<number[]> {
  const [vector] = await embedBatch([text], taskType);
  return vector;
}

export async function embedBatch(texts: string[], taskType: EmbedTaskType): Promise<number[][]> {
  const out: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const slice = texts.slice(i, i + BATCH_SIZE);

    const result = await withRetry(
      () =>
        ai.models.embedContent({
          model: EMBED_MODEL,
          contents: slice,
          config: { taskType, outputDimensionality: DIMENSIONS },
        }),
      "embedding"
    );

    const vectors = result.embeddings ?? [];
    if (vectors.length !== slice.length) {
      throw new Error(`Expected ${slice.length} embeddings, got ${vectors.length}`);
    }

    for (const e of vectors) {
      out.push(l2Normalize(e.values!));
    }

    if (i + BATCH_SIZE < texts.length) {
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }

  return out;
}

function l2Normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return magnitude === 0 ? vector : vector.map((v) => v / magnitude);
}