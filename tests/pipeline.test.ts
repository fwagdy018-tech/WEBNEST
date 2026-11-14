import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuditResult } from "../lib/audit";
import { createSearch, resetSheetCache, runStep, type Deps } from "../lib/pipeline";
import type { PlaceResult, PlacesClient } from "../lib/places";
import type { Rect } from "../lib/types";
import type { CellUpdate, SheetClient, SheetData } from "../lib/sheets";
import { FileStore } from "../lib/store/file";
import { SHEET_COLUMNS } from "../lib/columns";

const place = (i: number, o: Partial<PlaceResult> = {}): PlaceResult => ({
  id: `place-${i}`, name: `Business ${i}`, address: `${i} Main St, Austin, TX 78701, USA`, city: "Austin", regionCode: "TX",
  regionName: "Texas", countryCode: "US", phone: `+1 512-555-${String(1000 + i)}`, rating: 4.5, reviews: 40,
  website: i % 2 ? `https://business${i}.com` : "", mapsUrl: `https://maps.google.com/?cid=${i}`, businessStatus: "OPERATIONAL", ...o,
});

class FakePlaces implements PlacesClient {
  configured = true;
  constructor(private pages: PlaceResult[][]) {}
  async locate(): Promise<Rect> {
    return { low: { latitude: 30, longitude: -98 }, high: { latitude: 31, longitude: -97 } };
  }
  async search(_q: string, _r: string, token: string | null) {
    const i = token ? Number(token) : 0;
    return { places: this.pages[i] ?? [], nextPageToken: i + 1 < this.pages.length ? String(i + 1) : null };
  }
}

class FakeSheet implements SheetClient {
  configured = true;
  url = "https://docs.google.com/spreadsheets/d/test/edit";
  headers: string[] = [];
  rows: string[][] = [];
  appendCalls = 0;
  constructor(initial: Record<string, string>[] = []) {
    if (initial.length) {
      this.headers = ["Business Name", "Phone", "Email", "City", "State / Province", "Country", "Website URL", "My Notes"];
      this.rows = initial.map((r) => this.headers.map((h) => r[h] ?? ""));
    }
  }
  async readAll(): Promise<SheetData> {
    await new Promise((r) => setTimeout(r, 5));
    for (const c of SHEET_COLUMNS) if (!this.headers.includes(c)) this.headers.push(c);
    return { headers: [...this.headers], rows: this.rows.map((r) => [...r]) };
  }
  async append(rows: (string | number)[][]) {
    await new Promise((r) => setTimeout(r, 20)); // widen the race window
    this.appendCalls++;
    this.rows.push(...rows.map((r) => r.map(String)));
  }
  async updateCells(updates: CellUpdate[]) {
    for (const u of updates) {
      const row = this.rows[u.row - 2];
      while (row.length <= u.col) row.push("");
      row[u.col] = String(u.value);
    }
  }
  col(name: string) {
    return this.headers.indexOf(name);
  }
}

const fakeAudit = async (url: string): Promise<AuditResult> => {
  const n = Number(url.match(/business(\d+)/)?.[1] ?? 0);
  const quality = n % 4 === 1 ? "Outdated" : "Good"; // 1,5,9.. outdated; 3,7,11.. good
  return { websiteStatus: "Accessible", websiteQuality: quality, mobileScore: 40, desktopScore: 70, email: `info@business${n}.com`, notes: ["test"] };
};

function deps(places: PlacesClient, sheets: SheetClient, store = new FileStore(null)): Deps {
  return { store, places, sheets, audit: fakeAudit, now: () => new Date("2026-11-14T12:00:00Z") };
}

