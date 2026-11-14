import { fetchWithRetry, googleErrorMessage } from "./http";

const ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

export interface PageSpeedResult {
  score: number | null;
  error?: string;
}

/** Run one official PageSpeed Insights audit (performance category only). */
export async function runPageSpeed(url: string, strategy: "mobile" | "desktop"): Promise<PageSpeedResult> {
  const key = process.env.PAGESPEED_API_KEY;
  if (!key) return { score: null, error: "PAGESPEED_API_KEY not configured" };
  const qs = new URLSearchParams({ url, strategy, category: "performance", key });
  try {
    const res = await fetchWithRetry(`${ENDPOINT}?${qs}`, { method: "GET" }, { retries: 1, timeoutMs: 90_000 });
    if (!res.ok) {
      const msg = await googleErrorMessage(res);
      return { score: null, error: `PageSpeed ${strategy} failed (${res.status}): ${msg.slice(0, 160)}` };
    }
    const json = await res.json();
    const raw = json?.lighthouseResult?.categories?.performance?.score;
    if (typeof raw !== "number") return { score: null, error: `PageSpeed ${strategy}: no score returned` };
    return { score: Math.round(raw * 100) };
  } catch (err) {
    return { score: null, error: `PageSpeed ${strategy} error: ${(err as Error).message}` };
  }
}
