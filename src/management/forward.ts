import { signInternalToken } from "../auth/internal.js";
import { INSTANCE_URL } from "./config.js";

const TIMEOUT_MS = 300000; // an upload waits for chunking and embedding, same as the public route

export interface Forwarded {
  status: number;
  body: string;
  contentType: string | null;
}

export class InstanceUnreachableError extends Error {}

// Passes a request on to the instance's own process. The management API never reads or writes an
// instance's files itself; the instance does the work, exactly as for API-key calls.
export async function forwardToInstance(
  instance: { id: string; port: number | null },
  method: string,
  path: string,
  options: { body?: string | Buffer; contentType?: string } = {}
): Promise<Forwarded> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${signInternalToken(instance.id)}`,
  };
  if (options.contentType) headers["Content-Type"] = options.contentType;

  // the id was checked to be a UUID before the record was loaded
  const base = INSTANCE_URL ? INSTANCE_URL.replace("{id}", instance.id) : `http://127.0.0.1:${instance.port}`;

  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers,
      // a Buffer is sent as its bytes; the cast is only for the type of its backing store
      body: options.body as BodyInit | undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new InstanceUnreachableError(err instanceof Error ? err.message : String(err));
  }

  return {
    status: response.status,
    body: await response.text(),
    contentType: response.headers.get("content-type"),
  };
}
