import type { ChatTurn } from "../generate/prompts.js";

// How much of a conversation is used: enough for a follow-up, small enough to stay cheap
export const HISTORY_MESSAGES = 6;
export const HISTORY_CHARS = 500;

// The "history" of a query, checked and cut down. A caller may send its whole conversation:
// only the last messages, and the start of each, are kept. Returns null when the shape is wrong.
export function parseHistory(input: unknown): ChatTurn[] | null {
  if (input == null) return [];
  if (!Array.isArray(input)) return null;

  const turns: ChatTurn[] = [];
  for (const item of input) {
    const { role, content } = (item ?? {}) as { role?: unknown; content?: unknown };
    if ((role !== "user" && role !== "assistant") || typeof content !== "string" || !content.trim()) return null;
    turns.push({ role, content: content.trim().slice(0, HISTORY_CHARS) });
  }
  return turns.slice(-HISTORY_MESSAGES);
}
