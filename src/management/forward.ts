import { signInternalToken } from "../auth/internal.js";

const TIMEOUT_MS = 300000; // an upload waits for chunking and embedding, same as the public route

export interface Forwarded {
  status: number;
  body: string;
  contentType: string | null;
}

export class InstanceUnreachableError extends Error {}

// Passes a request on to the instance's own process on this machine. The management API never
// reads or writes an instance's files itself; the instance does the work, exactly as for API-key calls.
export async function forwardToInstance(
  instance: { id: string; port: number },
  method: string,
  path: string,
  options: { body?: string; contentType?: string } = {}
): Promise<Forwarded> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${signInternalToken(instance.id)}`,
  };
  if (options.contentType) headers["Content-Type"] = options.contentType;

  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${instance.port}${path}`, {
      method,
      headers,
      body: options.body,
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
