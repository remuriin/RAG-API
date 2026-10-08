# Tricycall: Developer Reference & RAG Test Questions

- [Part 1: Developer Reference](#part-1--developer-reference)
- [Part 2: RAG Test Questions](#part-2--rag-test-questions)

---

## Part 1 — Developer Reference
Internal reference for the Tricycall team. Covers standard ride-hailing feature sets, how Philippine tricycle fares actually work, and how this maps to the dummy content used in the RAG assistant. This document is for developers; it is **not** the content fed to the chatbot (see `rag-docs/` for that).

---

### 1. Why this document exists

The app is early scaffolding — routing only, no working features. Before building real fare logic, matching, or safety flows, it helps to know what a mature ride-hailing product actually includes, and what's specific to tricycles as a vehicle class in the Philippines. This doc is a reference point for later implementation decisions, and the source material the dummy RAG docs were loosely derived from.

---

### 2. Standard ride-hailing feature set

Most mature ride-hailing platforms (Grab, Uber, inDrive, Angkas) share a common feature backbone. Mapped against Tricycall's existing routes where relevant:

#### Passenger-side
| Feature | Purpose | Tricycall route (if present) |
|---|---|---|
| Pickup/destination input with map | Define the trip | `passenger/home` |
| Driver matching | Find a nearby available driver | not implemented |
| Fare estimate before booking | Set expectations, avoid disputes | not implemented |
| Live driver tracking | Reduce wait-time anxiety, safety | `passenger/finding-driver` |
| In-app or cash payment | Settle the trip | not implemented |
| Trip history | Receipts, reorder, disputes | `passenger/my-rides` |
| Ratings/reviews | Quality signal, accountability | not implemented |
| SOS / emergency button | Safety-critical | `passenger/safety` |
| Fare splitting | Group rides | not implemented |
| Saved places (home/work) | Convenience | not implemented |
| Promo codes / wallet credits | Retention, marketing | not implemented |
| Cancellation with reason capture | Reduce abuse, improve matching | `passenger/cancel-ride` |

#### Driver-side
| Feature | Purpose | Tricycall route (if present) |
|---|---|---|
| Online/offline toggle | Driver availability control | not implemented |
| Trip request accept/decline | Core matching loop | not implemented |
| Navigation to pickup/drop-off | Operational necessity | not implemented |
| Earnings dashboard | Transparency, trust | `driver/earnings-payout` |
| Document upload (license, OR/CR, MTOP) | Regulatory compliance | `driver/sign-up-documents` |
| Verification status | Gatekeeping before driving | `driver/verification-pending` |
| In-app chat/call masking | Passenger-driver coordination without exposing numbers | not implemented |
| Trip history | Same as passenger-side, driver's view | not implemented |
| Safety reporting | Same category as passenger safety | `driver/safety` |
| Payout schedule & methods | Driver cash flow | `driver/earnings-payout` |

#### Platform/ops (usually backend-only, no dedicated screen)
- Surge/dynamic pricing engine
- Fraud detection (GPS spoofing, fake trips)
- Dispute resolution workflow
- Driver incentive programs
- Geofencing (service area limits)
- Vehicle type/capacity matching

None of this is built yet in Tricycall — it's listed here so the dummy RAG docs (which describe *policies*, like "how fares are calculated" or "how to cancel") stay consistent with what a real implementation would eventually need to enforce.

---

### 3. How Philippine tricycle fares actually work

This matters for Tricycall specifically because tricycle fares work differently from the jeepney/bus/taxi fares most people are familiar with, and differently from app-based ride-hailing fare models like Grab's.

#### 3.1 No national fare — it's set per LGU
Unlike jeepneys, buses, and TNVS (Transport Network Vehicle Service — e.g. Grab), which fall under the **LTFRB** (Land Transportation Franchising and Regulatory Board) and get nationally-set fare matrices, tricycles are regulated locally. Pricing is handled town-by-town and city-by-city through local government unit (LGU) ordinances, terminal practices, and posted fare matrices — there's no single national price list the way there is for jeepneys or buses.

Practical implication for Tricycall: a single hardcoded national fare formula would be factually wrong. The real app would need a **per-municipality fare configuration** (minimum fare, per-km rate, surcharges), not a global constant.

#### 3.2 Two common pricing models
Tricycle rides in the Philippines are typically priced one of two ways:
- **Per-head / shared**: common along fixed routes, where the tricycle functions like short-distance public transport. Each passenger pays the posted rate individually, and the driver may pick up additional passengers along the way, similar to a jeepney.
- **Special / exclusive trip**: the passenger hires the whole tricycle exclusively, usually for a higher flat rate, with no other passengers picked up along the route.

#### 3.3 Real example fare matrix (Angeles City, Pampanga — 2024 ordinance)
As a concrete, real reference point for realistic numbers: Angeles City's fare matrix (Ordinance No. 723, S-2024) sets a minimum fare of ₱35 covering up to two passengers for the first kilometer, with an additional ₱15 for each succeeding kilometer. The ordinance also mandates fare discounts for students, senior citizens, persons with disabilities, and solo parents, consistent with existing national discount laws for those groups.

Operationally, the ordinance requires tricycle operators to display a fare matrix inside the vehicle and at terminals, under a "no posted fare matrix, no travel" policy, and drivers are required to accept passengers regardless of gender, status, age, or physical condition. Violations of fare rules carry fines starting at ₱1,000 for a first offense, rising to ₱5,000 with potential permit revocation for repeat offenders.

This is the real-world model Tricycall's dummy fare doc (`rag-docs/fares.md`) is loosely based on, adapted into fictional numbers for a fictional city, since Tricycall isn't tied to one specific real LGU.

#### 3.4 Why this matters for the eventual fare engine
When fare calculation gets built for real:
- Fare config needs to be **per service area**, not global.
- Minimum fare typically covers a **small passenger count** (e.g. up to 2), not a flat per-rider rate from km zero.
- Per-km rate only applies **after** the minimum-fare distance threshold.
- Discount categories (student/senior/PWD/solo parent) are a **legal requirement** in many LGUs, not an optional feature.
- Fares are not static long-term — regulatory and fuel-driven rate changes happen at the LGU level on their own schedule. Nationally-regulated modes like jeepneys and buses have seen multiple LTFRB fare adjustments through 2026 tied to fuel price swings, and while tricycles sit outside LTFRB's direct authority, LGU-set tricycle fares tend to drift upward for similar cost reasons over time.

---

### 4. Mapping to the dummy RAG docs

| `rag-docs/` file | Covers | Real-world basis |
|---|---|---|
| `fares.md` | Minimum fare, per-km rate, surcharges, discounts | Angeles City ordinance structure, generalized |
| `cancellations.md` | Passenger/driver cancellation policy, fees, timing | Standard ride-hailing cancellation-fee patterns (Grab/Uber-style) |
| `safety.md` | SOS flow, driver verification, trip sharing, incident reporting | Standard ride-hailing safety feature set |
| `service-areas.md` | Active areas, per-area fares, booking limits, driver area rules | Fictional areas; per-LGU structure is real |
| `booking-a-ride.md` | Booking steps, matching, no-driver case, capacity | Standard ride-hailing flow, adapted to exclusive tricycle rides |
| `ratings.md` | Rating scale, averages, disputes | Standard ride-hailing ratings model |
| `wallet-and-account.md` | Sign-up, ID for discounts, wallet, driver payouts | Standard wallet model; payout figures invented for testing |
| `driver-verification.md` | Document requirements, MTOP, approval timeline | MTOP requirement is real (referenced in the Angeles City ordinance as grounds for suspension); approval timeline and document list are invented for testing |

All four `rag-docs/` files are **fictional content for a fictional company**, written to be realistic enough to test retrieval and generation quality — not actual Tricycall policy. There is no real fare table or operations policy yet, since the app itself isn't built.

---

### 5. Open questions for later (not resolved by this document)
- Which real Philippine city or area, if any, will Tricycall's fare config be modeled on at launch?
- Will Tricycall support per-head shared rides, exclusive-only rides, or both?
- Does Tricycall need to support multiple simultaneous service areas with different LGU fare rules from day one, or can that be deferred?
- How will MTOP (Motorized Tricycle Operator's Permit) verification be checked — manual review, a third-party API, or an LGU registry integration (if one exists)?

---

## Part 2 — RAG Test Questions

> **Note:** the questions below are **not limited to this list**. They are a starting benchmark. Add, rephrase and extend them with your own questions as you tune and test the pipeline. The runnable copy lives in `scripts/eval.ts`; keep the two in sync when you add questions.

A set of test questions to run against `npm run ask -- "question"` once the real docs are ingested. Covers four categories: direct lookups, paraphrased lookups, cross-document questions, and out-of-scope questions that should be correctly refused. Expected source file(s) are noted for each so you can judge whether retrieval picked the right chunk, not just whether the final answer sounded plausible.

Run `npm run ingest` first with `test.md` removed and the four files in `rag-docs/` copied into your `docs/` folder.

---

### 2.1 Direct lookups
Straightforward questions that closely match the wording in the docs. These should be easy — if any of these fail, something is wrong with chunking or the similarity floor, not just phrasing sensitivity.

| # | Question | Expected source(s) |
|---|---|---|
| 1 | What is the minimum fare? | fares.md |
| 2 | How much is the cancellation fee? | cancellations.md |
| 3 | What documents do I need to become a driver? | driver-verification.md |
| 4 | What does the SOS button do? | safety.md |
| 5 | How long does driver verification take? | driver-verification.md |
| 6 | What discount do senior citizens get? | fares.md |
| 7 | Can I pay with GCash? | fares.md |
| 8 | What happens if my driver cancels? | cancellations.md |
| 25 | Which areas does Tricycall serve? | service-areas.md |
| 26 | How do I book a ride? | booking-a-ride.md |
| 27 | How many passengers can ride in one tricycle? | booking-a-ride.md |
| 28 | How do I rate my driver? | ratings.md |
| 29 | How do I link my GCash? | wallet-and-account.md |
| 30 | When do drivers get paid? | wallet-and-account.md |

### 2.2 Paraphrased / indirect lookups
Same information, worded the way a real user would actually ask it — tests whether embeddings capture meaning, not just keyword overlap.

| # | Question | Expected source(s) | Notes |
|---|---|---|---|
| 9 | why was my fare higher than i expected | fares.md | Should surface surge pricing and/or fare estimate sections |
| 10 | my driver never showed up, do i still get charged | cancellations.md | Tests the no-show vs driver-cancel distinction |
| 11 | i got rejected, why | driver-verification.md | Should surface "Common rejection reasons" |
| 12 | is it safe to ride alone at night | safety.md | Should surface night-time safety features |
| 13 | how do i get my license checked again | driver-verification.md | Tests "re-verification" wording match to "license checked" |
| 14 | i think i got overcharged | fares.md | Should surface fare disputes section |
| 31 | no driver is accepting my ride, what now | booking-a-ride.md | Should surface the "no driver found" section |
| 32 | my driver rated me badly and i think its unfair | ratings.md | Should surface disputing an unfair rating |
| 33 | can i withdraw my wallet balance as cash | wallet-and-account.md | Answer is no; credit is only for rides |

### 2.3 Cross-document questions
The honest answer draws on two files, or requires the model to say it's incomplete. These are the hardest and most realistic test of whether `topK` and the similarity floor are tuned well — a single-document retrieval set up with `topK: 5` should still pull from multiple files when the question genuinely spans them.

| # | Question | Expected source(s) | Notes |
|---|---|---|---|
| 15 | i want to cancel because i feel unsafe, do i get charged | cancellations.md + safety.md | Tests whether both the "safety concern" cancellation exception and the safety reporting flow surface together |
| 16 | can a driver operate in a different city than where they signed up | driver-verification.md | Single doc, but tests a specific nuance (MTOP is area-locked) rather than a simple fact lookup |
| 17 | what happens to my fare if i report a safety incident mid-trip | safety.md + cancellations.md + fares.md | No doc says what happens to the fare itself. A good answer routes to the "safety concern" cancellation and the fare-dispute flow, and admits the gap |
| 34 | im a student, how do i get my discount when booking | wallet-and-account.md + fares.md | Needs the ID upload steps and the 20% student discount together |
| 35 | can a driver with a Santa Lucia permit accept rides in San Roque | service-areas.md + driver-verification.md | Needs the area-locked MTOP rule and the re-verification time |

### 2.4 Out-of-scope — should be correctly refused
Nothing in the docs supports these. The pipeline should return the "I don't have information about that" fallback and cite no sources. If any of these return a confident answer, the similarity floor is too low or the model is being handed irrelevant chunks and improvising anyway — treat that as a priority fix, not a minor one, since avoiding this is the actual job of a RAG pipeline.

| # | Question | Expected behavior |
|---|---|---|
| 18 | who is the CEO of Tricycall | Refuse — not in docs |
| 19 | what's the weather like today | Refuse — unrelated |
| 20 | how do I cancel my Grab ride | Say it can only help with Tricycall (intentional), then offer Tricycall's cancel steps |
| 21 | what's the capital of the Philippines | Refuse — unrelated general knowledge |
| 22 | can I bring a pet on the tricycle | Refuse — not covered in any doc |
| 23 | does Tricycall operate in Cebu | Now answerable (moved to a direct lookup): not available yet, active areas are Santa Lucia and San Roque (service-areas.md) |
| 24 | is Tricycall cheaper than Angkas? | Say it can only help with Tricycall; no sources, no invented comparison |
| 36 | can i book a ride for my friend | Should say it doesn't have that info; no doc covers booking for someone else |
| 37 | can i tip my driver | Say it can't confirm; no invented tipping feature |
| 38 | can i pay with apple pay | Say it can't confirm; no sources |
| 39 | can i book a tricycle for tomorrow morning | Say it can't confirm; no invented scheduling feature |

---

### 2.5 How to read the results

- **Right answer, right source cited** → retrieval and generation both working as intended.
- **Right answer, wrong source cited** → the answer happened to be correct, but retrieval got lucky or pulled an adjacent chunk; worth checking why, especially if it recurs.
- **"I don't know" on a question that should have an answer** → similarity floor likely too high, or `topK` too low, or the chunk boundary split the relevant sentence away from its heading context.
- **Confident answer on an out-of-scope question (section 4)** → the most important failure mode to catch. Lower `SIMILARITY_FLOOR` is the wrong fix here; if anything, raise it, since this means irrelevant chunks are clearing the current floor.
- **Partial answer on a cross-document question (section 3) that doesn't acknowledge the gap** → check whether `topK` is large enough to pull chunks from more than one file, and whether the prompt's "say what's missing" instruction is actually being followed by the model.

Keep a running log of pass/fail here as you tune `SIMILARITY_FLOOR`, `topK`, and `MAX_CHARS` — this table is the benchmark to re-run after each change, not a one-time test.
