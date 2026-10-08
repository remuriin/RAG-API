const DEFAULT_RETRIES = 4;
const DEFAULT_BASE_DELAY_MS = 2000; // doubles each attempt: 2s, 4s, 8s, 16s

// Gemini signals rate limits and overload with 429 / 503
export function isRetryable(err: any): boolean {
  const status = err?.status ?? err?.code;
  return status === 429 || status === 503;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  options: { retries?: number; baseDelayMs?: number } = {}
): Promise<T> {
  const retries = options.retries ?? DEFAULT_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      if (!isRetryable(err) || attempt >= retries) throw err;

      const delay = baseDelayMs * 2 ** attempt;
      console.warn(
        `[${label}] hit ${err?.status ?? err?.code} (high demand / rate limit). Retrying in ${delay / 1000}s... (${retries - attempt} attempt(s) left)`
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
