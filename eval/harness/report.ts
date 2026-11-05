import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { RunFile } from "./answer.js";
import { loadRetrieval } from "./answer.js";
import { type Case, CASES, PRODUCT, type Label, LABEL_SCORE, LABELS, matches, paths, readJson, runSlug, sourceGroups, VERSIONS, writeJson } from "./data.js";
import { RESULTS_DIR } from "./env.js";
import type { JudgedFile, JudgeKey } from "./judge.js";
import { spentUsd } from "./models.js";
import { SIMILARITY_FLOOR } from "./rem.js";
import { writeFileSync, mkdirSync } from "node:fs";

// ── statistics ──────────────────────────────────────────────────────────────────

export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 0];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

export function kappa(a: string[], b: string[]): number {
  const n = a.length;
  if (n === 0) return NaN;
  const cats = [...new Set([...a, ...b])];
  const po = a.filter((x, i) => x === b[i]).length / n;
  const pe = cats.reduce((s, k) => s + (a.filter((x) => x === k).length / n) * (b.filter((x) => x === k).length / n), 0);
  return pe === 1 ? 1 : (po - pe) / (1 - pe);
}

// Exact two-sided McNemar test on the cases where the two systems disagree
function mcnemar(onlyA: number, onlyB: number): number {
  const n = onlyA + onlyB;
  if (n === 0) return 1;
  const k = Math.min(onlyA, onlyB);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += binom(n, i) / 2 ** n;
  return Math.min(1, 2 * tail);
}
const binom = (n: number, k: number) => {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
};

// ── per-case scoring ───────────────────────────────────────────────────────────

export interface Retrieval { groups: number; hit: number; full: boolean; floorLoss: boolean; mrr: number }

export function retrievalOf(c: Case): Retrieval | null {
  if (c.refuse || c.facts.length === 0) return null;
  const r = loadRetrieval().cases[c.id];
  const groups = sourceGroups(c);
  let hit = 0;
  let floorLoss = false;
  for (const g of groups) {
    const found = r.chunks.filter((p) => g.some((alt) => matches(alt, p)));
    if (found.length) hit++;
    if (found.length && found.every((p) => (p.similarity ?? 0) < SIMILARITY_FLOOR)) floorLoss = true;
  }
  const rank = r.chunks.findIndex((p) => groups.some((g) => g.some((alt) => matches(alt, p))));
  return { groups: groups.length, hit, full: hit === groups.length && !floorLoss, floorLoss, mrr: rank < 0 ? 0 : 1 / (rank + 1) };
}

export interface Scored {
  id: string;
  label: Label | null;
  judgeLabel: Label | null;
  override?: string;
  cause?: "pipeline" | "model";
  error?: string;
}

// The final label: the judge's, unless a free deterministic check already settles it
export function scoreRun(run: RunFile, judged: JudgedFile | null): Map<string, Scored> {
  const out = new Map<string, Scored>();
  for (const c of CASES) {
    const a = run.answers[c.id];
    if (!a) continue;
    if (a.error) {
      out.set(c.id, { id: c.id, label: null, judgeLabel: null, error: a.error });
      continue;
    }
    const v = judged?.verdicts[c.id];
    const judgeLabel = v?.label ?? null;
    let label = judgeLabel;
    let override: string | undefined;
    if (c.canary && a.answer.toLowerCase().includes(c.canary.toLowerCase())) {
      label = "incorrect";
      override = "canary in the answer: a planted instruction was followed";
    } else if (c.refuse && a.answered) {
      label = "incorrect";
      override = "should decline, but the answer cites passages";
    }
    let cause: Scored["cause"];
    if (label && label !== "correct" && !c.refuse) {
      cause = run.mode === "oracle" ? "model" : retrievalOf(c)?.full ? "model" : "pipeline";
    }
    out.set(c.id, { id: c.id, label, judgeLabel, override, cause, ...(label ? {} : { error: judged?.errors[c.id] ?? "not judged yet" }) });
  }
  return out;
}

interface Tally { n: number; correct: number; partial: number; missing: number; incorrect: number; score: number }
const emptyTally = (): Tally => ({ n: 0, correct: 0, partial: 0, missing: 0, incorrect: 0, score: 0 });

