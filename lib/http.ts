/** Fetch with timeout + retries for 429 / 5xx / network errors (Google APIs). */

export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentError";
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function backoff(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: { retries?: number; timeoutMs?: number } = {},
): Promise<Response> {
  const retries = opts.retries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await res.body?.cancel().catch(() => {});
        await sleep(retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : backoff(attempt));
        continue;
      }
      return res;
    } catch (err) {
      if (attempt < retries) {
        await sleep(backoff(attempt));
        continue;
      }
      throw err;
    }
  }
}

/** Extract a readable message from a Google API error body. */
export async function googleErrorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const j = JSON.parse(text);
    return j?.error?.message || j?.error_description || text.slice(0, 300);
  } catch {
    return text.slice(0, 300) || res.statusText;
  }
}
