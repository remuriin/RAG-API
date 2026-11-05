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

## Rules for changing the suite

- Never show held-out cases to a model while writing or tuning prompts.
- Any edit to the corpus, the facts or the cases bumps that file's `version`. Scores from
  different versions are not compared.
- A new case needs every key fact in `facts.json`, pointing at a heading that exists.
