# Tricycall Eval

The test suite for Rem: a fully documented fictional product (Tricycall), a curated set of test
cases built on it, and (in phase 3) a script that runs them against answer models and scores the
answers. Why it is built this way is in [RESEARCH.md](RESEARCH.md).

## What is here

| Path | What it is |
|---|---|
| `RESEARCH.md` | the research behind the suite: failure modes, categories, scoring, decisions |
| `corpus/*.md` | the Tricycall help center: 21 docs, uploaded to the Tricycall Eval service |
| `facts.json` | every fact a case relies on, with the doc and heading that state it |
| `cases.json` | 150 test cases in 14 categories, split 88 dev / 62 held-out |
| `results/` | one file per run (phase 3) |

The old 8 docs in `../docs/` are not part of this suite. `scripts/ingest.ts` still reads them.

## The corpus

The help center is current as of **October 1, 2026**. Planted on purpose, written like normal
help pages:

- **Facts split across docs**, linked by shared names: Tricycall Plus, the TODA terminals, the
  night hours, the two service areas, the student discount.
- **Outdated pages.** The policy updates log supersedes three things: the cancellation fee
  (₱20 to ₱25), the San Roque per-km rate (₱12 to ₱13) and the TAGULAN25 promo, which ended.
- **Near-miss answers in the FAQ.** It gives the general rule where a specific one applies: 3
  minutes of free waiting (Plus members get 5), "yes" to cash (not for scheduled rides), "book 7
  days ahead" (Santa Lucia only), and a promo that has ended.
- **Tables** for fares, surcharges, terminals, tiers and refund timing.
- **Prompt injection.** `community-tips.md` holds three planted instructions, at the start,
  middle and end of the page. Each one is detectable: the word `KALABAW-42`, a false "cash rides
  are free on Sundays" claim, and a request to print the system rules.

Every section is longer than 120 characters, so the chunker never folds one into its neighbour.
That keeps each heading findable.

## A case

```json
{ "id": "numeric-03", "category": "numeric", "split": "dev",
  "question": "A student takes a 3 km Standard ride in Santa Lucia at 11 PM. What's the fare?",
  "facts": ["fare-min-sl", "fare-km-sl", "fare-disc-student", "sur-night", "sur-order"],
  "refuse": false, "tags": ["numeric"],
  "expect": "(₱40 + 2 × ₱15) = ₱70, less 20% = ₱56, plus the ₱10 night surcharge = ₱66" }
```

- `facts` are ids in `facts.json`. The judges check the answer against their text.
- Retrieval is scored against the sources of those facts, unless the case lists its own
  `sources`.
- `expect` tells the judges what a correct answer does, where the facts alone don't say it.
- All the fields are described at the top of `cases.json`.

## Running the suite

The harness is in `harness/`. It has its own `package.json`, so changes to the eval never
rebuild the app image. It reuses Rem's own code from `src/` for chunking, embedding, search,
the follow-up rewrite and the prompts. Only the final model call changes, and every answer model
reads the same passages. Retrieval runs once per case and is shared by all models.

One-time setup, from `RAG-API` (PowerShell, with the WireGuard tunnel to the VPS up):

1. Create the eval instance in the database:
   `npm run dev:create-instance -- "Tricycall Eval" "Tricycall"`.
   Copy the printed `INSTANCE_ID` value into `.env` as `EVAL_INSTANCE_ID=<value>`. Leave the
   existing `INSTANCE_ID` line as it is. The printed API key is not needed.
2. `cd eval`, then `npm install`.
3. `npm run eval -- ingest`: uploads the 21 docs (about 134 Gemini embedding calls).
4. `npm run eval -- retrieve`: retrieval for all 150 cases, saved to `results/retrieval.json`.

The first round, in order:

| Step | Command (from `RAG-API/eval`) | Paid |
|---|---|---|
| 1 | `npm run eval -- cost --model gemini-3.1-flash-lite` | judge only, about $1 |
| 2 | `npm run eval -- run --model gemini-3.1-flash-lite --batch` | judge only |
| 3 | `npm run eval -- handcheck` (you label 30 answers) | no |
| 4 | `npm run eval -- cost --model claude-haiku-5-5`, then `run --model claude-haiku-5-5 --batch` | yes |
| 5 | the same for `claude-sonnet-5-5`, then `claude-opus-5-5` | yes |
| 6 | `npm run eval -- compare --a claude-opus-5-5 --b gemini-3.1-flash-lite` | no |

- **The gate:** Claude runs are refused until the hand check (step 3) shows the main judge agreeing
  with you on at least 90% of 25 or more cases.
- **Spend:** every Anthropic call is recorded in `results/ledger.jsonl`. A step that would take the
  total past `EVAL_BUDGET_USD` (default 95) refuses to start. `npm run eval -- status` shows the
  spend so far.
- **Stopping and resuming:** every command can be stopped and run again. Finished answers and
  verdicts are kept, and a submitted batch is picked up again instead of being paid for twice.
- **Gemini free tier:** each Gemini call waits 4 seconds (`EVAL_GEMINI_DELAY_MS`). If the daily
  cap is reached, run the same command again the next day.
- **Results:** `results/reports/<model>.md` gives scores per split and category with their
  intervals, the oracle ceiling, the pipeline-or-model split of failures, run-to-run changes,
  judge agreement, and every failed case with the judge's reason.

## Rules for changing the suite

- Never show held-out cases to a model while writing or tuning prompts.
- Any edit to the corpus, the facts or the cases bumps that file's `version`. Scores from
  different versions are not compared.
- A new case needs every key fact in `facts.json`, pointing at a heading that exists.
