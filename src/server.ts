import "dotenv/config";
import { createApp } from "./api/app.js";
import { HOST, INSTANCE_ID, PORT } from "./config.js";
import { pool } from "./db/client.js";
import { failInterruptedDocuments } from "./ingest/store.js";

// DELIBERATE, TEMPORARY: proves that a build whose services cannot start is stopped and undone by the deploy.
if (process.env.NODE_ENV === "production") throw new Error("deliberately broken build: testing a failed deploy");

await failInterruptedDocuments();

const server = createApp().listen(PORT, HOST, () => {
  console.log(`rag instance ${INSTANCE_ID} listening on http://${HOST}:${PORT}`);
});

function shutdown() {
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
