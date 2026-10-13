import { join } from "path";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

// Dry run exercises the status handling without a cluster (for development on your own machine).
export const DRY_RUN = process.env.AGENT_DRY_RUN === "true";

export const POLL_MS = Number(process.env.AGENT_POLL_MS ?? 2000);
// How long a service's pod gets to answer /health after it was created or changed
export const READY_TIMEOUT_MS = Number(process.env.AGENT_READY_TIMEOUT_MS ?? 60000);

// The image every client service runs: the agent's own, set inside the image when it is built
// (see the Dockerfile), so the agent and the services it starts are always the same code.
export const RAG_IMAGE = DRY_RUN ? "dry-run" : required("RAG_IMAGE");

// Where client services live. The agent's permission in the cluster covers this namespace only.
export const CLIENTS_NAMESPACE = process.env.AGENT_CLIENTS_NAMESPACE ?? "rem-raas-clients";
// What one service looks like, with __INSTANCE_ID__ and __IMAGE__ left to fill in
export const CLIENT_TEMPLATE = process.env.AGENT_CLIENT_TEMPLATE ?? join(process.cwd(), "k8s", "client.yaml");

// The cluster's own API, and the login the cluster hands this pod. Kubernetes replaces the token file
// about once an hour, so it is read again for every call.
export const KUBE_API = (process.env.AGENT_KUBE_API ?? "https://kubernetes.default.svc").replace(/\/+$/, "");
export const KUBE_TOKEN_FILE = process.env.AGENT_KUBE_TOKEN_FILE ?? "/var/run/secrets/kubernetes.io/serviceaccount/token";

// Created once every service runs this agent's image. The pod's readiness check looks for it, which is
// how a deploy learns that the new build really works for the services too. Unset: not written.
export const READY_FILE = process.env.AGENT_READY_FILE?.trim() || undefined;
