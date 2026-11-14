export type CountryCode = "US" | "CA" | "AU";

/** Website conditions the user can filter on. */
export type WebsiteCondition =
  | "no_website"
  | "outdated"
  | "poor"
  | "broken"
  | "unverified"
  | "good";

export interface SearchParams {
  category: string;
  country: CountryCode;
  /** State/province short code as Google returns it, e.g. "TX", "ON", "NSW". */
  region: string;
  /** Optional cities / target areas. Empty = whole state/province. */
  areas: string[];
  minRating: number;
  minReviews: number;
  conditions: WebsiteCondition[];
  /** 0 = no limit: export every business found. */
  targetLeads: number;
  /** Export every business without inspecting websites (manual review). */
  skipAudit: boolean;
}

/**
 * Website Status deliberately separates "we could not find a site" from
 * "we confirmed it is gone" and "we could not check it right now".
 */
export type WebsiteStatus =
  | "No website found"
  | "Confirmed unavailable"
  | "Inaccessible during inspection"
  | "Accessible"
  | "Not verified";

export type WebsiteQuality =
  | "Good"
  | "Poor"
  | "Outdated"
  | "Broken / Inaccessible"
  | "Unverified";

export interface Lead {
  placeId: string;
  name: string;
  phone: string;
  email: string;
  address: string;
  city: string;
  region: string;
  country: string;
  rating: number | null;
  reviews: number | null;
  websiteUrl: string;
  websiteStatus: WebsiteStatus | "";
  mobileScore: number | null;
  desktopScore: number | null;
  websiteQuality: WebsiteQuality | "";
  mapsUrl: string;
  dataSource: string;
  sourceUrl: string;
  dateFound: string;
  batchId: string;
  auditNotes: string;
}

export type CandidateState =
  | "filtered_out" // failed rating / reviews / location / operating filters
  | "pending" // passed filters, waiting for duplicate check + audit
  | "duplicate" // already in the sheet (found before audit)
  | "rejected" // website condition not among the selected ones
  | "qualified" // new lead, waiting for export
  | "surplus" // qualified after the target was reached; not exported
  | "error" // audit failed repeatedly
  | "exported" // appended as a new sheet row
  | "merged" // duplicate; filled missing fields of the existing row
  | "dup_unchanged"; // duplicate; nothing to fill

export interface Candidate {
  batchId: string;
  placeId: string;
  state: CandidateState;
  lead: Lead;
  reason: string;
  attempts: number;
}

export type BatchStage = "searching" | "exporting" | "done" | "failed";

export interface LatLng {
  latitude: number;
  longitude: number;
}

export interface Rect {
  low: LatLng;
  high: LatLng;
}

/**
 * area: resolve a state/city name to its map boundary, then grid it.
 * tile: search the category inside a map rectangle (split when saturated).
 * text: plain text search (fallback when a boundary cannot be resolved).
 */
export interface DiscoveryQuery {
  kind?: "area" | "tile" | "text";
  text: string;
  rect?: Rect;
  depth?: number;
  count?: number;
  pageToken: string | null;
  pages: number;
  done: boolean;
}

export interface BatchCursor {
  queries: DiscoveryQuery[];
  placesRequests?: number;
  errorStreak: number;
  failedStage?: BatchStage;
}

export interface Batch {
  id: string;
  params: SearchParams;
  stage: BatchStage;
  phase: string;
  cursor: BatchCursor;
  exportMode: "sheets" | "csv";
  message: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BatchSummary {
  discovered: number;
  matchingFilters: number;
  qualified: number;
  duplicatesSkipped: number;
  updated: number;
  added: number;
  unverified: number;
  rejectedCondition: number;
  auditErrors: number;
}

export interface BatchStatus {
  id: string;
  stage: BatchStage;
  phase: string;
  message: string;
  error: string | null;
  params: SearchParams;
  exportMode: "sheets" | "csv";
  sheetUrl: string | null;
  createdAt: string;
  summary: BatchSummary;
  coverage: { areasDone: number; areasTotal: number; placesRequests: number };
}
