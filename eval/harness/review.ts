// The person's two jobs in Rem Eval (decided 2026-11-06, before any result was measured with them):
// 1. review-cases: check the answer key itself (key facts and notes), and flag cases that ask too
//    much, too little, or are wrong. A model applies a rubric well; only a person can say the
//    rubric is wrong.
// 2. audit: see the judge's label and reason on a sample of answers, and accept it or give the
//    right label. The gate passes when the judge's exact label is accepted on 90% or more of 25+
//    audited cases.
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { RunFile } from "./answer.js";
import { CASES, FACTS, type Label, paths, readJson, runSlug, spread, VERSIONS, writeJson } from "./data.js";
import { RESULTS_DIR } from "./env.js";
import type { JudgedFile } from "./judge.js";

const KEYS: Record<string, Label> = { c: "correct", p: "partial", m: "missing", i: "incorrect" };
const reviewPath = join(RESULTS_DIR, "case-review.json");
export const auditPath = (slug: string) => join(RESULTS_DIR, "audit", `${slug}.json`);

interface ReviewFile { casesVersion: string; reviews: Record<string, { verdict: "ok" | "flag"; comment?: string }> }
export interface AuditFile { run: string; casesVersion: string; items: Record<string, { judge: Label; yours: Label; agree: boolean }> }

const line = () => console.log("─".repeat(78));

export async function reviewCases(opts: { category?: string; split?: string }): Promise<void> {
  const file = readJson<ReviewFile>(reviewPath);
  const data: ReviewFile = file && file.casesVersion === VERSIONS.cases ? file : { casesVersion: VERSIONS.cases, reviews: {} };
  const todo = CASES.filter((c) => !data.reviews[c.id])
    .filter((c) => !opts.category || c.category === opts.category)
    .filter((c) => !opts.split || opts.split === "all" || c.split === opts.split);
  if (todo.length) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log(`\nCheck the answer key. Enter: OK. f: flag it (you'll type why). s: skip. q: save and quit.`);
    console.log(`Flag a case when the notes ask for more than a good answer needs, too little, or something wrong.\n`);
    for (const [i, c] of todo.entries()) {
      line();
      console.log(`${i + 1}/${todo.length}  ${c.id}  (${c.category}, ${c.split}${c.refuse ? ", should decline" : ""})`);
      if (c.history?.length) for (const t of c.history) console.log(`  ${t.role}: ${t.content}`);
      console.log(`Question: ${c.question}`);
      for (const id of c.facts) console.log(`  key fact: ${FACTS[id].text}`);
      console.log(`  notes: ${c.expect ?? "(none)"}`);
      const key = (await rl.question("\n[Enter = OK / f / s / q]: ")).trim().toLowerCase();
      if (key === "q") break;
      if (key === "s") continue;
      if (key === "f") {
        const comment = (await rl.question("Why (what should change)? ")).trim();
        data.reviews[c.id] = { verdict: "flag", comment };
      } else data.reviews[c.id] = { verdict: "ok" };
      writeJson(reviewPath, data);
    }
    rl.close();
  }
  const all = Object.entries(data.reviews);
  const flags = all.filter(([, r]) => r.verdict === "flag");
  console.log(`\n${all.length}/${CASES.length} cases reviewed, ${flags.length} flagged.`);
  for (const [id, r] of flags) console.log(`  ${id}: ${r.comment}`);
}

export async function audit(model: string, size: number): Promise<void> {
  const slug = runSlug(model, "normal", 1);
  const run = readJson<RunFile>(paths.run(slug));
  const judged = readJson<JudgedFile>(paths.judged(slug, "claude"));
  if (!run || !judged) throw new Error(`${slug} needs answers and judge verdicts first.`);
  const file = readJson<AuditFile>(auditPath(slug));
  const data: AuditFile = file && file.casesVersion === VERSIONS.cases ? file : { run: slug, casesVersion: VERSIONS.cases, items: {} };
  const sample = spread(CASES.filter((c) => judged.verdicts[c.id]), size);
  const todo = sample.filter((c) => !data.items[c.id]);

  if (todo.length) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log(`\nFor each answer, read the judge's label and reason.`);
    console.log(`Enter: you agree. c / p / m / i: the label you think is right instead. s: skip. q: save and quit.\n`);
    for (const [i, c] of todo.entries()) {
      const a = run.answers[c.id];
      const v = judged.verdicts[c.id];
      line();
      console.log(`${i + 1}/${todo.length}  ${c.id}  (${c.category}${c.refuse ? ", should decline" : ""})`);
      if (c.history?.length) for (const t of c.history) console.log(`  ${t.role}: ${t.content}`);
      console.log(`Question: ${c.question}`);
      for (const id of c.facts) console.log(`  key fact: ${FACTS[id].text}`);
      console.log(`  notes: ${c.expect ?? "(none)"}`);
      console.log(`\nAnswer:\n${a.answer}\n`);
      console.log(`Judge: ${v.label.toUpperCase()}. ${v.reasoning}`);
      let key = "x";
      while (!["", "c", "p", "m", "i", "s", "q"].includes(key)) key = (await rl.question("\n[Enter = agree / c / p / m / i / s / q]: ")).trim().toLowerCase();
      if (key === "q") break;
      if (key === "s") continue;
      const yours = key === "" ? v.label : KEYS[key];
      data.items[c.id] = { judge: v.label, yours, agree: yours === v.label };
      writeJson(auditPath(slug), data);
    }
    rl.close();
  }

  const items = Object.entries(data.items);
  const agree = items.filter(([, x]) => x.agree).length;
  const share = agree / Math.max(1, items.length);
  console.log(`\n${items.length} audited for ${slug}: the judge's exact label accepted on ${agree}/${items.length} (${Math.round(share * 100)}%).`);
  console.log(items.length >= 25 && share >= 0.9 ? "Gate passed." : "Gate not passed (needs 25+ audited and 90%).");
  for (const [id, x] of items.filter(([, x]) => !x.agree)) console.log(`  ${id}: judge ${x.judge}, you ${x.yours}`);
}
