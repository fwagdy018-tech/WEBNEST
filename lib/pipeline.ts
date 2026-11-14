/**
 * Search pipeline as a resumable state machine. Each call to runStep() does a
 * small, bounded amount of work and persists everything, so a crash, timeout
 * or closed browser tab never loses collected results.
 *
 *   searching: discover one Places page  OR  duplicate-check + audit a few candidates
 *   exporting: under a global lock, re-read the whole sheet, dedupe, update/append
 *   done / failed
 */
import { randomBytes, randomUUID } from "node:crypto";
import { auditWebsite, type AuditResult } from "./audit";
import { categoryQuery } from "./categories";
import { leadToRecord, SHEET_COLUMNS, type SheetColumn, type SheetRecord } from "./columns";
import { computeFills, DedupeIndex, identityKeys, MATCH_LABELS } from "./dedupe";
import { PermanentError } from "./http";
import { getCountry, getRegion } from "./locations";
import { googlePlaces, type PlaceResult, type PlacesClient } from "./places";
import { googleSheets, type CellUpdate, type SheetClient, type SheetData } from "./sheets";
import { getStore, type Store } from "./store";
import type {
  Batch, BatchStatus, BatchSummary, Candidate, CountryCode, DiscoveryQuery, Lead, Rect, SearchParams, WebsiteCondition,
} from "./types";

export interface Deps {
  store: Store;
  places: PlacesClient;
  sheets: SheetClient;
  audit: (url: string) => Promise<AuditResult>;
  now: () => Date;
}

export function defaultDeps(): Deps {
  return { store: getStore(), places: googlePlaces, sheets: googleSheets, audit: auditWebsite, now: () => new Date() };
}

const AUDIT_CONCURRENCY = 4;
const PENDING_BUFFER = 4;
const MAX_PAGES_PER_QUERY = 3; // Places Text Search returns at most 60 results per query
/** A map tile that returns at least one full page is split into 4 smaller tiles. */
const SPLIT_THRESHOLD = 20;
const MIN_TILE_DEGREES = 0.02; // ~2 km — tiles are not split below this
const MAX_TILE_DEPTH = 12;
/** Safety cap on billed Places requests per search (override with MAX_PLACES_REQUESTS_PER_SEARCH). */
const maxPlacesRequests = () => Number(process.env.MAX_PLACES_REQUESTS_PER_SEARCH) || 5000;
const MAX_ERROR_STREAK = 5;
const BATCH_LOCK_TTL = 300;
const EXPORT_LOCK = "sheet-export";
const EXPORT_LOCK_TTL = 300;

export const PHASES = {
  searching: "Searching for businesses",
  collecting: "Collecting business information",
  duplicates: "Checking for duplicates",
  auditing: "Auditing websites",
  exporting: "Exporting new leads to Google Sheets",
  done: "Finished",
} as const;

const ALL_CONDITIONS: WebsiteCondition[] = ["no_website", "outdated", "poor", "broken", "unverified", "good"];

// ---------------------------------------------------------------- params

