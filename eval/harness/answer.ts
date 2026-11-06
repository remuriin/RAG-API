import { createHash } from "node:crypto";
import { type Case, paths, readJson, runSlug, VERSIONS, writeJson } from "./data.js";
import { callClaude, callGemini, type CallResult, type ClaudeParams, estimateUsd, guardBudget, isClaude, pool, runClaudeBatch, type Usage } from "./models.js";
import { ANSWER_TEMPERATURE, buildPrompt, instanceSettings, readAnswer, type RetrievalFile, REWRITE_MODEL, SIMILARITY_FLOOR, TOP_K } from "./rem.js";

export const CLAUDE_ANSWER_EFFORT = "low" as const;
const CLAUDE_ANSWER_MAX_TOKENS = 4000;

export interface AnswerRecord {
  path: "answer" | "no-match";
  passages: { source: string; headingPath: string; similarity: number | null }[];
  raw: string;
  answer: string;
  cited: { source: string; heading: string }[];
  answered: boolean;
  usage: Usage;
  error?: string;
}
export interface RunFile {
  slug: string;
  model: string;
  mode: "normal" | "oracle";
  run: number | string;
  versions: typeof VERSIONS;
  settings: Record<string, unknown>;
  startedAt: string;
  answers: Record<string, AnswerRecord>;
}

export function loadRetrieval(): RetrievalFile {
  const r = readJson<RetrievalFile>(paths.retrieval);
  if (!r) throw new Error('No retrieval yet. Run: npm run eval -- retrieve');
  // retrieval depends on the corpus and the questions, not on the notes or facts of a case
  if (r.versions.corpus !== VERSIONS.corpus) throw new Error("retrieval.json is from another corpus version. Run: npm run eval -- retrieve --fresh");
  return r;
}

export async function answerRun(
  model: string,
  mode: "normal" | "oracle",
  run: number | string,
  cases: Case[],
  batch: boolean,
): Promise<RunFile> {
  const retrieval = loadRetrieval();
  const settings = await instanceSettings();
  const slug = runSlug(model, mode, run as number);
  const file: RunFile = readJson<RunFile>(paths.run(slug)) ?? {
    slug,
    model,
    mode,
    run,
    versions: VERSIONS,
    settings: {
      topK: TOP_K,
      similarityFloor: SIMILARITY_FLOOR,
      rewriteModel: REWRITE_MODEL,
      persona: settings.options.persona ?? "support",
      productName: settings.options.productName,
      markdown: false,
      ...(isClaude(model) ? { effort: CLAUDE_ANSWER_EFFORT } : { temperature: ANSWER_TEMPERATURE }),
      promptHash: "",
    },
    startedAt: new Date().toISOString(),
    answers: {},
  };

  // the oracle mode has nothing to hand over for must-refuse cases
  const todo = cases.filter((c) => !file.answers[c.id] || file.answers[c.id].error).filter((c) => mode === "normal" || retrieval.cases[c.id]?.oracle);
  for (const c of todo) if (!retrieval.cases[c.id]) throw new Error(`${c.id} has no retrieval. Run: npm run eval -- retrieve`);
  if (todo.length === 0) {
    console.log(`${slug}: every selected case is already answered.`);
    return file;
  }
  const prompts = new Map(todo.map((c) => [c.id, buildPrompt(retrieval.cases[c.id], mode, settings)]));
  file.settings.promptHash = createHash("sha256")
    .update([...new Set([...prompts.values()].map((p) => p.system))].sort().join("\n---\n"))
    .digest("hex")
    .slice(0, 12);

  const save = (c: Case, result: CallResult) => {
    const prompt = prompts.get(c.id)!;
    const read = readAnswer(result.text, prompt, settings);
    file.answers[c.id] = {
      path: prompt.path,
      passages: prompt.passages.map((p) => ({ source: p.source, headingPath: p.headingPath, similarity: p.similarity })),
      raw: result.text,
      ...read,
      usage: result.usage,
      ...(result.error ? { error: result.error } : {}),
    };
  };

  console.log(`${slug}: answering ${todo.length} cases${batch && isClaude(model) ? " through the Batch API" : ""}.`);
  if (!isClaude(model)) {
    for (const [i, c] of todo.entries()) {
      const p = prompts.get(c.id)!;
      save(c, await callGemini(model, p.system, p.message, { temperature: ANSWER_TEMPERATURE }));
      writeJson(paths.run(slug), file);
      if ((i + 1) % 10 === 0) console.log(`  ${i + 1}/${todo.length}`);
    }
  } else {
    const params = (c: Case): ClaudeParams => {
      const p = prompts.get(c.id)!;
      return {
        model,
        max_tokens: CLAUDE_ANSWER_MAX_TOKENS,
        system: p.system,
        messages: [{ role: "user", content: p.message }],
        output_config: { effort: CLAUDE_ANSWER_EFFORT },
      };
    };
    const chars = [...prompts.values()].reduce((n, p) => n + p.system.length + p.message.length, 0);
    guardBudget(estimateUsd(model, chars, 800 * todo.length, batch), `${todo.length} answers from ${model}`);
    if (batch) {
      const results = await runClaudeBatch(todo.map((c) => ({ custom_id: c.id, params: params(c) })), `answer ${slug}`);
      for (const c of todo) save(c, results.get(c.id) ?? { text: "", usage: { input: 0, output: 0 }, error: "missing from batch results" });
      writeJson(paths.run(slug), file);
    } else {
      let n = 0;
      await pool(todo, 4, async (c) => {
        save(c, await callClaude(params(c), `answer ${slug}`));
        writeJson(paths.run(slug), file);
        if (++n % 10 === 0) console.log(`  ${n}/${todo.length}`);
      });
    }
  }

  const errors = Object.entries(file.answers).filter(([, a]) => a.error);
  console.log(`${slug}: ${Object.keys(file.answers).length} answers saved${errors.length ? `, ${errors.length} with errors (run the same command again to retry them)` : ""}.`);
  return file;
}
