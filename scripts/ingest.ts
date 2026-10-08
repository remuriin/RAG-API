import "dotenv/config";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { pool } from "../src/db/client.js";
import { ingestDocument } from "../src/ingest/pipeline.js";
import { deleteDocument } from "../src/ingest/store.js";

const DOCS_DIR = join(process.cwd(), "docs");

async function main() {
  if (!existsSync(DOCS_DIR)) {
    throw new Error(`docs folder not found at ${DOCS_DIR}`);
  }
  const files = readdirSync(DOCS_DIR).filter((f) => f.endsWith(".md"));
  if (files.length === 0) {
    throw new Error("No .md files found in docs/");
  }

  console.log(`Found ${files.length} doc files.`);

  for (const file of files) {
    await deleteDocument(file); // documents can't be overwritten, so re-running drops the stored copy first
    const result = await ingestDocument(file, readFileSync(join(DOCS_DIR, file), "utf-8"));
    console.log(`  ${file} -> ${result.chunks} chunks`);
  }

  console.log("Ingest complete.");
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