export function validateParams(input: unknown): SearchParams {
  const p = (input ?? {}) as Record<string, unknown>;
  const fail = (m: string): never => {
    throw new Error(m);
  };
  const category = typeof p.category === "string" ? p.category.trim().slice(0, 80) : "";
  if (!category) fail("Choose a business category.");
  const country = String(p.country ?? "") as CountryCode;
  if (!getCountry(country)) fail("Choose a country (United States, Canada or Australia).");
  const region = String(p.region ?? "");
  if (!getRegion(country, region)) fail("Choose a state / province.");
  const areas = (Array.isArray(p.areas) ? p.areas : String(p.areas ?? "").split(","))
    .map((a) => String(a).trim().slice(0, 80))
    .filter(Boolean)
    .slice(0, 10);
  const minRating = Number(p.minRating ?? 0);
  if (!(minRating >= 0 && minRating <= 5)) fail("Minimum rating must be between 0 and 5.");
  const minReviews = Math.floor(Number(p.minReviews ?? 0));
  if (!(minReviews >= 0 && minReviews <= 100_000)) fail("Minimum reviews must be 0 or more.");
  const skipAudit = p.skipAudit === true;
  const conditions = (Array.isArray(p.conditions) ? p.conditions : []).filter((c): c is WebsiteCondition =>
    ALL_CONDITIONS.includes(c as WebsiteCondition),
  );
  if (!conditions.length && !skipAudit) fail("Select at least one website condition.");
  const targetLeads = Math.floor(Number(p.targetLeads ?? 0));
  if (!(targetLeads >= 0 && targetLeads <= 100_000)) fail("Number of leads must be 0 (all) or more.");
  return { category, country, region, areas, minRating, minReviews, conditions: [...new Set(conditions)], targetLeads, skipAudit };
}

/** Each area (or the whole state) is first resolved to its map boundary, then searched as a grid. */
function buildQueries(p: SearchParams): DiscoveryQuery[] {
  const country = getCountry(p.country)!;
  const region = getRegion(p.country, p.region)!;
  const places = p.areas.length ? p.areas.map((a) => `${a}, ${region.name}`) : [region.name];
  return places.map((where) => ({ kind: "area", text: `${where}, ${country.name}`, pageToken: null, pages: 0, done: false }));
}

/** Split a viewport that crosses the antimeridian (e.g. Alaska) into two rectangles. */
function normalizeRect(r: Rect): Rect[] {
  if (r.low.longitude <= r.high.longitude) return [r];
  return [
    { low: r.low, high: { latitude: r.high.latitude, longitude: 180 } },
    { low: { latitude: r.low.latitude, longitude: -180 }, high: r.high },
  ];
}

function splitRect(r: Rect): Rect[] {
  const midLat = (r.low.latitude + r.high.latitude) / 2;
  const midLng = (r.low.longitude + r.high.longitude) / 2;
  const box = (a: number, b: number, c: number, d: number): Rect => ({ low: { latitude: a, longitude: b }, high: { latitude: c, longitude: d } });
  return [
    box(r.low.latitude, r.low.longitude, midLat, midLng),
    box(r.low.latitude, midLng, midLat, r.high.longitude),
    box(midLat, r.low.longitude, r.high.latitude, midLng),
    box(midLat, midLng, r.high.latitude, r.high.longitude),
  ];
}

const canSplit = (r: Rect, depth: number) =>
  depth < MAX_TILE_DEPTH &&
  (r.high.latitude - r.low.latitude > MIN_TILE_DEGREES || r.high.longitude - r.low.longitude > MIN_TILE_DEGREES);

const tile = (text: string, rect: Rect, depth: number): DiscoveryQuery => ({
  kind: "tile", text, rect, depth, count: 0, pageToken: null, pages: 0, done: false,
});

// ---------------------------------------------------------------- helpers

const ymd = (d: Date) => d.toISOString().slice(0, 10);

function newBatchId(now: Date): string {
  const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, "").replace(/^(\d{8})(\d{4})$/, "$1-$2");
  return `WN-${stamp}-${randomBytes(2).toString("hex").toUpperCase()}`;
}

function leadFromPlace(p: PlaceResult, batchId: string, now: Date): Lead {
  return {
    placeId: p.id,
    name: p.name,
    phone: p.phone,
    email: "",
    address: p.address,
    city: p.city,
    region: p.regionCode,
    country: getCountry(p.countryCode)?.name ?? p.countryCode,
    rating: p.rating,
    reviews: p.reviews,
    websiteUrl: p.website,
    websiteStatus: "",
    mobileScore: null,
    desktopScore: null,
    websiteQuality: "",
    mapsUrl: p.mapsUrl,
    dataSource: "Google Places API (New)",
    sourceUrl: p.mapsUrl,
    dateFound: ymd(now),
    batchId,
    auditNotes: "",
  };
}

