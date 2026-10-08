import "dotenv/config";
import { retrieveRelevantChunks } from "../src/retrieve/search.js";
import { generateAnswer } from "../src/generate/answer.js";
import { getProductName } from "../src/db/instance.js";
import { pool } from "../src/db/client.js";

async function main() {
  const question = process.argv.slice(2).join(" ");
  if (!question) {
    console.error("Usage: npm run ask -- \"your question\"");
    process.exit(1);
  }

  const productName = await getProductName();
  const chunks = await retrieveRelevantChunks(question);
  console.table(
    chunks.map((c) => ({
      file: c.source,
      heading: c.headingPath,
      similarity: c.similarity.toFixed(3),
    }))
  );

  const result = await generateAnswer(question, chunks, productName);

  console.log("\nAnswer:\n" + result.answer);
  console.log("\nSources:", result.sources.map((s) => `${s.source} (${s.heading})`).join(", ") || "none");

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
