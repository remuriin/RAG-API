import { readFile } from "fs/promises";
import { isUuid } from "../util/uuid.js";
import {
  CLIENT_TEMPLATE,
  CLIENTS_NAMESPACE,
  DRY_RUN,
  KUBE_API,
  KUBE_TOKEN_FILE,
  RAG_IMAGE,
  READY_TIMEOUT_MS,
} from "./config.js";

const POLL_INTERVAL_MS = 500;
const CALL_TIMEOUT_MS = 15000;

// Instance ids end up in object names and in the template, so nothing but a UUID is ever accepted.
function assertUuid(id: string): void {
  if (!isUuid(id)) throw new Error(`Refusing to act on a non-UUID instance id: ${id}`);
}

const deploymentPath = (id: string) => `/apis/apps/v1/namespaces/${CLIENTS_NAMESPACE}/deployments/rag-${id}`;
const servicePath = (id: string) => `/api/v1/namespaces/${CLIENTS_NAMESPACE}/services/rag-${id}`;

// One call to the cluster's API. The agent may create, change, read and delete Deployments and
// Services in the clients' namespace and nothing else (see k8s/agent.yaml).
async function kube(method: string, path: string, yaml?: string): Promise<Response> {
  const token = (await readFile(KUBE_TOKEN_FILE, "utf-8")).trim();
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (yaml) headers["Content-Type"] = "application/apply-patch+yaml";
  return fetch(`${KUBE_API}${path}`, { method, headers, body: yaml, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
}

async function failure(what: string, res: Response): Promise<Error> {
  const body: any = await res.json().catch(() => null);
  return new Error(`${what} failed: HTTP ${res.status}${body?.message ? ` ${body.message}` : ""}`);
}

// "Make it look like this": creates the object if it is missing, changes it if it differs, and does
// nothing if it already matches. That is what makes every step here safe to repeat.
async function apply(path: string, yaml: string): Promise<void> {
  const res = await kube("PATCH", `${path}?fieldManager=rag-agent&force=true`, yaml);
  if (!res.ok) throw await failure(`applying ${path.split("/").slice(-2).join("/")}`, res);
}

async function remove(path: string): Promise<void> {
  const res = await kube("DELETE", path);
  // already gone is not an error
  if (!res.ok && res.status !== 404) throw await failure(`deleting ${path.split("/").slice(-2).join("/")}`, res);
}

// The image a service runs now, or null if it has no pod yet
async function currentImage(id: string): Promise<string | null> {
  const res = await kube("GET", deploymentPath(id));
  if (res.status === 404) return null;
  if (!res.ok) throw await failure(`reading rag-${id}`, res);
  const deployment: any = await res.json();
  return deployment?.spec?.template?.spec?.containers?.[0]?.image ?? null;
}

// Creates the service's pod and its name, or brings them in line with the template.
export async function startService(id: string, image: string = RAG_IMAGE): Promise<void> {
  assertUuid(id);
  if (DRY_RUN) {
    console.log(`  [dry run] apply rag-${id} with ${image}`);
    return;
  }
  const template = await readFile(CLIENT_TEMPLATE, "utf-8");
  // the id is a checked UUID and the image comes from this process's own settings, never from a request
  const filled = template.replaceAll("__INSTANCE_ID__", id).replaceAll("__IMAGE__", image);
  const [deployment, service, ...rest] = filled.split(/^---\s*$/m);
  if (!deployment?.includes("kind: Deployment") || !service?.includes("kind: Service") || rest.length) {
    throw new Error(`${CLIENT_TEMPLATE} must hold a Deployment and then a Service`);
  }
  await apply(deploymentPath(id), deployment);
  await apply(servicePath(id), service);
}

export async function stopService(id: string): Promise<void> {
  assertUuid(id);
  if (DRY_RUN) {
    console.log(`  [dry run] delete rag-${id}`);
    return;
  }
  await remove(deploymentPath(id));
  await remove(servicePath(id));
}

// Waits until the pod of the service's current settings answers /health. Kubernetes asks /health itself
// (the readiness check in the template) and reports the result on the Deployment.
export async function waitForHealth(id: string): Promise<void> {
  assertUuid(id);
  if (DRY_RUN) {
    console.log(`  [dry run] skipping health check of rag-${id}`);
    return;
  }
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await kube("GET", deploymentPath(id));
    if (res.ok) {
      const d: any = await res.json();
      const status = d.status ?? {};
      // "observedGeneration" catches the moment right after a change, when the numbers still describe the old pod
      const seen = (status.observedGeneration ?? 0) >= (d.metadata?.generation ?? 0);
      if (seen && status.updatedReplicas === 1 && status.availableReplicas === 1 && status.replicas === 1) return;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`The service did not answer on /health within ${READY_TIMEOUT_MS / 1000}s`);
}

// Brings one running service to this agent's image. If its new pod does not come up, the service is
// put back on the image it ran before and the error is passed on, so a broken build stops at the
// first service instead of taking all of them down.
export async function updateService(id: string): Promise<void> {
  assertUuid(id);
  if (DRY_RUN) {
    console.log(`  [dry run] update rag-${id}`);
    return;
  }
  const before = await currentImage(id);
  await startService(id);
  try {
    await waitForHealth(id);
  } catch (err) {
    // Not a new build's fault: the service was already on this image, or had no pod at all. One broken
    // service must not keep the agent from looking after the others, so it is reported and left.
    if (!before || before === RAG_IMAGE) {
      console.error(`  rag-${id} is not answering: ${err instanceof Error ? err.message : err}`);
      return;
    }
    console.error(`  rag-${id} did not come up on ${RAG_IMAGE}; putting it back on ${before}`);
    await startService(id, before).catch((e) => console.error(`  could not put rag-${id} back: ${e.message}`));
    throw err;
  }
}
