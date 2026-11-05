// Tricycall Eval. Run from RAG-API/eval:  npm run eval -- <command> [options]
import "./env.js";
import { answerRun, type RunFile } from "./answer.js";
import { CASES, paths, readJson, runSlug, selectCases, spread } from "./data.js";
import { CLAUDE_JUDGE_MODEL } from "./env.js";
import { handcheck } from "./handcheck.js";
import { type JudgedFile, type JudgeKey, judgeRun } from "./judge.js";
import { ANSWER_MODELS, costUsd, isClaude, spentUsd } from "./models.js";
import { closeDb, ingestCorpus, retrieveAll } from "./rem.js";
import { compare, modelReport, status } from "./report.js";

const HELP = `
Tricycall Eval. Run from RAG-API/eval:  npm run eval -- <command> [options]

  status                         spend so far, and which runs and judgements exist
  ingest [--fresh]               upload eval/corpus to the Tricycall Eval instance (--fresh: all docs again)
  retrieve [--fresh]             rewrite follow-ups and retrieve the top 5 for every case (once, shared)
  cost --model M [--limit 10]    answer and judge a few cases normally, then estimate the full round
  answer --model M [--run 1] [--oracle] [--batch] [--split dev|held] [--limit N] [--ids a,b]
  judge --model M [--run 1] [--oracle] [--batch]   judged by Claude Opus 5.5
                                 (--judge gemini|both adds the optional Gemini judge; it uses free-tier quota)
  run --model M [--batch]        answer runs 1 and 2 and the oracle run, judge them, write the report
  handcheck [--model M] [--size N]    label a sample yourself and measure the judge against you:
                                 30 from the Gemini baseline (the gate), then 15 from one Claude model
  report --model M               write results/reports/<model>.md
  compare --a M1 --b M2 [--split held]   paired McNemar test of two models

Answer models: ${ANSWER_MODELS.join(", ")}
Claude runs are refused until the hand check shows the main judge agreeing 90% or more,
unless --skip-gate is given.
`;

function args(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else out[key] = true;
  }
  return out;
}

function needModel(a: Record<string, string | boolean>): string {
  const m = a.model;
  if (typeof m !== "string" || !ANSWER_MODELS.includes(m)) throw new Error(`--model must be one of: ${ANSWER_MODELS.join(", ")}`);
  return m;
}

// One judge, Claude Opus 5.5, unless --judge asks for the optional Gemini one (free tier quota)
const judgesOf = (a: Record<string, string | boolean>): JudgeKey[] =>
  a.judge === "gemini" ? ["gemini"] : a.judge === "both" ? ["claude", "gemini"] : ["claude"];

const BASELINE = "gemini-3.1-flash-lite";

// The hand check on the Gemini baseline must show the judge at 90% or more
function gate(model: string, skip: boolean): void {
  if (!isClaude(model) || skip) return;
  const slug = runSlug(BASELINE, "normal", 1);
  const hand = readJson<{ run: string; labels: Record<string, string> }>(paths.handcheck(slug));
  const judged = hand && readJson<JudgedFile>(paths.judged(slug, "claude"));
  const ids = hand && judged ? Object.keys(hand.labels).filter((id) => judged.verdicts[id]) : [];
  const share = ids.length ? ids.filter((id) => hand!.labels[id] === judged!.verdicts[id].label).length / ids.length : 0;
  if (ids.length < 25 || share < 0.9) {
    throw new Error(`Gate: the hand check has ${ids.length} labelled cases with ${Math.round(share * 100)}% agreement; it needs 25+ cases and 90%. Run "handcheck" first.`);
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const a = args(rest);
  const batch = a.batch === true;
  const run = a.run ? Number(a.run) : 1;
  const mode = a.oracle ? "oracle" : "normal";

  switch (command) {
    case "status":
      console.log(status());
      break;
    case "ingest":
      await ingestCorpus(a.fresh === true);
      break;
    case "retrieve":
      await retrieveAll(a.fresh === true);
      break;
    case "answer": {
      const model = needModel(a);
      gate(model, a["skip-gate"] === true);
      const ids = typeof a.ids === "string" ? a.ids.split(",") : undefined;
      await answerRun(model, mode, run, selectCases({ split: a.split as string, limit: a.limit ? Number(a.limit) : undefined, ids }), batch);
      break;
    }
    case "judge": {
      const model = needModel(a);
      for (const j of judgesOf(a)) await judgeRun(runSlug(model, mode, run), j, batch);
      break;
    }
    case "run": {
      const model = needModel(a);
      gate(model, a["skip-gate"] === true);
      for (const [m, r] of [["normal", 1], ["normal", 2], ["oracle", 1]] as const) {
        await answerRun(model, m, r, CASES, batch);
        for (const j of judgesOf(a)) await judgeRun(runSlug(model, m, r), j, batch);
      }
      console.log(`Report: ${modelReport(model)}`);
      break;
    }
    case "cost": {
      const model = needModel(a);
      const limit = a.limit ? Number(a.limit) : 10;
      const cases = spread(CASES, limit);
      const slug = `${model}__normal__rcost`;
      const before = spentUsd();
      const runFile = await answerRun(model, "normal", "cost", cases, false);
      await judgeRun(slug, "claude", false);
      const judged = readJson<JudgedFile>(paths.judged(slug, "claude"));
      const ans = Object.values((runFile as RunFile).answers);
      const n = ans.length;
      const perAnswer = ans.reduce((s, x) => s + costUsd(model, x.usage, true), 0) / n;
      const perJudge = Object.values(judged?.verdicts ?? {}).reduce((s, v) => s + costUsd(CLAUDE_JUDGE_MODEL, v.usage, true), 0) / Math.max(1, Object.keys(judged?.verdicts ?? {}).length);
      const oracleCases = CASES.filter((c) => !c.refuse && c.facts.length).length;
      const calls = CASES.length * 2 + oracleCases;
      console.log(`\nThis check spent $${(spentUsd() - before).toFixed(2)} on ${n} cases (standard prices).`);
      console.log(`With the Batch API, per case: answer $${perAnswer.toFixed(4)}, main judge $${perJudge.toFixed(4)}.`);
      console.log(`Full round for ${model} (2 normal runs + 1 oracle run = ${calls} answers, each judged): about $${(calls * (perAnswer + perJudge)).toFixed(2)} with --batch.`);
      console.log(`Recorded spend so far: $${spentUsd().toFixed(2)}. The cost-check files are ${slug}*; they are not part of any report.`);
      break;
    }
    case "handcheck":
      await handcheck(typeof a.model === "string" ? a.model : "gemini-3.1-flash-lite", a.size ? Number(a.size) : 30);
      break;
    case "report":
      console.log(`Report: ${modelReport(needModel(a))}`);
      break;
    case "compare":
      console.log(compare(String(a.a), String(a.b), typeof a.split === "string" ? a.split : "held"));
      break;
    default:
      console.log(HELP);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDb().catch(() => undefined));
