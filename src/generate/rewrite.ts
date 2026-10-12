import { isRetryable, withRetry } from "../util/retry.js";
import { rewriteMessage, rewriteSystemInstruction, type ChatTurn } from "./prompts.js";

export const MAX_QUESTION_CHARS = 2000;
const REWRITE_RETRIES = 3;

// Turns a follow-up into a question that stands on its own, using the earlier messages.
// `generate` is the model call (system instruction, message) => text; it is a parameter so the
// rules below can be checked without a model (scripts/check-history.ts).
export async function rewriteQuestion(
  question: string,
  history: ChatTurn[],
  generate: (systemInstruction: string, message: string) => Promise<string>,
  baseDelayMs?: number,
): Promise<string> {
  // no earlier messages: nothing to lean on, and no model call
  if (history.length === 0) return question;

  let text: string;
  try {
    text = await withRetry(() => generate(rewriteSystemInstruction(), rewriteMessage(history, question)), "rewrite", {
      retries: REWRITE_RETRIES,
      baseDelayMs,
    });
  } catch (err) {
    // still busy after the retries: the answer step would hit the same wall, so the caller gets the 503
    if (isRetryable(err)) throw err;
    console.warn("question rewrite failed, using the question as sent:", err instanceof Error ? err.message : err);
    return question;
  }

  // an empty reply: the question as sent is better than none
  return text.trim().slice(0, MAX_QUESTION_CHARS) || question;
}
