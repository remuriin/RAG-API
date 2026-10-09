import { GoogleGenAI } from "@google/genai";
import { listTopics } from "../ingest/store.js";
import { withRetry } from "../util/retry.js";
import type { RetrievedChunk, RagAnswer } from "../types/index.js";
import {
  answerMessage,
  answerSystemInstruction,
  noMatchMessage,
  noMatchSystemInstruction,
  type PromptOptions,
} from "./prompts.js";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const CHAT_MODEL = "gemini-3.1-flash-lite";

const SIMILARITY_FLOOR = 0.625;
const TEMPERATURE = 0.2; // steady wording from run to run

const FALLBACK_ANSWER = "I don't have info on that yet.";

// One or more [n] markers in a row, with the spaces and commas between them, so that
// "city [1], [2]." becomes "city." and not "city,."
const CITATION_RUN = /\s*\[\d+(?:\s*,\s*\d+)*\](?:\s*,?\s*\[\d+(?:\s*,\s*\d+)*\])*/g;

export async function generateAnswer(
  question: string,
  chunks: RetrievedChunk[],
  options: PromptOptions = {},
): Promise<RagAnswer> {
  const usable = chunks.filter((c) => c.similarity >= SIMILARITY_FLOOR);

  return usable.length === 0
    ? replyWithoutMatch(question, options)
    : answerFromChunks(question, usable, options);
}

async function answerFromChunks(
  question: string,
  usable: RetrievedChunk[],
  options: PromptOptions,
): Promise<RagAnswer> {
  const result = await withRetry(
    () =>
      ai.models.generateContent({
        model: CHAT_MODEL,
        contents: answerMessage(question, usable),
        config: {
          systemInstruction: answerSystemInstruction(options),
          temperature: TEMPERATURE,
        },
      }),
    "generation",
  );

  const text = result.text ?? "";

  const cited = new Set(
    [...text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap((m) =>
      m[1].split(",").map((n) => Number(n.trim())),
    ),
  );

  const cleanAnswer = text.replace(CITATION_RUN, "").trim();

  // No citations at all means the model could not answer from the passages: a refusal, with no sources
  const citedChunks = usable.filter((_, i) => cited.has(i + 1));

  return {
    answer: cleanAnswer || FALLBACK_ANSWER,
    sources: citedChunks.map((c) => ({
      source: c.source,
      heading: c.headingPath,
    })),
    answered: citedChunks.length > 0,
  };
}

// Nothing in the files is close enough to the message. The model may greet or say what it can
// help with, knowing only the topic names; it is never shown document text on this path.
async function replyWithoutMatch(question: string, options: PromptOptions): Promise<RagAnswer> {
  const fallback: RagAnswer = { answer: FALLBACK_ANSWER, sources: [], answered: false };

  try {
    const topics = await listTopics();
    if (topics.length === 0) return fallback;

    const result = await withRetry(
      () =>
        ai.models.generateContent({
          model: CHAT_MODEL,
          contents: noMatchMessage(question, topics),
          config: {
            systemInstruction: noMatchSystemInstruction(options),
            temperature: TEMPERATURE,
          },
        }),
      "generation",
    );

    const text = (result.text ?? "").trim();
    return text ? { answer: text, sources: [], answered: false } : fallback;
  } catch (err) {
    // A polite non-answer is better than an error for a message that had no answer anyway
    console.warn("no-match reply failed, using the fixed line:", err instanceof Error ? err.message : err);
    return fallback;
  }
}
