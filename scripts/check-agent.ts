// Checks how the control agent drives the cluster, against a stand-in for the Kubernetes API.
// No cluster, no database, no network: npx tsx scripts/check-agent.ts
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NEW_IMAGE = "ghcr.io/remuriin/rag-api:new";
const OLD_IMAGE = "ghcr.io/remuriin/rag-api:old";
const ID = "f27dddd9-70ab-4302-a9d1-ad2d838c69cf";
const NS = "rem-raas-clients";

// what the stand-in cluster holds: object path -> the text it was last given
const objects = new Map<string, string>();
const calls: { method: string; path: string; type?: string; auth?: string }[] = [];
// images whose pod never becomes healthy
const broken = new Set<string>();

const imageOf = (yaml: string) => yaml.match(/^\s*image: (\S+)$/m)?.[1] ?? null;

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const path = req.url!.split("?")[0];
    calls.push({ method: req.method!, path, type: req.headers["content-type"], auth: req.headers.authorization });
    const reply = (status: number, json: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(json));
    };
    if (req.headers.authorization !== "Bearer test-token") return reply(401, { message: "Unauthorized" });
    const existing = objects.get(path);
    if (req.method === "PATCH") {
      objects.set(path, body);
      return reply(existing ? 200 : 201, {});
    }
    if (!existing) return reply(404, { message: "not found" });
    if (req.method === "DELETE") {
      objects.delete(path);
      return reply(200, {});
    }
    const image = imageOf(existing);
    const up = image && !broken.has(image) ? 1 : 0;
    reply(200, {
      metadata: { generation: 1 },
      spec: { template: { spec: { containers: [{ image }] } } },
      status: { observedGeneration: 1, replicas: 1, updatedReplicas: 1, availableReplicas: up },
    });
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));

const dir = mkdtempSync(join(tmpdir(), "check-agent-"));
writeFileSync(join(dir, "token"), "test-token\n");
process.env.RAG_IMAGE = NEW_IMAGE;
process.env.AGENT_KUBE_API = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.AGENT_KUBE_TOKEN_FILE = join(dir, "token");
process.env.AGENT_READY_TIMEOUT_MS = "1500";
delete process.env.AGENT_DRY_RUN;

// imported only now: the settings above are read when the module loads
const { startService, stopService, updateService, waitForHealth } = await import("../src/agent/system.js");

const deployment = `/apis/apps/v1/namespaces/${NS}/deployments/rag-${ID}`;
const service = `/api/v1/namespaces/${NS}/services/rag-${ID}`;
const route = `/apis/gateway.networking.k8s.io/v1/namespaces/${NS}/httproutes/rag-${ID}`;

// setting a service up: the template, filled in, goes to the three right places, the route last
await startService(ID);
assert.deepEqual([...objects.keys()], [deployment, service, route]);
const sent = objects.get(deployment)!;
assert.equal(imageOf(sent), NEW_IMAGE, "the agent's own image");
assert.ok(sent.includes(`name: rag-${ID}`) && sent.includes(`value: "${ID}"`), "the service id is filled in");
assert.ok(!/__[A-Z_]+__/.test(sent + objects.get(service) + objects.get(route)), "no placeholder is left");
assert.ok(sent.includes("kind: Deployment") && objects.get(service)!.includes("kind: Service"));
const sentRoute = objects.get(route)!;
assert.ok(sentRoute.includes("kind: HTTPRoute") && sentRoute.includes(`value: /i/${ID}`), "the route is for this id");
assert.ok(sentRoute.includes(`name: rag-${ID}`) && sentRoute.includes('remservers.me/client-route: "true"'), "the route points at the service and carries the policy's label");
assert.ok(calls.every((c) => c.auth === "Bearer test-token"), "every call carries the pod's token");
assert.ok(calls.every((c) => c.method === "PATCH" && c.type === "application/apply-patch+yaml"));
await waitForHealth(ID);

// safe to repeat
await startService(ID);
assert.equal(objects.size, 3);

// nothing but a UUID is ever acted on
for (const bad of ["", "../x", `${ID}/x`, "rag", `${ID} `]) {
  await assert.rejects(startService(bad), /non-UUID/);
  await assert.rejects(stopService(bad), /non-UUID/);
  await assert.rejects(waitForHealth(bad), /non-UUID/);
  await assert.rejects(updateService(bad), /non-UUID/);
}

// a service that never answers is reported, not waited on forever
broken.add(NEW_IMAGE);
await assert.rejects(waitForHealth(ID), /did not answer on \/health within 1\.5s/);
broken.clear();

// removing a service, and removing it again; the route goes first, so no visitor is sent to a pod being stopped
calls.length = 0;
await stopService(ID);
assert.equal(objects.size, 0);
assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [`DELETE ${route}`, `DELETE ${deployment}`, `DELETE ${service}`]);
await stopService(ID);

// a deploy: a service on the old image moves to the new one
await startService(ID, OLD_IMAGE);
await updateService(ID);
assert.equal(imageOf(objects.get(deployment)!), NEW_IMAGE);

// a broken build: the service goes back to the image it ran, and the error is passed on
await startService(ID, OLD_IMAGE);
broken.add(NEW_IMAGE);
await assert.rejects(updateService(ID), /did not answer/);
assert.equal(imageOf(objects.get(deployment)!), OLD_IMAGE, "put back on the old image");

// a service that is down for its own reasons does not stop the agent: reported, left as it is
await startService(ID);
await updateService(ID);
assert.equal(imageOf(objects.get(deployment)!), NEW_IMAGE);
broken.clear();

// a service with no pod at all (the first run in the cluster) gets one
await stopService(ID);
await updateService(ID);
assert.equal(imageOf(objects.get(deployment)!), NEW_IMAGE);
assert.ok(objects.has(service) && objects.has(route));

// the cluster refusing a call is an error with its reason in it
writeFileSync(join(dir, "token"), "wrong\n");
await assert.rejects(startService(ID), /HTTP 401 Unauthorized/);

server.close();
console.log("check-agent: all passed");