async function runToEnd(id: string, d: Deps) {
  for (let i = 0; i < 200; i++) {
    const s = await runStep(id, d);
    if (s!.stage === "done" || s!.stage === "failed") return s!;
    if (/^Waiting/.test(s!.message)) await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("did not finish");
}

const params = {
  category: "Car Detailing", country: "US", region: "TX", areas: ["Austin"], minRating: 4.0, minReviews: 15,
  conditions: ["no_website", "outdated", "poor", "broken"], targetLeads: 50, skipAudit: false,
};

test("full workflow: filters, duplicates, safe merges, new rows", async () => {
  resetSheetCache();
  const pages = [
    [place(1), place(2), place(3), place(4, { rating: 3.2 }), place(5, { reviews: 3 })],
    [place(6, { regionCode: "OK" }), place(7), place(8), place(9), place(10, { businessStatus: "CLOSED_PERMANENTLY" })],
  ];
  const sheet = new FakeSheet([
    // Existing row for Business 2 (different phone formatting) with a hand-edited name and an empty email.
    { "Business Name": "Business 2 (called, follow up)", Phone: "(512) 555-1002", Email: "", City: "Austin", "State / Province": "TX", Country: "United States", "My Notes": "keep me" },
  ]);
  const d = deps(new FakePlaces(pages), sheet);
  const created = await createSearch(params, d);
  const s = await runToEnd(created.id, d);

  assert.equal(s.stage, "done");
  assert.equal(s.summary.discovered, 10);
  assert.equal(s.summary.matchingFilters, 6); // 1,2,3,7,8,9 (4,5,6,10 filtered)
  // 2 is a duplicate. New: 1 (outdated), 8 (no website), 9 (outdated). 3 & 7 have "good" sites -> rejected.
  assert.equal(s.summary.duplicatesSkipped, 1);
  assert.equal(s.summary.added, 3);
  assert.equal(s.summary.rejectedCondition, 2);
  assert.equal(sheet.rows.length, 4);

  const dupRow = sheet.rows[0];
  assert.equal(dupRow[sheet.col("Business Name")], "Business 2 (called, follow up)"); // not overwritten
  assert.equal(dupRow[sheet.col("My Notes")], "keep me");
  assert.equal(dupRow[sheet.col("Google Maps Link")], "https://maps.google.com/?cid=2"); // missing field filled
  assert.equal(dupRow[sheet.col("Last Seen Batch ID")], created.id);
  assert.equal(dupRow[sheet.col("Search Batch ID")], ""); // first-discovery info untouched

  const names = sheet.rows.slice(1).map((r) => r[sheet.col("Business Name")]).sort();
  assert.deepEqual(names, ["Business 1", "Business 8", "Business 9"]);
  const b8 = sheet.rows.find((r) => r[sheet.col("Business Name")] === "Business 8")!;
  assert.equal(b8[sheet.col("Website Status")], "No website found");
  assert.equal(b8[sheet.col("Email")], ""); // never invented
  const b1 = sheet.rows.find((r) => r[sheet.col("Business Name")] === "Business 1")!;
  assert.equal(b1[sheet.col("Mobile PageSpeed")], "40");
  assert.equal(b1[sheet.col("Search Batch ID")], created.id);
  assert.equal(b1[sheet.col("Data Source")], "Google Places API (New)");

  // Running the same search again adds nothing new.
  resetSheetCache();
  const again = await createSearch(params, d);
  const s2 = await runToEnd(again.id, d);
  assert.equal(s2.summary.added, 0);
  assert.equal(s2.summary.duplicatesSkipped, 4);
  assert.equal(sheet.rows.length, 4);
});

test("target number of leads is respected", async () => {
  resetSheetCache();
  const many = Array.from({ length: 20 }, (_, i) => place(100 + i * 2)); // all without website
  const sheet = new FakeSheet();
  const d = deps(new FakePlaces([many]), sheet);
  const created = await createSearch({ ...params, targetLeads: 5 }, d);
  const s = await runToEnd(created.id, d);
  assert.equal(s.summary.added, 5);
  assert.equal(sheet.rows.length, 5);
});

test("two concurrent searches never create duplicate rows", async () => {
  resetSheetCache();
  const shared = [place(2), place(4), place(6), place(8)]; // no websites -> all qualify
  const sheet = new FakeSheet();
  const store = new FileStore(null); // shared store == shared lock (Supabase in production)
  const d1 = deps(new FakePlaces([shared]), sheet, store);
  const d2 = deps(new FakePlaces([[...shared].reverse()]), sheet, store);
  const [a, b] = await Promise.all([createSearch(params, d1), createSearch(params, d2)]);
  const [sa, sb] = await Promise.all([runToEnd(a.id, d1), runToEnd(b.id, d2)]);
  assert.equal(sheet.rows.length, 4, "each business appears exactly once");
  assert.equal(sa.summary.added + sb.summary.added, 4);
});

test("CSV fallback when Sheets is not configured", async () => {
  resetSheetCache();
  const sheet = new FakeSheet();
  sheet.configured = false;
  const d = deps(new FakePlaces([[place(2), place(4)]]), sheet);
  const created = await createSearch(params, d);
  assert.equal(created.exportMode, "csv");
  const s = await runToEnd(created.id, d);
  assert.equal(s.summary.added, 0);
  assert.equal(s.summary.qualified, 2);
  assert.match(s.message, /not configured/);
  const { batchCsv } = await import("../lib/pipeline");
  const csv = (await batchCsv(created.id, d))!;
  assert.equal(csv.trim().split("\r\n").length, 3);
});

test("temporary API failures are retried and do not lose results", async () => {
  resetSheetCache();
  let calls = 0;
  const flaky: PlacesClient = {
    configured: true,
    async locate() {
      return null; // also exercises the plain text-search fallback
    },
    async search() {
      calls++;
      if (calls === 1) throw new Error("503 backend unavailable");
      return { places: [place(2)], nextPageToken: null };
    },
  };
  const sheet = new FakeSheet();
  const d = deps(flaky, sheet);
  const created = await createSearch(params, d);
  await runStep(created.id, d); // step 1: locate area (falls back to text search)
  const failed = await runStep(created.id, d); // step 2: search hits the simulated outage
  assert.match(failed!.message, /Temporary problem/);
  const s = await runToEnd(created.id, d);
  assert.equal(s.summary.added, 1);
});

/** Fake Google with businesses at fixed coordinates; like the real API, each search returns at most 60. */
class GridPlaces implements PlacesClient {
  configured = true;
  requests = 0;
  points: { p: PlaceResult; lat: number; lng: number }[] = [];
  constructor(n: number) {
    for (let i = 0; i < n; i++) {
      // Clustered: half the businesses packed in one small "downtown" corner.
      const dense = i % 2 === 0;
      const lat = dense ? 30.1 + (i % 17) * 0.004 : 30 + ((i * 37) % 100) / 100;
      const lng = dense ? -97.9 + (i % 13) * 0.005 : -98 + ((i * 53) % 100) / 100;
      this.points.push({ p: place(1000 + i, { website: i % 3 ? `https://business${1000 + i}.com` : "" }), lat, lng });
    }
  }
  async locate(): Promise<Rect> {
    return { low: { latitude: 30, longitude: -98 }, high: { latitude: 31, longitude: -97 } };
  }
  async search(_q: string, _r: string, token: string | null, rect?: Rect) {
    this.requests++;
    const inside = this.points
      .filter((x) => !rect || (x.lat >= rect.low.latitude && x.lat < rect.high.latitude && x.lng >= rect.low.longitude && x.lng < rect.high.longitude))
      .slice(0, 60)
      .map((x) => x.p);
    const start = token ? Number(token) : 0;
    const next = start + 20 < inside.length ? String(start + 20) : null;
    return { places: inside.slice(start, start + 20), nextPageToken: next };
  }
}

test("whole-state grid search finds far more than 60 businesses and exports all of them", async () => {
  resetSheetCache();
  const google = new GridPlaces(300);
  const sheet = new FakeSheet();
  const d = deps(google, sheet);
  const created = await createSearch({ ...params, areas: [], targetLeads: 0, skipAudit: true, conditions: [] }, d);
  let s = created;
  for (let i = 0; i < 5000 && s.stage !== "done" && s.stage !== "failed"; i++) s = (await runStep(created.id, d))!;
  assert.equal(s.stage, "done");
  assert.equal(s.summary.discovered, 300, "every business found despite the 60-per-search cap");
  assert.equal(s.summary.added, 300);
  assert.equal(sheet.rows.length, 300);
  assert.ok(s.coverage.areasTotal > 5, "dense areas were split into smaller tiles");
  const statuses = new Set(sheet.rows.map((r) => r[sheet.col("Website Status")]));
  assert.deepEqual([...statuses].sort(), ["No website found", "Not verified"]);
});

test("manual-review mode exports businesses with good websites too", async () => {
  resetSheetCache();
  const sheet = new FakeSheet();
  const d = deps(new FakePlaces([[place(3), place(7), place(8)]]), sheet); // 3 and 7 would audit as "Good"
  const created = await createSearch({ ...params, skipAudit: true, conditions: [] }, d);
  const s = await runToEnd(created.id, d);
  assert.equal(s.summary.added, 3);
});
