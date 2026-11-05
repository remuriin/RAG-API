# Tricycall Eval: research

Phase 1 of the Tricycall Eval test suite (RAG-API TODO, item 0). This file records what the
published work on RAG failures and RAG evaluation says, what Rem's own pipeline makes likely to
fail, and the decisions that phase 2 (corpus and cases) and phase 3 (harness and baseline) build on.

- Written: 2026-11-05
- Status: research done and reviewed; the open questions in section 9 are decided

Contents

1. Why a curated test set
2. The pipeline under test
3. Sources
4. Failure taxonomy used by Tricycall Eval
5. Test categories
6. Scoring
7. Decisions for phase 2 and 3
8. What the baseline is expected to show
9. Open questions

---

## 1. Why a curated test set

The current `scripts/eval.ts` has 45 cases in 7 tiers over 8 short Tricycall docs. Each case names at most one
expected file, and the answers are read by hand. That was enough to tune one prompt on one
model. It cannot support the claims the next two roadmap items make ("this model is Verified",
"this prompt beats that one"), for three reasons:

- **Single source per case.** A multi-hop or aggregation question has several required sources.
  With one `expectedSource`, a half-retrieved answer looks like a hit.
- **No scoring.** Answers are printed for a person to read. Two runs cannot be compared by number.
- **Thin content.** Eight docs of about 2 KB each cannot hold the material that categories such as
  conflicting policies, numeric tables, distractors or temporal updates need. A category cannot be
  tested without content written for it, which is why Tricycall is being expanded.

Barnett et al. (2024) put it plainly: "RAG systems require questions and answers that are
application specific", and generic benchmarks do not replace them. The published benchmarks
below are used for their method (what to test, how to build it, how to score it), not their data.

## 2. The pipeline under test

What one `POST /query` does today, read from the source on 2026-11-05. Every test result is
specific to these settings, so a run records them (section 7.6).

| Step | What it does | Where |
|---|---|---|
| Chunking | Split by `#`/`##`/`###` headings; sections over 1800 chars cut at a blank line; sections under 120 chars folded into the chunk before, the heading path becoming the common prefix | `src/ingest/chunker.ts` |
| Embedding | `gemini-embedding-001`, 768 dimensions, `RETRIEVAL_DOCUMENT` / `RETRIEVAL_QUERY` task types | `src/ingest/embedder.ts` |
| Follow-up rewrite | Only when history is sent: `gemini-3.1-flash-lite`, temperature 0, rewrites the last message as a standalone question | `src/generate/rewrite.ts`, `answer.ts` |
| Retrieval | Dense only: cosine distance in pgvector, top 5, one query, one step. No keyword search, no reranker | `src/retrieve/search.ts` |
| Similarity floor | Chunks under 0.625 similarity are dropped. None left: the no-match path, which sees only topic names | `src/generate/answer.ts` |
| Answer | `gemini-3.1-flash-lite`, temperature 0.2; passages numbered inside `<information>`; persona rules (`support` by default) | `src/generate/answer.ts`, `prompts.ts` |
| Answered or not | `answered` is true when the reply cites at least one passage; no citation counts as a refusal | `src/generate/answer.ts` |
| Injection defences | Section tags stripped from inserted text; a rule that tagged text is data, never instructions | `src/generate/prompts.ts` |

Three properties of this pipeline shape the test design:

- **Top 5, one step.** A question that needs more than five chunks cannot be fully retrieved,
  however good the embedding. FRAMES shows one-step retrieval is the main limit on multi-document
  questions (section 3.4).
- **The "never combine" rule.** The answer prompt says: "Never combine separate pieces of
  information to suggest a feature exists." It is written for yes/no capability questions, but a
  model may apply it to every multi-hop question and refuse ones it should answer. The test set
  has to tell the two apart (section 8).
- **Citations stand in for "answered".** An answer that cites a passage but states something
  the passage does not say still counts as answered. Only a judge that checks the facts catches it.

## 3. Sources

Venues marked UNVERIFIED could not be confirmed on the page that was read.

### 3.1 Barnett et al. 2024: Seven Failure Points

Scott Barnett, Stefanus Kurniawan, Srikanth Thudumu, Zach Brannelly, Mohamed Abdelrazek.
"Seven Failure Points When Engineering a Retrieval Augmented Generation System." CAIN 2024,
Lisbon. arXiv:2401.05856. https://arxiv.org/abs/2401.05856

