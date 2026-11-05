// A person labels a sample of judged answers, blind to the judges' labels, and the judges are
// measured against those labels. No Claude run should start before the main judge reaches 90%.
import { createInterface } from "node:readline/promises";
import type { RunFile } from "./answer.js";
import { CASES, FACTS, type Label, paths, readJson, runSlug, spread, writeJson } from "./data.js";
import type { JudgedFile } from "./judge.js";
import { kappa } from "./report.js";

interface HandFile { run: string; labels: Record<string, Label> }
const KEYS: Record<string, Label> = { c: "correct", p: "partial", m: "missing", i: "incorrect" };

export async function handcheck(model: string, size: number): Promise<void> {
  const slug = runSlug(model, "normal", 1);
  const run = readJson<RunFile>(paths.run(slug));
  if (!run) throw new Error(`No ${slug} yet.`);
  const file = readJson<HandFile>(paths.handcheck) ?? { run: slug, labels: {} };
  if (file.run !== slug) throw new Error(`handcheck.json holds labels for ${file.run}. Move it aside to start a new sample.`);
  const sample = spread(CASES.filter((c) => run.answers[c.id] && !run.answers[c.id].error), size);
  const todo = sample.filter((c) => !file.labels[c.id]);

  if (todo.length) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log(`\nLabel each answer yourself: c correct, p partial, m missing, i incorrect, s skip, q quit and save.`);
    console.log(`Rules: RESEARCH.md section 6.3. The judges' labels stay hidden until you finish.\n`);
    for (const [i, c] of todo.entries()) {
      const a = run.answers[c.id];
      console.log("─".repeat(78));
      console.log(`${i + 1}/${todo.length}  ${c.id}  (${c.category}${c.refuse ? ", should decline" : ""})`);
      if (c.history?.length) for (const t of c.history) console.log(`  ${t.role}: ${t.content}`);
      console.log(`Question: ${c.question}`);
      if (c.facts.length) for (const id of c.facts) console.log(`  key fact: ${FACTS[id].text}`);
      if (c.expect) console.log(`  notes: ${c.expect}`);
      console.log(`Passages given: ${a.passages.map((p) => `${p.source} > ${p.headingPath.split(" > ").pop()}`).join("; ") || "none (no-match path)"}`);
      console.log(`\nAnswer:\n${a.answer}\n`);
      let key = "";
      while (!["c", "p", "m", "i", "s", "q"].includes(key)) key = (await rl.question("Label [c/p/m/i/s/q]: ")).trim().toLowerCase();
      if (key === "q") break;
      if (key !== "s") {
        file.labels[c.id] = KEYS[key];
        writeJson(paths.handcheck, file);
      }
    }
    rl.close();
  }

  const ids = Object.keys(file.labels);
  console.log(`\n${ids.length} hand labels for ${slug}.`);
  for (const judge of ["claude", "gemini"] as const) {
    const j = readJson<JudgedFile>(paths.judged(slug, judge));
    if (!j) continue;
    const both = ids.filter((id) => j.verdicts[id]);
    const human = both.map((id) => file.labels[id]);
    const machine = both.map((id) => j.verdicts[id].label);
    const agree = human.filter((x, i) => x === machine[i]).length;
    const share = agree / Math.max(1, both.length);
    console.log(`${judge} judge (${j.model}): agrees on ${agree}/${both.length} (${Math.round(share * 100)}%), kappa ${kappa(human, machine).toFixed(2)}${judge === "claude" ? (share >= 0.9 ? ". Gate passed." : ". Gate NOT passed: fix the judge prompt before any Claude run.") : ""}`);
    const off = both.filter((id) => file.labels[id] !== j.verdicts[id].label);
    for (const id of off) console.log(`  ${id}: you ${file.labels[id]}, judge ${j.verdicts[id].label}: ${j.verdicts[id].reasoning.slice(0, 160)}`);
  }
}
