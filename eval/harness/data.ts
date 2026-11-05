import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EVAL_DIR, RESULTS_DIR } from "./env.js";

export type Label = "correct" | "partial" | "missing" | "incorrect";
export const LABELS: Label[] = ["correct", "partial", "missing", "incorrect"];
export const LABEL_SCORE: Record<Label, number> = { correct: 1, partial: 0.5, missing: 0, incorrect: -1 };

export interface Fact { text: string; source: string[] }
export interface Turn { role: "user" | "assistant"; content: string }
export interface Case {
  id: string;
  category: string;
  split: "dev" | "held";
  question: string;
  history?: Turn[];
  facts: string[];
  sources?: string[][];
  refuse: boolean;
  subtype?: string;
  tags?: string[];
  lang?: string;
  expect?: string;
  canary?: string;
}
export interface Passage { source: string; headingPath: string; content: string; similarity: number | null }

const facts = JSON.parse(readFileSync(join(EVAL_DIR, "facts.json"), "utf8"));
const cases = JSON.parse(readFileSync(join(EVAL_DIR, "cases.json"), "utf8"));
export const FACTS: Record<string, Fact> = facts.facts;
export const CASES: Case[] = cases.cases;
export const VERSIONS = { corpus: cases.corpus_version as string, cases: cases.version as string, facts: facts.version as string };

// "fares.md#Discounts" matches a chunk of fares.md whose heading path contains "Discounts"
export function matches(alternative: string, p: { source: string; headingPath: string }): boolean {
  const [file, heading] = alternative.split("#");
  return p.source === file && p.headingPath.split(" > ").includes(heading);
}

// The retrieval groups of a case: its own, or one per key fact; each group is a list of alternatives
export function sourceGroups(c: Case): string[][] {
  if (c.sources) return c.sources;
  const seen = new Set<string>();
  const groups: string[][] = [];
  for (const id of c.facts) {
    const g = FACTS[id].source;
    const key = [...g].sort().join("|");
    if (!seen.has(key)) {
      seen.add(key);
      groups.push(g);
    }
  }
  return groups;
}

export function readJson<T>(path: string): T | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

export const paths = {
  retrieval: join(RESULTS_DIR, "retrieval.json"),
  run: (slug: string) => join(RESULTS_DIR, "runs", `${slug}.json`),
  judged: (slug: string, judge: string) => join(RESULTS_DIR, "judged", `${slug}__${judge}.json`),
  ledger: join(RESULTS_DIR, "ledger.jsonl"),
  handcheck: (slug: string) => join(RESULTS_DIR, "handcheck", `${slug}.json`),
  report: (name: string) => join(RESULTS_DIR, "reports", name),
};

export const runSlug = (model: string, mode: "normal" | "oracle", run: number) => `${model}__${mode}__r${run}`;

export function selectCases(opts: { split?: string; limit?: number; ids?: string[] }): Case[] {
  let list = CASES;
  if (opts.ids?.length) list = list.filter((c) => opts.ids!.includes(c.id));
  if (opts.split && opts.split !== "all") list = list.filter((c) => c.split === opts.split);
  if (opts.limit) list = spread(list, opts.limit);
  return list;
}

// A sample that takes cases from every category in turn, so a small run still covers them all
export function spread(list: Case[], n: number): Case[] {
  const byCat = new Map<string, Case[]>();
  for (const c of list) byCat.set(c.category, [...(byCat.get(c.category) ?? []), c]);
  const out: Case[] = [];
  for (let i = 0; out.length < n && out.length < list.length; i++) {
    for (const group of byCat.values()) if (group[i] && out.length < n) out.push(group[i]);
  }
  return out;
}
