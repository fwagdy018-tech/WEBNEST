/**
 * Verifies each external integration with one small real request.
 *   npm run check:apis
 * Reads .env.local. Prints PASS / FAIL / SKIP per integration; never prints secrets.
 */
import { googlePlaces } from "../lib/places";
import { runPageSpeed } from "../lib/pagespeed";
import { googleSheets } from "../lib/sheets";
import { SupabaseStore } from "../lib/store/supabase";

type Result = "PASS" | "FAIL" | "SKIP";
const results: [string, Result, string][] = [];
const run = async (name: string, enabled: boolean, why: string, fn: () => Promise<string>) => {
  if (!enabled) return results.push([name, "SKIP", why]);
  try {
    results.push([name, "PASS", await fn()]);
  } catch (err) {
    results.push([name, "FAIL", (err as Error).message]);
  }
};

async function main() {
await run("Google Places API (New)", googlePlaces.configured, "GOOGLE_PLACES_API_KEY not set", async () => {
  const page = await googlePlaces.search("car detailing in Austin, Texas, United States", "US", null);
  const p = page.places[0];
  return `${page.places.length} results; first: ${p?.name ?? "-"} (${p?.rating ?? "?"}★, ${p?.reviews ?? 0} reviews)`;
});

await run("PageSpeed Insights API", Boolean(process.env.PAGESPEED_API_KEY), "PAGESPEED_API_KEY not set", async () => {
  const r = await runPageSpeed("https://www.google.com/", "mobile");
  if (r.score === null) throw new Error(r.error || "no score");
  return `mobile score for google.com: ${r.score}`;
});

await run("Google Sheets", googleSheets.configured, "GOOGLE_SHEET_ID / GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY not set", async () => {
  const data = await googleSheets.readAll(); // also creates the tab + header row if missing
  return `tab "${process.env.GOOGLE_SHEET_TAB || "Leads"}" ok — ${data.rows.length} existing rows, ${data.headers.length} columns`;
});

await run(
  "Supabase",
  Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
  "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (local file store will be used)",
  async () => {
    const store = new SupabaseStore(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
    await store.getBatch("WN-00000000-0000-0000");
    const a = await store.tryLock("webnest-selftest", "holder-a", 30);
    const b = await store.tryLock("webnest-selftest", "holder-b", 30);
    await store.releaseLock("webnest-selftest", "holder-a");
    if (!a || b) throw new Error("lock function did not behave atomically — re-run supabase/schema.sql");
    return "tables reachable, lock function works";
  },
);

for (const [name, res, detail] of results) console.log(`${res.padEnd(4)}  ${name} — ${detail}`);
process.exitCode = results.some((r) => r[1] === "FAIL") ? 1 : 0;
}

main();
