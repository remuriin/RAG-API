# Rem Eval

The test suite for Rem: a fully documented fictional product, a curated set of test cases built on
it, and a script that runs them against answer models and scores the answers. Why it is built this
way is in [RESEARCH.md](RESEARCH.md).

## Where things are

| Path | What it is |
|---|---|
| `RESEARCH.md` | the research behind the suite: failure modes, categories, scoring, decisions |
| `harness/` | the script that runs the suite (this repo) |
| `EVAL_DATA_DIR` | the test content and results, in the private repo `remuriin/rem-eval-data` |

The test content (the product's help center, the fact registry, the 150 cases and every result)
lives in a private repo. The held-out cases have to stay unseen, or a "Verified" score could be
tuned for them, and the test product itself is not meant to be published. The first test product,
Tricycall, was public here until 2026-11-05 and is now retired.

The old 8 docs in `../docs/` are not part of this suite. `scripts/ingest.ts` still reads them.

## How the suite is built

- **The product.** A fictional Philippine company with a dense help center: price and promo
  tables, tiers, areas, dated policy changes, an FAQ, and a community page.
- **Planted traps**, written like normal help pages:
  - facts split across docs
  - outdated pages superseded by a policy updates log
  - near-miss FAQ answers that give the general rule where a specific one applies
  - prompt injection in user-written content
- **150 cases in 14 categories** (RESEARCH.md section 5), split 60/40 into dev and held-out.
- **Each case** lists its key facts by id from the fact registry. The judge checks the answer
  against those facts. Retrieval is scored against the facts' sources.

## Running the suite

The harness has its own `package.json`, so changes to the eval never rebuild the app image. It
reuses Rem's own code from `src/` for chunking, embedding, search, the follow-up rewrite and the
prompts. Only the final model call changes, so every answer model reads the same passages.
Retrieval runs once per case and is shared by all models.

One-time setup, from `RAG-API` (PowerShell, with the WireGuard tunnel to the VPS up):

1. Clone the private data repo next to RAG-API: `gh repo clone remuriin/rem-eval-data ../rem-eval-data`.
   Add `EVAL_DATA_DIR=../rem-eval-data` to `.env`.
2. Create the eval instance in the database:
   `npm run dev:create-instance -- "Rem Eval" "Rem Eval"`.
   Copy the printed `INSTANCE_ID` value into `.env` as `EVAL_INSTANCE_ID=<value>`. Leave the
   existing `INSTANCE_ID` line as it is. The printed API key is not needed.
3. `cd eval`, then `npm install`.
4. `npm run eval -- ingest --fresh`:
   - clears the instance;
   - sets its product name from `product.json`;
   - uploads the corpus, pausing between docs to stay under the free Gemini tier's 100 embedding
     calls a minute.
5. `npm run eval -- retrieve --fresh`: retrieval for all 150 cases, saved in the data repo.

A round, in order:

| Step | Command (from `RAG-API/eval`) | Paid |
|---|---|---|
| 1 | `npm run eval -- cost --model claude-haiku-5-5`, then `run --model claude-haiku-5-5 --batch` | cents |
| 2 | `npm run eval -- handcheck --model claude-haiku-5-5` (you label 30 answers: the gate) | no |
| 3 | `run --model claude-sonnet-5-5 --batch`, then `claude-opus-5-5` | yes |
| 4 | `run --model gemini-3.1-flash-lite --batch` (on a day with fresh Gemini quota) | judge only |
| 5 | `npm run eval -- handcheck --size 15` (the judge on a non-Claude model) | no |
| 6 | `npm run eval -- compare --a claude-opus-5-5 --b gemini-3.1-flash-lite` | no |

- **The judge:** Claude Opus 5.5 grades every answer and is never told which model wrote it.
  `--judge both` adds a Gemini judge, but it uses free-tier quota.
- **The gate:** Sonnet, Opus and Fable runs are refused until a hand check on Haiku or the Gemini
  baseline shows the judge agreeing with you on at least 90% of 25 or more cases.
- **Spend:** every Anthropic call is recorded in `results/ledger.jsonl`. A step that would take the
  total past `EVAL_BUDGET_USD` (default 95) refuses to start. `npm run eval -- status` shows the
  spend so far.
- **Stopping and resuming:** every command can be stopped and run again. Finished answers and
  verdicts are kept, and a submitted batch is picked up again instead of being paid for twice.
- **Gemini free tier:** each Gemini call waits 4 seconds (`EVAL_GEMINI_DELAY_MS`) and times out
  after 2 minutes. If the daily cap is reached, run the same command again the next day.
- **Reports:** `results/reports/<model>.md` in the data repo gives scores per split and category
  with their intervals, the oracle ceiling, the pipeline-or-model split of failures, run-to-run
  changes, judge agreement with hand labels, and every failed case with the judge's reason.

## Rules for changing the suite

- Never show held-out cases to a model while writing or tuning prompts.
- Any edit to the corpus, the facts or the cases bumps that file's `version`, then run
  `ingest --fresh` and `retrieve --fresh`. Scores from different versions are not compared.
- A new case needs every key fact in the fact registry, pointing at a heading that exists.
