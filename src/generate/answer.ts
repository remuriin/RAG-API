import { GoogleGenAI } from "@google/genai";
import { withRetry } from "../util/retry.js";
import type { RetrievedChunk, RagAnswer } from "../types/index.js";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const CHAT_MODEL = "gemini-3.1-flash-lite";

const SIMILARITY_FLOOR = 0.625;

export async function generateAnswer(
  question: string,
  chunks: RetrievedChunk[],
  productName?: string | null,
): Promise<RagAnswer> {
  const usable = chunks.filter((c) => c.similarity >= SIMILARITY_FLOOR);

  if (usable.length === 0) {
    return {
      answer: "I don't have info on that yet.",
      sources: [],
    };
  }

  const context = usable
    .map((c, i) => `[${i + 1}] (${c.source} — ${c.headingPath})\n${c.content}`)
    .join("\n\n");

  const identity = productName ? `the ${productName} support assistant` : "a support assistant";
  const otherCompanyRule = productName
    ? `\n    - If the question names a different company, app, or service, start by saying you can only help with ${productName}, e.g. "I can only help with ${productName}, so I can't speak to that one." Then, if relevant, offer the ${productName} equivalent.`
    : "";

  const prompt = `You are ${identity}, speaking directly to the person asking. Answer using ONLY the information below.

    Rules for your tone:
    - Never say "the context," "the provided information," "the documents," or anything implying you were handed material to read from. Just answer as if you know it.
    - If something isn't covered, say so plainly and naturally, e.g. "I don't have that info yet" or "That's not something I can confirm right now".${otherCompanyRule}
    - When asked whether something is possible or allowed, answer yes or no only if the information below states that exact thing directly. Related details are not enough: being able to do something similar does not mean the thing asked about is supported. If it isn't stated, say you can't confirm it. Never combine separate pieces of information to suggest a feature exists.
    - Be concise and direct, like a real support reply, not a research summary.

    Information:
    ${context}

    Question: ${question}

    Answer now, in that voice. Cite with [number] markers matching the list above whenever you use information from it, even if it's only one source. If you can't answer, don't cite anything.`;

  const result = await withRetry(
    () =>
      ai.models.generateContent({
        model: CHAT_MODEL,
        contents: prompt,
      }),
    "generation",
  );

  const text = result.text ?? "";

  const cited = new Set(
    [...text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap((m) =>
      m[1].split(",").map((n) => Number(n.trim())),
    ),
  );

  const cleanAnswer = text.replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, "").trim();

  if (cited.size === 0) {
    // Model made no citations at all — treat as a refusal/non-answer, show no sources
    return { answer: cleanAnswer, sources: [] };
  }

  const citedChunks = usable.filter((_, i) => cited.has(i + 1));

  return {
    answer: cleanAnswer,
    sources: citedChunks.map((c) => ({
      source: c.source,
      heading: c.headingPath,
    })),
  };
}
