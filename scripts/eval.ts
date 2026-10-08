import "dotenv/config";
import { retrieveRelevantChunks } from "../src/retrieve/search.js";
import { generateAnswer } from "../src/generate/answer.js";
import { getProductName } from "../src/db/instance.js";
import { pool } from "../src/db/client.js";
import { withRetry } from "../src/util/retry.js";

interface TestCase {
  id: number;
  tier: string;
  question: string;
  expectedSource?: string; // omit for questions that should be refused
}

const testCases: TestCase[] = [
  // Tier 1 — direct lookups
  { id: 1, tier: "direct", question: "What is the minimum fare?", expectedSource: "fares.md" },
  { id: 2, tier: "direct", question: "How much is the cancellation fee?", expectedSource: "cancellations.md" },
  { id: 3, tier: "direct", question: "What documents do I need to become a driver?", expectedSource: "driver-verification.md" },
  { id: 4, tier: "direct", question: "What does the SOS button do?", expectedSource: "safety.md" },
  { id: 5, tier: "direct", question: "How long does driver verification take?", expectedSource: "driver-verification.md" },
  { id: 6, tier: "direct", question: "What discount do senior citizens get?", expectedSource: "fares.md" },
  { id: 7, tier: "direct", question: "Can I pay with GCash?", expectedSource: "fares.md" },
  { id: 8, tier: "direct", question: "What happens if my driver cancels?", expectedSource: "cancellations.md" },

  // Tier 2 — paraphrased / indirect lookups
  { id: 9, tier: "paraphrased", question: "why was my fare higher than i expected", expectedSource: "fares.md" },
  { id: 10, tier: "paraphrased", question: "my driver never showed up, do i still get charged", expectedSource: "cancellations.md" },
  { id: 11, tier: "paraphrased", question: "i got rejected, why", expectedSource: "driver-verification.md" },
  { id: 12, tier: "paraphrased", question: "is it safe to ride alone at night", expectedSource: "safety.md" },
  { id: 13, tier: "paraphrased", question: "how do i get my license checked again", expectedSource: "driver-verification.md" },
  { id: 14, tier: "paraphrased", question: "i think i got overcharged", expectedSource: "fares.md" },

  // Tier 3 — cross-document (listing one plausible source; judge the actual answer, not just the match)
  { id: 15, tier: "cross-document", question: "i want to cancel because i feel unsafe, do i get charged", expectedSource: "cancellations.md" },
  { id: 16, tier: "cross-document", question: "can a driver operate in a different city than where they signed up", expectedSource: "driver-verification.md" },
  { id: 17, tier: "cross-document", question: "what happens to my fare if i report a safety incident mid-trip", expectedSource: "safety.md" },

  // Tier 4 — out-of-scope, should be refused (no expectedSource)
  { id: 18, tier: "refusal", question: "who is the CEO of Tricycall" },
  { id: 19, tier: "refusal", question: "what's the weather like today" },
  { id: 20, tier: "refusal", question: "how do I cancel my Grab ride" },
  { id: 21, tier: "refusal", question: "what's the capital of the Philippines" },
  { id: 22, tier: "refusal", question: "can I bring a pet on the tricycle" },
  { id: 23, tier: "direct", question: "does Tricycall operate in Cebu", expectedSource: "service-areas.md" },
  { id: 24, tier: "refusal", question: "is Tricycall cheaper than Angkas?" },

  // Expansion: service-areas, booking-a-ride, ratings, wallet-and-account
  { id: 25, tier: "direct", question: "Which areas does Tricycall serve?", expectedSource: "service-areas.md" },
  { id: 26, tier: "direct", question: "How do I book a ride?", expectedSource: "booking-a-ride.md" },
  { id: 27, tier: "direct", question: "How many passengers can ride in one tricycle?", expectedSource: "booking-a-ride.md" },
  { id: 28, tier: "direct", question: "How do I rate my driver?", expectedSource: "ratings.md" },
  { id: 29, tier: "direct", question: "How do I link my GCash?", expectedSource: "wallet-and-account.md" },
  { id: 30, tier: "direct", question: "When do drivers get paid?", expectedSource: "wallet-and-account.md" },
  { id: 31, tier: "paraphrased", question: "no driver is accepting my ride, what now", expectedSource: "booking-a-ride.md" },
  { id: 32, tier: "paraphrased", question: "my driver rated me badly and i think its unfair", expectedSource: "ratings.md" },
  { id: 33, tier: "paraphrased", question: "can i withdraw my wallet balance as cash", expectedSource: "wallet-and-account.md" },
  { id: 34, tier: "cross-document", question: "im a student, how do i get my discount when booking", expectedSource: "wallet-and-account.md" },
  { id: 35, tier: "cross-document", question: "can a driver with a Santa Lucia permit accept rides in San Roque", expectedSource: "service-areas.md" },
  { id: 36, tier: "refusal", question: "can i book a ride for my friend" },
  { id: 37, tier: "refusal", question: "can i tip my driver" },
  { id: 38, tier: "refusal", question: "can i pay with apple pay" },
  { id: 39, tier: "refusal", question: "can i book a tricycle for tomorrow morning" },
];