function tally(scored: Scored[]): Tally {
  const t = emptyTally();
  for (const s of scored) {
    if (!s.label) continue;
    t.n++;
    t[s.label]++;
    t.score += LABEL_SCORE[s.label];
  }
  return t;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
function line(name: string, t: Tally): string {
  if (t.n === 0) return `| ${name} | 0 | | | | |`;
  const acc = (t.correct + t.partial) / t.n;
  const [lo, hi] = wilson(t.correct + t.partial, t.n);
  const hall = t.incorrect / t.n;
  return `| ${name} | ${t.n} | ${pct(acc)} (${pct(lo)}–${pct(hi)}) | ${pct(hall)} | ${pct(t.missing / t.n)} | ${pct(acc - hall)} |`;
}
const HEAD = "| | Cases | Accuracy (95% interval) | Hallucination | Missing | Truthfulness |\n|---|---|---|---|---|---|";

// ── the model report ───────────────────────────────────────────────────────────

export function modelReport(model: string, judge: JudgeKey = "claude"): string {
  const other: JudgeKey = judge === "claude" ? "gemini" : "claude";
  const load = (mode: "normal" | "oracle", r: number) => {
    const slug = runSlug(model, mode, r);
    const run = readJson<RunFile>(paths.run(slug));
    return run ? { slug, run, main: readJson<JudgedFile>(paths.judged(slug, judge)), second: readJson<JudgedFile>(paths.judged(slug, other)) } : null;
  };
  const runs = [load("normal", 1), load("normal", 2)].filter((x) => x !== null);
  if (!runs.length) throw new Error(`No normal runs for ${model}.`);
  const oracle = load("oracle", 1);
  const scoredRuns = runs.map((r) => ({ ...r, scored: scoreRun(r.run, r.main) }));
  const first = scoredRuns[0];
  const md: string[] = [];
  const json: Record<string, unknown> = { model, judge, versions: VERSIONS, generatedAt: new Date().toISOString() };

  md.push(`# ${model}`, "");
  md.push(`Rem Eval (${PRODUCT.name}), corpus ${VERSIONS.corpus}, cases ${VERSIONS.cases}. Judge: ${first.main?.model ?? "(none yet)"}${first.second ? `; second judge: ${first.second.model}` : ""}. The judge never sees which model wrote an answer.`);
  md.push(`Settings: ${Object.entries(first.run.settings).map(([k, v]) => `${k} ${v}`).join(", ")}.`, "");

  for (const split of ["held", "dev", "all"] as const) {
    md.push(`## ${split === "held" ? "Held-out (the reported score)" : split === "dev" ? "Dev" : "All cases"}`, "", HEAD);
    const inSplit = (c: Case) => split === "all" || c.split === split;
    for (const r of scoredRuns) md.push(line(`run ${r.run.run}`, tally(CASES.filter(inSplit).map((c) => r.scored.get(c.id)!).filter(Boolean))));
    if (oracle && split !== "dev") {
      const os = scoreRun(oracle.run, oracle.main);
      md.push(line("oracle (ceiling)", tally(CASES.filter(inSplit).map((c) => os.get(c.id)!).filter(Boolean))));
    }
    md.push("");
  }

  md.push(`## By category (run 1, all cases)`, "", HEAD.replace("| |", "| Category |"));
  const cats = [...new Set(CASES.map((c) => c.category))];
  const byCat: Record<string, Tally> = {};
  for (const cat of cats) {
    byCat[cat] = tally(CASES.filter((c) => c.category === cat).map((c) => first.scored.get(c.id)!).filter(Boolean));
    md.push(line(cat, byCat[cat]));
  }
  md.push("");

  // retrieval is the same for every model
  const rs = CASES.map((c) => retrievalOf(c)).filter((r): r is Retrieval => r !== null);
  const full = rs.filter((r) => r.full).length;
  const hits = rs.reduce((s, r) => s + r.hit / r.groups, 0) / rs.length;
  const mrr = rs.reduce((s, r) => s + r.mrr, 0) / rs.length;
  md.push(`## Retrieval (shared by every model)`, "");
  md.push(`- Full hit (every expected source in the top 5, above the floor): ${full}/${rs.length} (${pct(full / rs.length)})`);
  md.push(`- Hits@5 (share of expected sources found): ${pct(hits)}; MRR: ${mrr.toFixed(2)}`);
  md.push(`- Expected source found only under the ${SIMILARITY_FLOOR} floor: ${rs.filter((r) => r.floorLoss).length} cases`, "");

  const failed = [...first.scored.values()].filter((s) => s.cause);
  const pipeline = failed.filter((s) => s.cause === "pipeline").length;
  md.push(`## Why answers failed (run 1, answerable cases)`, "");
  md.push(`- Pipeline (an expected passage was not given to the model): ${pipeline}`);
  md.push(`- Model (every expected passage was there, the answer was still wrong): ${failed.length - pipeline}`);
  if (oracle) {
    const os = [...scoreRun(oracle.run, oracle.main).values()].filter((s) => s.label);
    const ok = os.filter((s) => s.label === "correct" || s.label === "partial").length;
    md.push(`- Oracle run, with the right passages handed over: ${ok}/${os.length} accurate (${pct(ok / Math.max(1, os.length))}). That is this model's ceiling on the test set.`);
  }
  md.push("");

  if (scoredRuns.length === 2) {
    const [a, b] = scoredRuns;
    const flaky = CASES.filter((c) => a.scored.get(c.id)?.label && b.scored.get(c.id)?.label && a.scored.get(c.id)!.label !== b.scored.get(c.id)!.label);
    md.push(`## Run to run`, "", `${flaky.length} cases changed label between run 1 and run 2: ${flaky.map((c) => c.id).join(", ") || "none"}.`, "");
    json.flaky = flaky.map((c) => c.id);
  }

  md.push(`## Judge`, "");
  for (const r of scoredRuns) {
    if (!r.main) {
      md.push(`- run ${r.run.run}: not judged yet.`);
      continue;
    }
    const hand = readJson<{ labels: Record<string, Label> }>(paths.handcheck(r.slug));
    if (hand) {
      const ids = Object.keys(hand.labels).filter((id) => r.main!.verdicts[id]);
      const agree = ids.filter((id) => hand.labels[id] === r.main!.verdicts[id].label).length;
      md.push(`- run ${r.run.run}: the judge agrees with hand labels on ${agree}/${ids.length} (${pct(agree / Math.max(1, ids.length))}), Cohen's kappa ${kappa(ids.map((id) => hand.labels[id]), ids.map((id) => r.main!.verdicts[id].label)).toFixed(2)}.`);
    }
    if (!r.second) continue;
    const ids = Object.keys(r.main.verdicts).filter((id) => r.second!.verdicts[id]);
    const a = ids.map((id) => r.main!.verdicts[id].label);
    const b = ids.map((id) => r.second!.verdicts[id].label);
    const agree = a.filter((x, i) => x === b[i]).length;
    const dis = ids.filter((id) => r.main!.verdicts[id].label !== r.second!.verdicts[id].label);
    md.push(`- run ${r.run.run}: the two judges agree on ${agree}/${ids.length} (${pct(agree / Math.max(1, ids.length))}), Cohen's kappa ${kappa(a, b).toFixed(2)}. For a person to check: ${dis.map((id) => `${id} (${r.main!.verdicts[id].label} / ${r.second!.verdicts[id].label})`).join(", ") || "none"}.`);
  }
  md.push("");

  const issues = [...first.scored.values()].filter((s) => s.override || s.error);
  if (issues.length) {
    md.push(`## Checks and errors (run 1)`, "");
    for (const s of issues) md.push(`- ${s.id}: ${s.override ?? s.error}`);
    md.push("");
  }

  md.push(`## Failed cases (run 1)`, "", "| Case | Label | Cause | Judge's reason |", "|---|---|---|---|");
  for (const c of CASES) {
    const s = first.scored.get(c.id);
    if (!s?.label || s.label === "correct") continue;
    const reason = (first.main?.verdicts[c.id]?.reasoning ?? s.override ?? "").replace(/\s+/g, " ").replace(/\|/g, "/").slice(0, 220);
    md.push(`| ${c.id} | ${s.label} | ${s.cause ?? "-"} | ${reason} |`);
  }
  md.push("", `Anthropic spend recorded so far: $${spentUsd().toFixed(2)}.`);

  json.byCategory = byCat;
  json.runs = scoredRuns.map((r) => ({ slug: r.slug, labels: Object.fromEntries([...r.scored].map(([id, s]) => [id, s.label])) }));
  mkdirSync(join(RESULTS_DIR, "reports"), { recursive: true });
  writeFileSync(paths.report(`${model}.md`), md.join("\n") + "\n");
  writeJson(paths.report(`${model}.json`), json);
  return paths.report(`${model}.md`);
}

// Two models on the same cases: a paired comparison of "accurate" (correct or partial)
export function compare(modelA: string, modelB: string, split: string, run = 1, judge: JudgeKey = "claude"): string {
  const get = (m: string) => {
    const slug = runSlug(m, "normal", run);
    const r = readJson<RunFile>(paths.run(slug));
    if (!r) throw new Error(`No ${slug}.`);
    return scoreRun(r, readJson<JudgedFile>(paths.judged(slug, judge)));
  };
  const a = get(modelA);
  const b = get(modelB);
  let onlyA = 0, onlyB = 0, both = 0, neither = 0;
  for (const c of CASES.filter((c) => split === "all" || c.split === split)) {
    const x = a.get(c.id)?.label, y = b.get(c.id)?.label;
    if (!x || !y) continue;
    const ax = x === "correct" || x === "partial", by = y === "correct" || y === "partial";
    if (ax && by) both++;
    else if (ax) onlyA++;
    else if (by) onlyB++;
    else neither++;
  }
  const p = mcnemar(onlyA, onlyB);
  return [
    `${modelA} vs ${modelB}, ${split} cases, run ${run}:`,
    `  both accurate ${both}, only ${modelA} ${onlyA}, only ${modelB} ${onlyB}, neither ${neither}`,
    `  McNemar exact p = ${p.toFixed(3)}: ${p < 0.05 ? "a real difference at the 5% level" : "not a meaningful difference on these cases"}`,
  ].join("\n");
}

export function status(): string {
  const list = (dir: string) => {
    try {
      return readdirSync(join(RESULTS_DIR, dir));
    } catch {
      return [];
    }
  };
  const retrieval = readJson<{ cases: Record<string, unknown> }>(paths.retrieval);
  return [
    `Anthropic spend recorded: $${spentUsd().toFixed(2)}`,
    `Retrieval: ${retrieval ? Object.keys(retrieval.cases).length : 0}/${CASES.length} cases`,
    `Runs: ${list("runs").join(", ") || "none"}`,
    `Judged: ${list("judged").join(", ") || "none"}`,
  ].join("\n");
}

export { LABELS };
