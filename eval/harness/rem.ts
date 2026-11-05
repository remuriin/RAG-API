// Rem's query path, for the eval: the same chunker, embeddings, search, rewrite and prompts as
// POST /query, imported from src/. Only the final model call is swapped, so any answer model can be
// tested on the same passages. The post-processing below mirrors src/generate/answer.ts; keep the
// two in step when answer.ts changes.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pool as db } from "../../src/db/client.js";
import { getInstanceSettings } from "../../src/db/instance.js";
import { standaloneQuestion } from "../../src/generate/answer.js";
import {
  answerMessage,
  answerSystemInstruction,
  isPersona,
  noMatchMessage,
  noMatchSystemInstruction,
  PERSONAS,
  type PromptOptions,
} from "../../src/generate/prompts.js";
import { ingestDocument } from "../../src/ingest/pipeline.js";
import { deleteDocument, listTopics } from "../../src/ingest/store.js";
import { retrieveRelevantChunks } from "../../src/retrieve/search.js";
import { type Case, type Passage, CASES, matches, paths, readJson, sourceGroups, VERSIONS, writeJson } from "./data.js";
import { EVAL_DIR } from "./env.js";
import { sleep } from "./models.js";

export const TOP_K = 5;
export const SIMILARITY_FLOOR = 0.625; // src/generate/answer.ts
export const ANSWER_TEMPERATURE = 0.2; // src/generate/answer.ts, Gemini only
const CITATION_RUN = /\s*\[\d+(?:\s*,\s*\d+)*\](?:\s*,?\s*\[\d+(?:\s*,\s*\d+)*\])*/g;
export const REWRITE_MODEL = "gemini-3.1-flash-lite"; // CHAT_MODEL in src/generate/answer.ts

export interface Retrieved { standalone: string; chunks: Passage[]; oracle: Passage[] | null }
export interface RetrievalFile { versions: typeof VERSIONS; createdAt: string; rewriteModel: string; topK: number; cases: Record<string, Retrieved> }

export async function closeDb(): Promise<void> {
  await db.end();
}

// Uploads eval/corpus to the Tricycall Eval instance, replacing what is there
export async function ingestCorpus(): Promise<void> {
  const dir = join(EVAL_DIR, "corpus");
  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  for (const file of files) {
    await deleteDocument(file);
    const result = await ingestDocument(file, readFileSync(join(dir, file), "utf8"), "markdown");
    console.log(`  ${file}: ${result.chunks} chunks`);
  }
  console.log(`Ingested ${files.length} docs. Run "retrieve --fresh" next, since the chunks changed.`);
}

async function goldPassages(c: Case): Promise<Passage[]> {
  const out: Passage[] = [];
  for (const group of sourceGroups(c)) {
    let found: Passage | undefined;
    for (const alt of group) {
      const file = alt.split("#")[0];
      const rows = await db.query(
        `SELECT d.source, c.heading_path, c.chunk_text FROM chunks c JOIN documents d ON d.id = c.document_id
         WHERE c.instance_id = $1 AND d.status = 'ready' AND d.source = $2 ORDER BY c.chunk_index`,
        [process.env.INSTANCE_ID, file],
      );
      const row = rows.rows.find((r) => matches(alt, { source: r.source, headingPath: r.heading_path }));
      if (row) {
        found = { source: row.source, headingPath: row.heading_path, content: row.chunk_text, similarity: null };
        break;
      }
    }
    if (!found) throw new Error(`${c.id}: no chunk in the eval instance for ${group.join(" or ")}. Was the corpus ingested?`);
    if (!out.some((p) => p.source === found!.source && p.headingPath === found!.headingPath)) out.push(found);
  }
  return out;
}