function filterReason(p: PlaceResult, params: SearchParams): string {
  if (p.businessStatus && p.businessStatus !== "OPERATIONAL") return `Not operational (${p.businessStatus})`;
  if (p.countryCode && p.countryCode !== params.country) return "Outside selected country";
  if (p.regionCode.toUpperCase() !== params.region.toUpperCase()) return "Outside selected state/province";
  if (p.rating === null) return "No Google rating";
  if (p.rating < params.minRating) return `Rating ${p.rating} below ${params.minRating}`;
  if ((p.reviews ?? 0) < params.minReviews) return `${p.reviews ?? 0} reviews below ${params.minReviews}`;
  return "";
}

export function conditionOf(lead: Lead): WebsiteCondition {
  if (lead.websiteStatus === "No website found") return "no_website";
  switch (lead.websiteQuality) {
    case "Broken / Inaccessible":
      return "broken";
    case "Outdated":
      return "outdated";
    case "Poor":
      return "poor";
    case "Good":
      return "good";
    default:
      return "unverified";
  }
}

function headerIndex(headers: string[]): Map<SheetColumn, number> {
  const m = new Map<SheetColumn, number>();
  for (const col of SHEET_COLUMNS) {
    const i = headers.findIndex((h) => h.trim().toLowerCase() === col.toLowerCase());
    if (i >= 0) m.set(col, i);
  }
  return m;
}

function rowToRecord(row: string[], idx: Map<SheetColumn, number>): SheetRecord {
  const rec: SheetRecord = {};
  for (const [col, i] of idx) rec[col] = row[i] ?? "";
  return rec;
}

function recordToRow(rec: SheetRecord, headers: string[], idx: Map<SheetColumn, number>): (string | number)[] {
  const row: (string | number)[] = headers.map(() => "");
  for (const [col, i] of idx) row[i] = rec[col] ?? "";
  return row;
}

// Short-lived cache of the sheet index for the pre-audit duplicate check
// (the export step always re-reads the sheet under the lock).
let sheetIndexCache: { at: number; index: DedupeIndex<number> } | null = null;

async function cachedSheetIndex(sheets: SheetClient): Promise<DedupeIndex<number>> {
  if (sheetIndexCache && Date.now() - sheetIndexCache.at < 30_000) return sheetIndexCache.index;
  const data = await sheets.readAll();
  const idx = headerIndex(data.headers);
  const index = new DedupeIndex<number>();
  data.rows.forEach((row, i) => index.add(identityKeys(rowToRecord(row, idx)), i + 2));
  sheetIndexCache = { at: Date.now(), index };
  return index;
}

export function resetSheetCache() {
  sheetIndexCache = null;
}

// ---------------------------------------------------------------- status

export function summarize(cands: Candidate[]): BatchSummary {
  const count = (...states: Candidate["state"][]) => cands.filter((c) => states.includes(c.state)).length;
  return {
    discovered: cands.length,
    matchingFilters: cands.length - count("filtered_out"),
    qualified: count("qualified", "exported", "surplus"),
    duplicatesSkipped: count("duplicate", "merged", "dup_unchanged"),
    updated: count("merged"),
    added: count("exported"),
    unverified: cands.filter((c) => c.state !== "filtered_out" && (c.state === "error" || c.lead.websiteQuality === "Unverified")).length,
    rejectedCondition: count("rejected"),
    auditErrors: count("error"),
  };
}

export async function getStatus(id: string, deps: Deps): Promise<BatchStatus | null> {
  const batch = await deps.store.getBatch(id);
  if (!batch) return null;
  const cands = await deps.store.listCandidates(id);
  return {
    id: batch.id,
    stage: batch.stage,
    phase: batch.phase,
    message: batch.message,
    error: batch.error,
    params: batch.params,
    exportMode: batch.exportMode,
    sheetUrl: batch.exportMode === "sheets" ? deps.sheets.url : null,
    createdAt: batch.createdAt,
    summary: summarize(cands),
    coverage: {
      areasDone: batch.cursor.queries.filter((q) => q.done).length,
      areasTotal: batch.cursor.queries.length,
      placesRequests: batch.cursor.placesRequests ?? 0,
    },
  };
}

