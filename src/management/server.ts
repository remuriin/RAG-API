import "dotenv/config";
import { pool } from "../db/client.js";
import { createManagementApp } from "./app.js";
import { MGMT_HOST, MGMT_PORT } from "./config.js";

const server = createManagementApp().listen(MGMT_PORT, MGMT_HOST, () => {
  console.log(`management api listening on http://${MGMT_HOST}:${MGMT_PORT}`);
});

function shutdown() {
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
