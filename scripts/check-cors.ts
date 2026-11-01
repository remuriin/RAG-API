// Checks that browsers may call /query and nothing else, without a model or a database:
// npx tsx scripts/check-cors.ts
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import { allowBrowserQueries } from "../src/api/cors.js";

// A stand-in for the real service: the same order of middleware, a pretend key check
const app = express();
app.use(allowBrowserQueries);
app.use((req, res, next) => {
  if (req.get("authorization") !== "Bearer test-key") {
    res.status(401).json({ error: "Missing API key" });
    return;
  }
  next();
});
app.post("/query", (_req, res) => {
  res.json({ answer: "ok" });
});
app.get("/documents", (_req, res) => {
  res.json({ documents: [] });
});

const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

try {
  // the browser's preflight for /query: answered without a key, from a page opened on disk
  const preflight = await fetch(`${base}/query`, {
    method: "OPTIONS",
    headers: {
      Origin: "null",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization,content-type",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /authorization/i);
  assert.match(preflight.headers.get("access-control-allow-methods") ?? "", /POST/);

  // the real question: still needs the key, and the reply may be read by the page
  const asked = await fetch(`${base}/query`, {
    method: "POST",
    headers: { Origin: "https://example.com", Authorization: "Bearer test-key", "Content-Type": "application/json" },
    body: JSON.stringify({ question: "hi" }),
  });
  assert.equal(asked.status, 200);
  assert.equal(asked.headers.get("access-control-allow-origin"), "*");

  const noKey = await fetch(`${base}/query`, { method: "POST", headers: { Origin: "null" } });
  assert.equal(noKey.status, 401, "a missing key is still refused");
  assert.equal(noKey.headers.get("access-control-allow-origin"), "*", "so the page can show the refusal");

  // everything else stays closed to browsers
  const otherPreflight = await fetch(`${base}/documents`, {
    method: "OPTIONS",
    headers: { Origin: "null", "Access-Control-Request-Method": "GET" },
  });
  assert.equal(otherPreflight.status, 401);
  assert.equal(otherPreflight.headers.get("access-control-allow-origin"), null);

  const list = await fetch(`${base}/documents`, { headers: { Origin: "null", Authorization: "Bearer test-key" } });
  assert.equal(list.status, 200);
  assert.equal(list.headers.get("access-control-allow-origin"), null);

  console.log("cors: ok");
} finally {
  server.close();
}
