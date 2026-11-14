import { countryCodeFrom } from "./locations";
import { NEVER_FILL, SHEET_COLUMNS, type SheetColumn, type SheetRecord } from "./columns";
import {
  normalizeAddress,
  normalizeCity,
  normalizeName,
  normalizePhone,
  normalizeRegion,
  normalizeWebsite,
} from "./normalize";

export interface IdentityKeys {
  place: string;
  phone: string;
  website: string;
  nameAddress: string;
  nameCityRegion: string;
}

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v).trim());

/** Identity keys for a sheet row or a new lead (both expressed as a SheetRecord). */
export function identityKeys(rec: SheetRecord): IdentityKeys {
  const country = countryCodeFrom(str(rec["Country"])) ?? "US";
  const name = normalizeName(str(rec["Business Name"]));
  const address = normalizeAddress(str(rec["Address"]));
  const city = normalizeCity(str(rec["City"]));
  const region = normalizeRegion(str(rec["State / Province"]));
  return {
    place: str(rec["Google Place ID"]),
    phone: normalizePhone(str(rec["Phone"]), country),
    website: normalizeWebsite(str(rec["Website URL"])),
    nameAddress: name && address ? `${name}|${address}` : "",
    nameCityRegion: name && city && region ? `${name}|${city}|${region}` : "",
  };
}

const MATCH_ORDER: (keyof IdentityKeys)[] = ["place", "phone", "website", "nameAddress", "nameCityRegion"];

export const MATCH_LABELS: Record<keyof IdentityKeys, string> = {
  place: "Google Place ID",
  phone: "phone number",
  website: "website domain",
  nameAddress: "name + address",
  nameCityRegion: "name + city + state/province",
};

/** In-memory index over all known businesses (sheet rows + rows added this run). */
export class DedupeIndex<T> {
  private maps: Record<keyof IdentityKeys, Map<string, T>> = {
    place: new Map(),
    phone: new Map(),
    website: new Map(),
    nameAddress: new Map(),
    nameCityRegion: new Map(),
  };

  add(keys: IdentityKeys, ref: T): void {
    for (const k of MATCH_ORDER) {
      if (keys[k] && !this.maps[k].has(keys[k])) this.maps[k].set(keys[k], ref);
    }
  }

  find(keys: IdentityKeys): { ref: T; matchedOn: keyof IdentityKeys } | null {
    for (const k of MATCH_ORDER) {
      const hit = keys[k] ? this.maps[k].get(keys[k]) : undefined;
      if (hit !== undefined) return { ref: hit, matchedOn: k };
    }
    return null;
  }
}

/**
 * Fields to fill on an existing row: only cells that are empty in the sheet
 * and non-empty in the new record. Existing (possibly hand-edited) values are
 * never overwritten.
 */
export function computeFills(existing: SheetRecord, incoming: SheetRecord): SheetRecord {
  const fills: SheetRecord = {};
  for (const col of SHEET_COLUMNS as readonly SheetColumn[]) {
    if (NEVER_FILL.includes(col)) continue;
    const newVal = incoming[col];
    if (str(newVal) === "") continue;
    if (str(existing[col]) !== "") continue;
    fills[col] = newVal;
  }
  return fills;
}