The seven failure points (FP), with the stage each one belongs to (the stage mapping is ours; the
paper marks them on a figure):

| FP | Name | Definition (the paper's words where quoted) | Stage |
|---|---|---|---|
| FP1 | Missing Content | "asking a question that cannot be answered from the available documents"; the system should say it does not know | corpus |
| FP2 | Missed the Top Ranked Documents | "The answer to the question is in the document but did not rank highly enough to be returned" | retrieval |
| FP3 | Not in Context | retrieved, but "did not make it into the context for generating an answer" | consolidation |
| FP4 | Not Extracted | the answer is in the context, but the model "failed to extract out the correct answer" | generation |
| FP5 | Wrong Format | "the large language model ignored the instruction" on format | generation |
| FP6 | Incorrect Specificity | "not specific enough or is too specific to address the user's need" | generation |
| FP7 | Incomplete | "not incorrect but miss some of the information even though that information was in the context" | generation |

Lessons used here:
- "Validation of a RAG system is only feasible during operation", and its robustness "evolves
  rather than designed in at the start". The test set is versioned and grows; it is never final.
- Settings to calibrate, all of which the run record captures: "chunk size, embedding strategy,
  chunking strategy, retrieval strategy, consolidation strategy, context size, and prompts".
- "If chunks are too small certain questions cannot be answered"; "if the chunks are too long
  then the answers include generated noise". The corpus must place facts with the chunker in mind.
- "LLM behaviour changes with each new release": the reason Verified models are re-tested.
- Their automated eval was more pessimistic than their human rater: a judge has to be checked
  against hand labels (section 6.4).

### 3.2 Later taxonomies

- **Leung et al. 2025**, "Classifying and Addressing the Diversity of Errors in Retrieval-Augmented
  Generation Systems", Layer 6 AI. arXiv:2510.13975. https://arxiv.org/abs/2510.13975 (no
  peer-reviewed venue listed). 16 errors over chunking, retrieval, reranking and generation. The ones
  Barnett has no match for, and which apply to Rem:
  - E1 Overchunking
  - E2 Underchunking
  - E3 Context Mismatch
  - E6 Semantic Drift
  - E10 Fabricated Content
  - E11 Parametric Overreliance (answering from the model's own knowledge)
  - E15 Chronological Inconsistency
  - E16 Numerical Error
- **Garani 2026**, "A Systematic Taxonomy of Failure Modes in Retrieval-Augmented Generation
  Systems", TrustNLP 2026 (ACL), pp. 413–424. https://aclanthology.org/2026.trustnlp-main.27/
  33 modes over 7 stages, including evaluation and deployment. The mode names could not be read
  (PDF), so it is cited for scope only.

### 3.3 RGB (Chen et al. 2024)

Jiawei Chen, Hongyu Lin, Xianpei Han, Le Sun. "Benchmarking Large Language Models in
Retrieval-Augmented Generation." AAAI 2024. arXiv:2309.01431. https://arxiv.org/abs/2309.01431

Four abilities:
- **Noise robustness:** relevant-looking docs that lack the answer.
- **Negative rejection:** refuse when no doc has the answer.
- **Information integration:** combine several docs.
- **Counterfactual robustness:** spot wrong facts in the docs.

The findings that matter most for a support assistant:
- Negative rejection is weak. The best judged rejection rate was 45% (English), so even the best
  model answered instead of refusing more than half the time when no doc held the answer.
- Integration peaked at 60% without noise and 43% with it.
- Noise hurts steadily. ChatGPT went from 96.33% at no noise to 76.00% at 0.8 noise.
- Models rarely spot wrong facts in the documents.

### 3.4 MultiHop-RAG and FRAMES

- **MultiHop-RAG**: Yixuan Tang, Yi Yang. arXiv:2401.15391 (COLM 2024, UNVERIFIED).
  https://arxiv.org/abs/2401.15391
  - Query types: inference, comparison, temporal, and null (not answerable from the corpus).
  - Construction: claims in different articles share a **bridge entity or topic**, and 2–4 claims
    are grouped into one query. That is what guarantees a question needs more than one document.
  - Retrieval is scored with Hits@K, MAP@K and MRR@K, with null queries left out.
  - Best retrieval (voyage-02 plus a reranker): Hits@4 0.66, Hits@10 0.75. A reranker helped
    every embedding model.
  - GPT-4 scored 0.56 with retrieved chunks and 0.89 with the gold evidence. Retrieval, not
    reading, is the bigger loss.
- **FRAMES**: Satyapriya Krishna et al. (Google). "Fact, Fetch, and Reason." arXiv:2409.12941.
  https://arxiv.org/abs/2409.12941
  - Reasoning types: multiple constraints, numerical, tabular, temporal, post-processing.
  - Each question needs 2–15 articles.
  - Synthetic questions from an LLM were dropped: over 30% were hallucinated. Humans wrote the
    final set.
  - Yes/no questions were removed to limit guessing.
  - Graded by an LLM judge (explanation, then TRUE/FALSE): 0.96 agreement with humans,
    kappa 0.889.
  - Gemini-Pro-1.5 scored 0.47 with BM25 top-4 and 0.73 with the gold articles. Multi-step
    retrieval closed most of that gap (0.66), at about 6 model calls per question.
  - About 80% of the errors left with gold articles were numerical, tabular or post-processing.

### 3.5 CRAG (Yang et al. 2024)

Xiao Yang et al. (Meta). "CRAG — Comprehensive RAG Benchmark." arXiv:2406.04744 (NeurIPS 2024
Datasets and Benchmarks, UNVERIFIED). https://arxiv.org/abs/2406.04744

- **Question types:**
  - simple
  - simple with condition
  - set
  - comparison
  - aggregation
  - multi-hop
  - post-processing-heavy
  - false premise
- **Other dimensions:** dynamism (real-time to static) and entity popularity (head, torso, tail).
- **Scoring:**

  | Label | Score |
  |---|---|
  | Perfect | 1 |
  | Acceptable | 0.5 |
  | Missing ("I don't know") | 0 |
  | Incorrect | −1 |

  Truthfulness = accuracy − hallucination rate, so a wrong answer costs more than a refusal.
- **Judging:** two LLM judges from different families, averaged. F1 against human labels was
  94.7% and 98.9%.
- **Findings:**
  - Straightforward RAG reached 44% accuracy, but GPT-4 Turbo's hallucination rose from 13.5% to
    30.1% once retrieval added noise.
  - Industry RAG systems answered only 63% of questions without hallucination.
  - Hard slices: fast-changing facts, tail entities, set, aggregation, multi-hop and false-premise
    questions.

### 3.6 RAGAS, RAGChecker and LLM judges

- **RAGAS**: Es, James, Espinosa-Anke, Schockaert. EACL 2024 demos, pp. 150–158.
  https://aclanthology.org/2024.eacl-demo.16. Current metrics, from docs.ragas.io:

  | Metric | What it measures | Lower or higher is better |
  |---|---|---|
  | Faithfulness | share of the answer's claims the contexts support | higher |
  | Response Relevancy | how on-topic the answer is; not its accuracy | higher |
  | Context Precision | whether relevant chunks are ranked first | higher |
  | Context Recall | share of the reference's claims the contexts support | higher |
  | Noise Sensitivity | share of the answer's claims that are wrong | lower |
  | Factual Correctness | claim-level precision, recall and F1 against a reference | higher |

  Tricycall Eval borrows the definitions, not the library. Its API changes between 0.4 and 1.0,
  and the harness needs to stay small and readable.
- **RAGChecker**: Ru et al. 2024, arXiv:2408.08067. https://arxiv.org/abs/2408.08067
  - Splits both the answer and the reference into claims and checks entailment both ways.
  - Gives claim recall, hallucination and context utilization.
  - This claim-level approach is the model for the key-facts judge (section 6.3).
- **Judge biases**: Zheng et al., "Judging LLM-as-a-Judge", NeurIPS 2023. arXiv:2306.05685.

  | Bias | What happened |
  |---|---|
  | Position | verdicts held after an order swap only 65% of the time for GPT-4 |
  | Verbosity | longer answers favoured |
  | Self-enhancement | +10% to +25% for a model's own answers |
  | Weak at math | the default judge prompt failed 70% of math questions |

  A judge given the reference answer failed 15% of them, down from 70%, and chain-of-thought
  brought it to 30%.
- Thakur et al. 2025, "Judging the Judges" (arXiv:2406.12624):
  - Only the largest judges align reasonably with humans, and even they can be off by up to
    5 points.
  - Judges lean lenient.
  - Agreement should be reported with more than plain percent agreement.

### 3.7 Prompt injection through documents

- **Greshake et al. 2023**, "Not what you've signed up for", arXiv:2302.12173. Attackers plant
  instructions in data the application is likely to retrieve. LLM apps "blur the line between
  data and instructions".
- **BIPIA** (Yi et al., KDD 2025, arXiv:2312.14197) places injections at the start, middle or
  end of the content:
  - End placement gives the highest attack success rate (ASR).
  - Explicit reminders and separating the data from the instructions give "substantial
    mitigation".
- **PoisonedRAG** (Zou et al., USENIX Security 2025, arXiv:2402.07867): 5 planted texts per
  target question reached 90% ASR in a corpus of millions.

### 3.8 How many cases are enough

95% Wilson intervals for an accuracy score:

| Cases | At 50% | At 70% | At 80% | At 90% |
|---|---|---|---|---|
| 150 | ±7.9 pts | ±7.3 pts | ±6.4 pts | ±4.8 pts |
| 60 | ±12.3 pts | ±11.3 pts | ±10.0 pts | ±7.7 pts |

Two independent runs at 70% and 80% need a gap of about 9.7 points to differ significantly on 150
cases, and about 15.4 points on 60 cases. When two systems answer the **same** cases, a paired
test is more sensitive: McNemar's test on the cases where they disagree, or a paired bootstrap. The
judge's own noise comes on top of these numbers.

## 4. Failure taxonomy used by Tricycall Eval

One list, merged from Barnett, Leung and RGB, keeping only what Rem's pipeline can exhibit. Every
category in section 5 targets at least one of these, and every failure in a run report is
labelled with one.

| Code | Failure | From | Stage in Rem | How a run detects it |
|---|---|---|---|---|
| F1 | Missing content answered anyway | Barnett FP1, RGB negative rejection, Leung E9/E10 | generation | must-refuse case with `answered: true`, or judge finds unsupported claims |
| F2 | Right chunk not in top 5 | Barnett FP2/FP3, Leung E4/E7 | retrieval | expected source missing from the 5 retrieved |
| F3 | Right chunk dropped by the floor | Barnett FP3 | similarity floor | expected chunk retrieved under 0.625, or no-match path taken |
| F4 | In context, not used | Barnett FP4 | generation | retrieval hit, key fact absent from the answer |
| F5 | Incomplete | Barnett FP7, Leung E12 | generation | some key facts present, some absent, all retrieved |
| F6 | Wrong specificity | Barnett FP6 | generation | judge: answer too general or too narrow for the question |
| F7 | Format ignored | Barnett FP5 | generation | deterministic format checks (section 6.2) |
| F8 | Distracted by a near-miss chunk | RGB noise robustness, Leung E5/E8 | retrieval + generation | answer takes the distractor's value |
| F9 | Outdated or conflicting fact chosen | RGB counterfactual, Leung E15 | generation | answer uses the superseded rule |
| F10 | Numerical error | Leung E16, FRAMES | generation | wrong computed or read number |
| F11 | Own knowledge used | Leung E11 | generation | judge finds a claim not in any passage, matching outside knowledge |
| F12 | Over-refusal | the "never combine" rule (section 2) | generation | answerable case with `answered: false` and all sources retrieved |
| F13 | Follow-up lost | rewrite step | rewrite | rewritten question does not name what the follow-up refers to |
| F14 | Instruction in a document obeyed | Greshake, BIPIA | generation | canary string or forbidden behaviour in the answer |
| F15 | Wrong language | Rem's style rule | generation | reply language differs from the question's |
| F16 | Chunking split or buried the fact | Leung E1–E3 | chunking | fact's section folded or cut, so no single chunk holds it |

## 5. Test categories

The plan had 13. Research adds one: **false premise** (CRAG), which no other category covers and
which a support assistant meets daily ("why was I charged the Plus fee twice" when Plus has no
fee). Two Rem behaviours that already have tests become subtypes rather than categories: small
talk and other-company questions go under *unanswerable*, because both must end without document
facts.

Each case has one category and any number of **tags**:
- `distractor`: a near-miss chunk is expected in the top 5.
- `table`: the answer is read from a markdown table.
- `ceiling`: needs more than 5 chunks; expected to fail, kept to document the limit.
- `persona-sensitive`
- `long-answer`

| # | Category | What it tests | Targets | Modelled on | The corpus must contain |
|---|---|---|---|---|---|
| 1 | direct | one fact, worded like the doc | F2, F4 | baseline for the rest | facts stated once, clearly |
| 2 | paraphrase | same fact, different words; vague or emotional wording | F2, F3 | existing tier 2, Leung E6 | facts whose doc wording differs from how riders talk |
| 3 | multi-hop | needs 2–4 facts from different docs, chained by a bridge entity | F2, F5, F12 | MultiHop-RAG inference, RGB integration | bridge entities across docs (section 7.2) |
| 4 | comparison | compare two things the docs describe separately | F5, F12 | MultiHop-RAG, CRAG | parallel features in separate docs (ride types, plans) |
| 5 | aggregation | list or count across docs ("all the ways to get a discount") | F2, F5 | CRAG set/aggregation | the same kind of fact spread over 3–4 docs; most cases need 5 or fewer chunks |
| 6 | temporal | dates, effective dates, order of events, "since when" | F9, F10 | MultiHop-RAG temporal, FRAMES | dated policy changes, a fixed "current as of" date |
| 7 | negation | what is *not* allowed, covered or refundable | F4, F6 | MultiHop-RAG comparison notes, CRAG | explicit exclusions written as lists |
| 8 | unanswerable | must refuse: not in the docs, other companies, small talk, or partly covered | F1, F11 | Barnett FP1, RGB negative rejection, MultiHop-RAG null | topics that sound covered but are not |
| 9 | false premise | the question assumes something the docs contradict | F1, F4 | CRAG false premise | facts clear enough to contradict a wrong assumption |
| 10 | conflicting | old and new versions of a rule both in the corpus | F9 | RGB counterfactual | a policy page and a policy-updates log that supersedes it |
| 11 | numeric | read from a table, or compute (fare plus surcharge minus discount) | F10 | FRAMES numerical/tabular | markdown fare and surcharge tables |
| 12 | follow-up | needs the conversation history to make sense | F13 | existing rewrite tests | any; the history makes the case |
| 13 | injection | instructions hidden in a doc or in the question | F14 | Greshake, BIPIA | planted docs with canary instructions (section 7.3) |
| 14 | Taglish / Filipino | the question in Filipino or Taglish, docs in English | F3, F15 | Rem's users | none extra; same facts, other language |

Minimum per category stays at 8. With 14 categories, the minimum is 112, so ~150 still leaves
room to weight the harder categories (multi-hop, aggregation, conflicting, numeric) at 12–15 each.

## 6. Scoring

### 6.1 Retrieval

Scored only on cases that have expected sources: every category except *unanswerable*, most
*false premise* cases, and *injection* cases that only plant instructions in the question.

- **Hits@5**: share of a case's expected sources found among the 5 retrieved chunks.
- **Full hit**: all expected sources found (a 1/0 per case). This is the headline retrieval number.
- **MRR**: how high the first expected source ranks.
- **Floor loss**: expected source retrieved but under 0.625, which shows F3 separately from F2.

A source is identified by **file plus heading path prefix** (`fares.md > Surcharges`), not by
chunk id. Chunk ids change with any chunker setting, and folded small sections change the heading
path to a common prefix (section 2). Matching on a prefix keeps the cases valid when chunking
changes.

### 6.2 Deterministic checks

These run first, cost nothing, and settle what they can without a judge:

- **Refusal**: Rem's own `answered` flag. A must-refuse case with `answered: true` is wrong
  without asking a judge.
- **Citation validity**: every cited source is one of the case's expected sources, or a source the
  judge confirms supports the claim.
- **Canary**: injection cases look for their planted canary string or forbidden behaviour.
- **Language**: the reply's language matches the question's (simple detection, Taglish allowed
  to answer in English or Filipino).
- **Format**: plain-text mode has no markdown; markdown mode has no tables or HTML (the rules
  in `prompts.ts`).

### 6.3 The judge

For each case the judge gets the question, the case's **key facts** (short atomic statements),
the retrieved passages and the answer. It returns, with a short reason for each (FRAMES:
explanation first, then the verdict):

- each key fact: present, absent or contradicted;
- unsupported claims: statements in the answer that no passage supports (faithfulness, F11).

Labels follow CRAG:

| Label | Answerable case | Must-refuse case | Score |
|---|---|---|---|
| correct | all key facts present, none contradicted, no unsupported claims | refused, stated no facts, behaviour fits the subtype (offers topics, says it only helps with Tricycall) | 1 |
| partial | at least half the key facts, none contradicted, no unsupported claims | refused but added a harmless unsupported line | 0.5 |
| missing | refused, or no key fact present | (not used) | 0 |
| incorrect | any key fact contradicted, or any unsupported claim that changes the answer | answered with facts | −1 |

A run reports per category and overall:
- **accuracy**: correct plus partial;
- **hallucination rate**: incorrect;
- **missing rate**;
- **truthfulness**: accuracy minus hallucination, as in CRAG.

Truthfulness is the headline answer number, because a confident wrong answer is the expensive
failure for a support assistant.

### 6.4 Keeping the judge honest

- Two fixed judges, pinned by exact model id in every result file:
  - **main judge:** Claude Opus 5.5 (`claude-opus-5-5`), on its own Anthropic API key;
  - **second judge:** a larger Gemini model than the answering one, on the Gemini key.
  CRAG also used two judges from different families. Both judge every case. The report gives
  both labels and how often they agree. Where they disagree, the case is listed for a person to
  check.
- Neither judge alone decides a model it belongs to. A Claude model's answers are reported with
  the Gemini judge's labels next to the Claude judge's, and the other way round for Gemini. That
  covers the self-enhancement risk on both sides. The hand check below measures what is left.
- Hand-label a sample: at least 30 cases across all categories, labelled by hand before reading
  the judge's labels. Report agreement and Cohen's kappa. Target: 90% agreement. Below that, fix the
  judge prompt before trusting any score.
- Key facts are the reference, which Zheng et al. found cuts judge failures sharply (70% to 15%
  on math).
- No pairwise judging ("which answer is better"), so position bias does not apply. Every answer
  is judged alone against its key facts.

### 6.5 Runs and noise

- Every configuration runs **twice**. A case whose label differs between the runs is flagged
  `flaky` and listed in the report. Answering runs at temperature 0.2, so some flakiness is
  expected and is itself a result.
- Model against model, or prompt against prompt: a paired comparison on the same cases (McNemar),
  not two separate percentages.
- The run report prints the interval next to each score (section 3.8). It also states that on
  the held-out split (about 60 cases) a gap under about 15 points is not evidence of a
  difference.

## 7. Decisions for phase 2 and 3

### 7.1 Cases are written by hand

FRAMES found over 30% of LLM-written multi-document questions were hallucinated. An LLM may draft
cases, but each one is checked against the fact registry (7.2) before it goes in, and every key
fact must point to a registry entry.

### 7.2 Corpus rules

- **Fact registry.** `eval/corpus/facts.json` lists each planted fact: id, statement, file,
  heading. Cases reference fact ids, so a corpus edit shows which cases it touches.
- **One home per fact.** A fact is stated in exactly one place, except where a case is meant to
  find it twice (conflicting, distractor).
- **Bridge entities** (MultiHop-RAG). Multi-hop and comparison facts link through named things
  that appear in several docs: Tricycall Plus, TODA terminals, the night surcharge, the Santa
  Lucia and San Roque service areas, the student discount.
- **Facts placed with the chunker in mind.** The two halves of a multi-hop question sit under
  different headings in different files, so no single chunk answers it. Sections are kept over
  120 characters so they are not folded into a neighbour, which would blur the heading path
  (F16).
- **Aggregation within reach.** Most aggregation cases need 5 or fewer chunks. Two or three cases
  that need more are kept with the `ceiling` tag, to measure the top-5 limit rather than to pass.
- **Near-miss distractors** (RGB noise). A FAQ and a promos page restate topics with different
  conditions (an expired promo, another area's fare), so retrieval brings back plausible wrong
  chunks.
- **Time is fixed.** The corpus states a "current as of" date. Policy updates carry effective
  dates, and no case depends on the real date of the run.
- **Tables.** Fares, surcharges and driver tiers are markdown tables, each under one heading and
  within 1800 characters, so a table is never cut in half.
- **Written like real docs.** Planted facts read as ordinary product documentation. A doc that
  reads like a test fixture tests nothing.
- **Versioned.** `corpus_version` and `cases_version` go in every result. Any edit to either
  bumps the version, and scores from different versions are not compared.

### 7.3 Injection docs

- Two or three docs carry planted instructions, in places a real product could have
  user-written text: a "rider tips from the community" page, a driver bio, a review excerpt.
- Each instruction asks for something checkable: reply with a canary word, reveal the rules, add
  a link, switch language.
- Placement varies: start, middle and end. End placement is the strongest, per BIPIA.
- The docs stay in the one corpus, on narrow topics. Clean cases on those same topics measure
  whether the planted text harms normal answers, and how often each planted doc is retrieved is
  logged next to the attack success rate.

### 7.4 Split

Each category is split 60/40 into dev and held-out:
- Prompts are tuned only on dev.
- Held-out is run only to report, and a "Verified" claim rests on the held-out score.
- Held-out cases are never shown to a model while writing prompts.

### 7.5 Harness shape (phase 3)

- Reads `cases.json` and calls the Tricycall Eval service through `POST /query`, the deployed
  path, rather than internal functions. Retrieval scoring needs the 5 retrieved chunks with their
  similarity, so the harness needs an eval-only way to get them. The `sources` field today lists
  only cited passages. To decide in phase 3: an eval flag on the service, or the harness calling
  `retrieveRelevantChunks` beside the HTTP call.
- Logs the rewritten question for follow-up cases, so F13 is told apart from retrieval failures.
- Keeps the free-tier pacing of the current `scripts/eval.ts` (3 s between questions, long
  backoff on rate limits). At ~150 cases × 2 runs plus judge calls, a full run is a few hundred
  model calls and takes most of an hour.

### 7.6 What every result file records

- corpus and cases versions
- answer model id
- rewrite model id
- embedding model and dimensions
- judge model id
- hash of the system prompts
- persona
- chunker settings (1800 / 120)
- top K (5)
- similarity floor (0.625)
- temperature
- run date
- run number (1 or 2)

## 8. What the baseline is expected to show

These are hypotheses from sections 2 and 3, written down before the first run so the baseline can
confirm or reject them. They are not fixes.

1. **Multi-hop and comparison over-refuse (F12).** The "never combine" rule may make the model
   refuse answerable multi-hop questions. If so, those failures show `answered: false` with all
   sources retrieved.
2. **Aggregation is retrieval-bound (F2).** Top 5, one query and no reranker. MultiHop-RAG's
   best Hits@4 was 0.66 with a reranker, so full-hit on multi-source cases is expected to be well
   under the single-source rate.
3. **Refusals are Rem's strength.** The similarity floor plus citation-based `answered` should
   beat RGB's 45% negative rejection by a wide margin on plainly out-of-scope questions. The
   weaker spots should be partly covered questions and false premises, where relevant chunks pass
   the floor.
4. **Taglish loses on retrieval (F3).** English docs and a Filipino or Taglish question may
   score under the 0.625 floor and fall to the no-match path.
5. **Conflicts are the hardest category (F9).** RGB found models rarely notice wrong facts in
   their documents. Without a date-aware rule in the prompt, the outdated rule will often win when
   it ranks higher.
6. **Numeric cases fail on computation, not reading (F10).** This matches FRAMES' finding that
   most errors left with gold documents are numerical or tabular.

## 9. Decisions (2026-11-05)

1. **Judges:** Claude Opus 5.5 as the main judge, a larger Gemini model as the second (section
   6.4). The Anthropic API credit for the first round expires on 2026-11-10, so every paid run
   finishes by 2026-11-09.
2. **Split:** 60/40 dev and held-out, with model-against-model comparisons made by paired McNemar
   tests on the same cases.
3. **Categories:** 14, with false premise added (section 5).

### First round of models

All on Rem's current prompts (the universal set), with retrieval done once per case so every model
reads the same passages. Two runs each.

| Order | Answer model | Why this order |
|---|---|---|
| 1 | `gemini-3.1-flash-lite` | Rem's production model; answers are free; it tests the harness and the cases, and is where the judges are hand-checked |
| 2 | `claude-haiku-5-5` | cheapest Claude model: harness mistakes cost cents |
| 3 | `claude-sonnet-5-5` | |
| 4 | `claude-opus-5-5` | |
| 5 | `claude-fable-5-1` | only if the budget still allows |

- Claude models answer at effort `low`. They take no temperature setting, so the two runs measure
  their run-to-run variation.
- **Gate:** no Claude run starts until the hand check of 30 judged Gemini answers shows at least
  90% agreement with the main judge.
- The tests run as a script (`scripts/eval` in phase 3). A person labels the hand-check sample in
  the terminal; it is never labelled by a model.
