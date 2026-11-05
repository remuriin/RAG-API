import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { BUDGET_USD, GEMINI_DELAY_MS } from "./env.js";
import { paths, readJson, writeJson } from "./data.js";
import { join } from "node:path";
import { RESULTS_DIR } from "./env.js";

// US dollars per million tokens, first-party API rates; the Batch API halves them
const PRICES: Record<string, { in: number; out: number }> = {
  "claude-haiku-5-5": { in: 0.1, out: 0.5 },
  "claude-sonnet-5-5": { in: 2, out: 10 },
  "claude-opus-5-5": { in: 4, out: 20 },
  "claude-fable-5-1": { in: 10, out: 50 },
};

export const ANSWER_MODELS = ["gemini-3.1-flash-lite", "claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"];
export const isClaude = (model: string) => model.startsWith("claude-");

export interface Usage { input: number; output: number }
export interface CallResult { text: string; usage: Usage; stop?: string; error?: string }

// ── spend ledger ────────────────────────────────────────────────────────────────

export function costUsd(model: string, usage: Usage, batch: boolean): number {
  const p = PRICES[model];
  if (!p) return 0; // Gemini on the free key
  return ((usage.input * p.in + usage.output * p.out) / 1e6) * (batch ? 0.5 : 1);
}

export function spentUsd(): number {
  if (!existsSync(paths.ledger)) return 0;
  return readFileSync(paths.ledger, "utf8")
    .split("\n")
    .filter(Boolean)
    .reduce((sum, line) => sum + JSON.parse(line).usd, 0);
}

function record(label: string, model: string, usage: Usage, batch: boolean, calls: number): number {
  const usd = costUsd(model, usage, batch);
  if (usd > 0 || isClaude(model)) {
    mkdirSync(RESULTS_DIR, { recursive: true });
    appendFileSync(paths.ledger, JSON.stringify({ at: new Date().toISOString(), label, model, batch, calls, ...usage, usd }) + "\n");
  }
  return usd;
}

// Refuses to start work that would take the recorded Anthropic spend past the budget
export function guardBudget(estimateUsd: number, what: string): void {
  const spent = spentUsd();
  if (spent + estimateUsd > BUDGET_USD) {
    throw new Error(
      `Budget stop: ${what} is estimated at $${estimateUsd.toFixed(2)}, $${spent.toFixed(2)} is already spent, and the cap is $${BUDGET_USD}. Raise EVAL_BUDGET_USD in .env only if the credit allows it.`,
    );
  }
  console.log(`Budget: $${spent.toFixed(2)} spent of $${BUDGET_USD}; this step is estimated at $${estimateUsd.toFixed(2)}.`);
}

// Rough estimate from text length: about 4 characters per token
export function estimateUsd(model: string, inputChars: number, outputTokens: number, batch: boolean): number {
  return costUsd(model, { input: Math.ceil(inputChars / 4), output: outputTokens }, batch);
}

// ── Claude ──────────────────────────────────────────────────────────────────────

let anthropic: Anthropic | null = null;
function claude(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set in RAG-API/.env");
  anthropic ??= new Anthropic({ maxRetries: 4 });
  return anthropic;
}

export type ClaudeParams = Anthropic.MessageCreateParamsNonStreaming;

function readMessage(message: Anthropic.Message): CallResult {
  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const usage = { input: message.usage.input_tokens, output: message.usage.output_tokens };
  // a declined request comes back as HTTP 200 with stop_reason "refusal"
  return message.stop_reason === "refusal"
    ? { text, usage, stop: "refusal", error: "the model declined the request (stop_reason refusal)" }
    : { text, usage, stop: message.stop_reason ?? undefined };
}

export async function callClaude(params: ClaudeParams, label: string): Promise<CallResult> {
  try {
    const message = await claude().messages.create(params);
    const result = readMessage(message);
    record(label, params.model, result.usage, false, 1);
    return result;
  } catch (err) {
    if (err instanceof Anthropic.APIError) return { text: "", usage: { input: 0, output: 0 }, error: `API error ${err.status}: ${err.message}` };
    throw err;
  }
}

// Runs many requests through the Batch API (half price). The batch id is saved, so a run that is
// stopped and started again picks up the same batch instead of paying for a new one.
export async function runClaudeBatch(
  requests: { custom_id: string; params: ClaudeParams }[],
  label: string,
): Promise<Map<string, CallResult>> {
  const pendingPath = join(RESULTS_DIR, "batches.json");
  const pending = readJson<Record<string, string>>(pendingPath) ?? {};
  let batchId = pending[label];
  if (batchId) {
    console.log(`Resuming batch ${batchId} for ${label}.`);
  } else {
    const batch = await claude().messages.batches.create({ requests });
    batchId = batch.id;
    pending[label] = batchId;
    writeJson(pendingPath, pending);
    console.log(`Submitted batch ${batchId} with ${requests.length} requests for ${label}.`);
  }

  for (;;) {
    const batch = await claude().messages.batches.retrieve(batchId);
    if (batch.processing_status === "ended") break;
    const c = batch.request_counts;
    console.log(`  ${new Date().toLocaleTimeString()} batch ${batch.processing_status}: ${c.succeeded} done, ${c.processing} processing`);
    await sleep(30_000);
  }

  const out = new Map<string, CallResult>();
  const total: Usage = { input: 0, output: 0 };
  const model = requests[0].params.model;
  for await (const item of await claude().messages.batches.results(batchId)) {
    if (item.result.type === "succeeded") {
      const r = readMessage(item.result.message);
      total.input += r.usage.input;
      total.output += r.usage.output;
      out.set(item.custom_id, r);
    } else {
      const detail = item.result.type === "errored" ? `errored (${(item.result.error as any)?.error?.type ?? "unknown"})` : item.result.type;
      out.set(item.custom_id, { text: "", usage: { input: 0, output: 0 }, error: `batch request ${detail}` });
    }
  }
  const usd = record(label, model, total, true, out.size);
  console.log(`Batch ${batchId} finished: ${out.size} results, $${usd.toFixed(2)}.`);
  delete pending[label];
  writeJson(pendingPath, pending);
  return out;
}

// ── Gemini ──────────────────────────────────────────────────────────────────────

let google: GoogleGenAI | null = null;
const gemini = () => (google ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }));

export async function callGemini(
  model: string,
  systemInstruction: string,
  message: string,
  options: { temperature?: number; jsonSchema?: unknown } = {},
): Promise<CallResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await gemini().models.generateContent({
        model,
        contents: message,
        config: {
          systemInstruction,
          temperature: options.temperature,
          ...(options.jsonSchema ? { responseMimeType: "application/json", responseJsonSchema: options.jsonSchema } : {}),
        },
      });
      await sleep(GEMINI_DELAY_MS);
      const u = result.usageMetadata;
      return {
        text: result.text ?? "",
        usage: { input: u?.promptTokenCount ?? 0, output: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0) },
      };
    } catch (err: any) {
      const status = err?.status ?? err?.code;
      if ((status === 429 || status === 503 || status === 500) && attempt < 4) {
        const wait = 20_000 * (attempt + 1);
        console.log(`  Gemini ${status}, waiting ${wait / 1000} s`);
        await sleep(wait);
        continue;
      }
      return { text: "", usage: { input: 0, output: 0 }, error: `Gemini error ${status ?? ""}: ${err?.message ?? err}` };
    }
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Runs fn over items, a few at a time
export async function pool<T, R>(items: T[], size: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}