const DELAY_MS = 3000; // pause between questions, free-tier RPM safety margin
// The pipeline already retries with short backoff; this outer layer waits out a full per-minute rate limit window
const RETRY = { retries: 2, baseDelayMs: 20000 };

async function main() {
  const productName = await getProductName();

  const results: {
    id: number;
    tier: string;
    question: string;
    expectedSource: string;
    topScore: string;
    gotSources: string;
    answer: string;
  }[] = [];

  for (const tc of testCases) {
    console.log(`\n[${tc.id}/${testCases.length}] (${tc.tier}) ${tc.question}`);

    try {
      const chunks = await withRetry(() => retrieveRelevantChunks(tc.question), "retrieval", RETRY);

      console.table(
        chunks.map((c) => ({
          file: c.source,
          heading: c.headingPath,
          similarity: c.similarity.toFixed(3),
        }))
      );

      const result = await withRetry(() => generateAnswer(tc.question, chunks, productName), "generation", RETRY);

      const topScore = chunks.length > 0 ? chunks[0].similarity.toFixed(3) : "n/a";
      const gotSources = result.sources.map((s) => s.source).join(", ") || "none";

      results.push({
        id: tc.id,
        tier: tc.tier,
        question: tc.question,
        expectedSource: tc.expectedSource ?? "(should refuse)",
        topScore,
        gotSources,
        answer: result.answer,
      });

      console.log(`  top score: ${topScore} | sources: ${gotSources}`);
      console.log(`  answer: ${result.answer}`);
    } catch (err: any) {
      const message = err?.message ?? String(err);
      console.log(`  FAILED: ${message}`);

      results.push({
        id: tc.id,
        tier: tc.tier,
        question: tc.question,
        expectedSource: tc.expectedSource ?? "(should refuse)",
        topScore: "ERROR",
        gotSources: "ERROR",
        answer: `[FAILED: ${message}]`,
      });
    }

    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  console.log("\n\n===== FULL REPORT =====\n");
  console.table(
    results.map((r) => ({
      id: r.id,
      tier: r.tier,
      expected: r.expectedSource,
      topScore: r.topScore,
      gotSources: r.gotSources,
    }))
  );

  console.log("\n===== FULL ANSWERS (for manual/Claude review) =====\n");
  for (const r of results) {
    console.log(`#${r.id} [${r.tier}] ${r.question}`);
    console.log(`  Expected: ${r.expectedSource}`);
    console.log(`  Got sources: ${r.gotSources}`);
    console.log(`  Answer: ${r.answer}`);
    console.log("");
  }

  const failedCount = results.filter((r) => r.topScore === "ERROR").length;
  if (failedCount > 0) {
    console.log(`\n⚠ ${failedCount} question(s) failed even after retries — see ERROR entries above.`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});