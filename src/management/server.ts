import "dotenv/config";
import { pool } from "../db/client.js";
import { createManagementApp } from "./app.js";
import { MGMT_HOST, MGMT_PORT } from "./config.js";

// DELIBERATE, TEMPORARY: proves that a build whose management API cannot start never reaches the agent or the services.
if (process.env.NODE_ENV === "production") throw new Error("deliberately broken build: testing a failed deploy of the management API");

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