// Retrieval once per case, shared by every answer model so they all read the same passages.
// Follow-ups are rewritten with Rem's own rewrite model first, as POST /query does.
export async function retrieveAll(fresh: boolean): Promise<void> {
  const file: RetrievalFile = (!fresh && readJson<RetrievalFile>(paths.retrieval)) || {
    versions: VERSIONS,
    createdAt: new Date().toISOString(),
    rewriteModel: REWRITE_MODEL,
    topK: TOP_K,
    cases: {},
  };
  if (JSON.stringify(file.versions) !== JSON.stringify(VERSIONS)) {
    throw new Error("retrieval.json was made from other corpus or case versions. Run: retrieve --fresh");
  }
  let done = 0;
  for (const c of CASES) {
    if (file.cases[c.id]) continue;
    const standalone = c.history?.length ? await standaloneQuestion(c.question, c.history) : c.question;
    const chunks = await retrieveRelevantChunks(standalone, TOP_K);
    const retrieved: Passage[] = chunks.map((ch) => ({ source: ch.source, headingPath: ch.headingPath, content: ch.content, similarity: Number(ch.similarity) }));
    let oracle: Passage[] | null = null;
    if (!c.refuse && c.facts.length) {
      const gold = await goldPassages(c);
      const pad = retrieved.filter((p) => !gold.some((g) => g.source === p.source && g.headingPath === p.headingPath));
      oracle = [...gold, ...pad].slice(0, Math.max(TOP_K, gold.length));
    }
    file.cases[c.id] = { standalone, chunks: retrieved, oracle };
    writeJson(paths.retrieval, file);
    done++;
    if (done % 10 === 0) console.log(`  retrieved ${Object.keys(file.cases).length}/${CASES.length}`);
    await sleep(500);
  }
  console.log(`Retrieval ready for ${Object.keys(file.cases).length} cases.`);
}

export interface Settings { options: PromptOptions; topics: string[] }

export async function instanceSettings(): Promise<Settings> {
  const s = await getInstanceSettings();
  return {
    options: { productName: s.productName, persona: isPersona(s.persona) ? s.persona : undefined, markdown: false },
    topics: await listTopics(),
  };
}

export interface Prompt { path: "answer" | "no-match"; system: string; message: string; passages: Passage[] }

// The prompt Rem would send: passages over the similarity floor, or the no-match path without any.
// The oracle mode skips the floor: its passages are the right ones by construction.
export function buildPrompt(r: Retrieved, mode: "normal" | "oracle", s: Settings): Prompt {
  if (mode === "oracle") {
    const passages = r.oracle ?? [];
    return { path: "answer", system: answerSystemInstruction(s.options), message: answerMessage(r.standalone, toChunks(passages)), passages };
  }
  const usable = r.chunks.filter((p) => (p.similarity ?? 0) >= SIMILARITY_FLOOR);
  if (usable.length === 0) {
    return { path: "no-match", system: noMatchSystemInstruction(s.options), message: noMatchMessage(r.standalone, s.topics), passages: [] };
  }
  return { path: "answer", system: answerSystemInstruction(s.options), message: answerMessage(r.standalone, toChunks(usable)), passages: usable };
}

const toChunks = (ps: Passage[]) => ps.map((p, i) => ({ id: String(i), source: p.source, headingPath: p.headingPath, content: p.content, similarity: p.similarity ?? 1 }));

export interface Answer { answer: string; cited: { source: string; heading: string }[]; answered: boolean }

// What src/generate/answer.ts does with the model's text
export function readAnswer(text: string, prompt: Prompt, s: Settings): Answer {
  const fallback = PERSONAS[s.options.persona ?? "support"].fallback;
  if (prompt.path === "no-match") return { answer: text.trim() || fallback, cited: [], answered: false };
  const cited = new Set(
    [...text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap((m) => m[1].split(",").map((n) => Number(n.trim()))),
  );
  const citedPassages = prompt.passages.filter((_, i) => cited.has(i + 1));
  return {
    answer: text.replace(CITATION_RUN, "").trim() || fallback,
    cited: citedPassages.map((p) => ({ source: p.source, heading: p.headingPath })),
    answered: citedPassages.length > 0,
  };
}