// ---------------------------------------------------------------- create / resume

export async function createSearch(input: unknown, deps: Deps): Promise<BatchStatus> {
  const params = validateParams(input);
  if (!deps.places.configured) throw new PermanentError("GOOGLE_PLACES_API_KEY is not configured — see README setup.");
  const now = deps.now();
  const batch: Batch = {
    id: newBatchId(now),
    params,
    stage: "searching",
    phase: PHASES.searching,
    cursor: { queries: buildQueries(params), errorStreak: 0 },
    exportMode: deps.sheets.configured ? "sheets" : "csv",
    message: "",
    error: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  await deps.store.createBatch(batch);
  return (await getStatus(batch.id, deps))!;
}

export async function resumeSearch(id: string, deps: Deps): Promise<BatchStatus | null> {
  const batch = await deps.store.getBatch(id);
  if (!batch) return null;
  if (batch.stage === "failed") {
    const stage = batch.cursor.failedStage ?? "searching";
    await deps.store.updateBatch(id, {
      stage,
      phase: stage === "exporting" ? PHASES.exporting : PHASES.searching,
      error: null,
      message: "Resumed",
      cursor: { ...batch.cursor, errorStreak: 0, failedStage: undefined },
    });
  }
  return getStatus(id, deps);
}

// ---------------------------------------------------------------- step

export async function runStep(id: string, deps: Deps): Promise<BatchStatus | null> {
  const batch = await deps.store.getBatch(id);
  if (!batch) return null;
  if (batch.stage === "done" || batch.stage === "failed") return getStatus(id, deps);

  const holder = randomUUID();
  const lockName = `batch:${id}`;
  if (!(await deps.store.tryLock(lockName, holder, BATCH_LOCK_TTL))) {
    return getStatus(id, deps); // another tab/request is already working on this batch
  }
  try {
    if (batch.stage === "searching") await searchStep(batch, deps);
    else if (batch.stage === "exporting") await exportStep(batch, deps);
    const fresh = await deps.store.getBatch(id);
    if (fresh && fresh.cursor.errorStreak) await deps.store.updateBatch(id, { cursor: { ...fresh.cursor, errorStreak: 0 } });
  } catch (err) {
    const msg = (err as Error).message || String(err);
    const fresh = (await deps.store.getBatch(id)) ?? batch;
    const streak = (fresh.cursor.errorStreak ?? 0) + 1;
    if (err instanceof PermanentError || streak >= MAX_ERROR_STREAK) {
      await deps.store.updateBatch(id, {
        stage: "failed",
        error: msg,
        message: "Search paused. Collected results are saved — fix the problem and press Resume.",
        cursor: { ...fresh.cursor, errorStreak: streak, failedStage: fresh.stage },
      });
    } else {
      await deps.store.updateBatch(id, {
        message: `Temporary problem (${msg}). Retrying…`,
        cursor: { ...fresh.cursor, errorStreak: streak },
      });
    }
  } finally {
    await deps.store.releaseLock(lockName, holder).catch(() => {});
  }
  return getStatus(id, deps);
}

async function searchStep(batch: Batch, deps: Deps) {
  const { store } = deps;
  const params = batch.params;
  const cands = await store.listCandidates(batch.id);
  const target = params.targetLeads > 0 ? params.targetLeads : Infinity;
  let qualified = cands.filter((c) => c.state === "qualified").length;
  const pending = cands.filter((c) => c.state === "pending");
  const cursor = batch.cursor;
  let nextQuery = cursor.queries.find((q) => !q.done);

  if (nextQuery && (cursor.placesRequests ?? 0) >= maxPlacesRequests()) {
    for (const q of cursor.queries) q.done = true;
    nextQuery = undefined;
    await store.updateBatch(batch.id, {
      cursor,
      message: `Stopped searching after ${maxPlacesRequests()} Places requests (safety limit MAX_PLACES_REQUESTS_PER_SEARCH). `,
    });
    batch.message = `Stopped searching after ${maxPlacesRequests()} Places requests (safety limit MAX_PLACES_REQUESTS_PER_SEARCH).`;
  }

  if (qualified >= target || (!pending.length && !nextQuery)) {
    const short = Number.isFinite(target) && qualified < target;
    await store.updateBatch(batch.id, {
      stage: "exporting",
      phase: PHASES.exporting,
      message: [
        batch.message.startsWith("Stopped") ? batch.message : "",
        short ? `Found ${qualified} of ${params.targetLeads} requested leads — every map area was searched and Google returned no more matching businesses.` : "",
      ].filter(Boolean).join(" "),
    });
    return;
  }

  // 1) Discover: fetch the next page of results when the audit queue runs low.
  if (pending.length < PENDING_BUFFER && nextQuery) {
    cursor.placesRequests = (cursor.placesRequests ?? 0) + 1;
    const what = categoryQuery(params.category);

    if (nextQuery.kind === "area") {
      await store.updateBatch(batch.id, { phase: PHASES.searching, message: `Locating ${nextQuery.text} on the map` });
      const rect = await deps.places.locate(nextQuery.text, params.country);
      nextQuery.done = true;
      if (rect) cursor.queries.push(...normalizeRect(rect).map((r) => tile(what, r, 0)));
      else cursor.queries.push({ kind: "text", text: `${what} in ${nextQuery.text}`, pageToken: null, pages: 0, done: false });
      await store.updateBatch(batch.id, { cursor, message: "" });
      return;
    }

    const done = cursor.queries.filter((q) => q.done).length;
    await store.updateBatch(batch.id, {
      phase: PHASES.searching,
      message: `Searching map area ${done + 1} of ${cursor.queries.length} (page ${nextQuery.pages + 1})`,
    });
    const page = await deps.places.search(nextQuery.text, params.country, nextQuery.pageToken, nextQuery.rect);
    const now = deps.now();
    const newCands: Candidate[] = page.places
      .filter((p) => p.id)
      .map((p) => {
        const reason = filterReason(p, params);
        return { batchId: batch.id, placeId: p.id, state: reason ? "filtered_out" : "pending", lead: leadFromPlace(p, batch.id, now), reason, attempts: 0 };
      });
    await store.updateBatch(batch.id, { phase: PHASES.collecting });
    await store.insertCandidates(newCands);
    nextQuery.pages += 1;
    nextQuery.count = (nextQuery.count ?? 0) + page.places.length;
    nextQuery.pageToken = page.nextPageToken;
    nextQuery.done = !page.nextPageToken || nextQuery.pages >= MAX_PAGES_PER_QUERY;
    // Dense area: Google may be hiding results beyond what it returned, so search 4 smaller tiles.
    if (nextQuery.done && nextQuery.kind === "tile" && nextQuery.rect && (nextQuery.count ?? 0) >= SPLIT_THRESHOLD) {
      const depth = nextQuery.depth ?? 0;
      if (canSplit(nextQuery.rect, depth)) cursor.queries.push(...splitRect(nextQuery.rect).map((r) => tile(nextQuery!.text, r, depth + 1)));
    }
    await store.updateBatch(batch.id, { cursor, message: "" });
    return;
  }

  // 2) Duplicate pre-check against the sheet (saves audits/quota on known businesses).
  const slice = pending.slice(0, params.skipAudit ? 200 : AUDIT_CONCURRENCY * 2);
  const changed: Candidate[] = [];
  if (deps.sheets.configured) {
    await store.updateBatch(batch.id, { phase: PHASES.duplicates });
    const index = await cachedSheetIndex(deps.sheets);
    for (const c of slice) {
      const hit = index.find(identityKeys(leadToRecord(c.lead)));
      if (hit) {
        c.state = "duplicate";
        c.reason = `Already in sheet (row ${hit.ref}, matched on ${MATCH_LABELS[hit.matchedOn]})`;
        changed.push(c);
      }
    }
  }

  // 3a) Manual-review mode: export everything without inspecting websites.
  if (params.skipAudit) {
    for (const c of slice.filter((c) => c.state === "pending")) {
      c.lead.websiteStatus = c.lead.websiteUrl ? "Not verified" : "No website found";
      c.lead.auditNotes = c.lead.websiteUrl
        ? "Website audit skipped (manual review mode)"
        : "No website listed by the data source (not confirmed that none exists); audit skipped";
      c.state = qualified >= target ? "surplus" : "qualified";
      if (c.state === "qualified") qualified++;
      changed.push(c);
    }
    await store.updateCandidates(changed);
    await store.updateBatch(batch.id, { message: "" });
    return;
  }

  // 3) Audit websites of new businesses.
  const toAudit = slice.filter((c) => c.state === "pending").slice(0, AUDIT_CONCURRENCY);
  if (toAudit.length) {
    await store.updateBatch(batch.id, { phase: PHASES.auditing, message: `Inspecting ${toAudit.map((c) => c.lead.name).join(", ")}` });
  }
  await Promise.all(
    toAudit.map(async (c) => {
      try {
        if (!c.lead.websiteUrl) {
          c.lead.websiteStatus = "No website found";
          c.lead.auditNotes = "No website listed by the data source (not confirmed that none exists)";
        } else {
          const r = await deps.audit(c.lead.websiteUrl);
          c.lead.websiteStatus = r.websiteStatus;
          c.lead.websiteQuality = r.websiteQuality;
          c.lead.mobileScore = r.mobileScore;
          c.lead.desktopScore = r.desktopScore;
          if (r.email) c.lead.email = r.email;
          c.lead.auditNotes = r.notes.join("; ");
        }
        c.state = "rejected"; // decided below
      } catch (err) {
        c.attempts += 1;
        c.reason = `Audit error: ${(err as Error).message}`;
        if (c.attempts >= 3) {
          c.state = "error";
          c.lead.websiteStatus = "Not verified";
          c.lead.websiteQuality = "Unverified";
          c.lead.auditNotes = c.reason;
        }
      }
    }),
  );
  for (const c of toAudit) {
    if (c.state !== "rejected") {
      changed.push(c);
      continue;
    }
    const cond = conditionOf(c.lead);
    if (params.conditions.includes(cond)) {
      c.state = qualified >= target ? "surplus" : "qualified";
      c.reason = "";
      if (c.state === "qualified") qualified++;
    } else {
      c.reason = `Website condition "${cond}" not selected`;
    }
    changed.push(c);
  }
  await store.updateCandidates(changed);
  await store.updateBatch(batch.id, { message: "" });
}

type IndexRef = { kind: "sheet"; row: number; rec: SheetRecord } | { kind: "new"; rec: SheetRecord };

async function exportStep(batch: Batch, deps: Deps) {
  const { store } = deps;
  const cands = await store.listCandidates(batch.id, ["qualified", "duplicate"]);
  const today = ymd(deps.now());

  if (batch.exportMode === "csv" || !deps.sheets.configured) {
    // No sheet to compare with: dedupe within this batch only.
    const index = new DedupeIndex<string>();
    const changed: Candidate[] = [];
    for (const c of cands.filter((c) => c.state === "qualified")) {
      const keys = identityKeys(leadToRecord(c.lead));
      const hit = index.find(keys);
      if (hit) {
        c.state = "dup_unchanged";
        c.reason = `Same business as another result in this search (${MATCH_LABELS[hit.matchedOn]})`;
        changed.push(c);
      } else index.add(keys, c.placeId);
    }
    await store.updateCandidates(changed);
    await store.updateBatch(batch.id, {
      stage: "done",
      phase: PHASES.done,
      message: [batch.message, "Google Sheets is not configured — nothing was exported. Download the CSV instead."].filter(Boolean).join(" "),
    });
    return;
  }

  const holder = randomUUID();
  if (!(await store.tryLock(EXPORT_LOCK, holder, EXPORT_LOCK_TTL))) {
    await store.updateBatch(batch.id, { message: "Waiting for another search to finish exporting…" });
    return;
  }
  try {
    await store.updateBatch(batch.id, { phase: PHASES.exporting });
    const data: SheetData = await deps.sheets.readAll(); // fresh read under the lock
    const idx = headerIndex(data.headers);
    const index = new DedupeIndex<IndexRef>();
    data.rows.forEach((row, i) => {
      const rec = rowToRecord(row, idx);
      index.add(identityKeys(rec), { kind: "sheet", row: i + 2, rec });
    });

    const updates: CellUpdate[] = [];
    const newRecords: SheetRecord[] = [];
    const changed: Candidate[] = [];

    for (const c of cands) {
      const incoming = leadToRecord(c.lead);
      const keys = identityKeys(incoming);
      const hit = index.find(keys);
      if (!hit) {
        newRecords.push(incoming);
        index.add(keys, { kind: "new", rec: incoming });
        c.state = "exported";
        c.reason = "";
        changed.push(c);
        continue;
      }
      const ref = hit.ref;
      const how = MATCH_LABELS[hit.matchedOn];
      if (ref.kind === "sheet" && String(ref.rec["Search Batch ID"] ?? "") === batch.id) {
        // Already appended by an earlier, interrupted attempt of this same export.
        c.state = "exported";
        changed.push(c);
        continue;
      }
      const fills = computeFills(ref.rec, incoming);
      Object.assign(ref.rec, fills);
      if (ref.kind === "sheet") {
        for (const [col, value] of Object.entries(fills) as [SheetColumn, string | number][]) {
          const ci = idx.get(col);
          if (ci !== undefined) updates.push({ row: ref.row, col: ci, value });
        }
        const seenDate = idx.get("Last Seen Date");
        const seenBatch = idx.get("Last Seen Batch ID");
        if (seenDate !== undefined) updates.push({ row: ref.row, col: seenDate, value: today });
        if (seenBatch !== undefined) updates.push({ row: ref.row, col: seenBatch, value: batch.id });
        c.reason = `Already in sheet (row ${ref.row}, matched on ${how})`;
      } else {
        c.reason = `Same business as another result in this search (${how})`;
      }
      const filled = Object.keys(fills);
      c.state = filled.length ? "merged" : "dup_unchanged";
      if (filled.length) c.reason += `; filled: ${filled.join(", ")}`;
      changed.push(c);
    }

    await deps.sheets.updateCells(updates);
    await deps.sheets.append(newRecords.map((r) => recordToRow(r, data.headers, idx)));
    await store.updateCandidates(changed);
    resetSheetCache();
    await store.updateBatch(batch.id, { stage: "done", phase: PHASES.done });
  } finally {
    await store.releaseLock(EXPORT_LOCK, holder).catch(() => {});
  }
}

// ---------------------------------------------------------------- CSV

const csvCell = (v: unknown) => {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function batchCsv(id: string, deps: Deps): Promise<string | null> {
  const batch = await deps.store.getBatch(id);
  if (!batch) return null;
  const cands = await deps.store.listCandidates(id, ["qualified", "exported"]);
  const lines = [SHEET_COLUMNS.map(csvCell).join(",")];
  for (const c of cands) {
    const rec = leadToRecord(c.lead);
    lines.push(SHEET_COLUMNS.map((col) => csvCell(rec[col])).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
