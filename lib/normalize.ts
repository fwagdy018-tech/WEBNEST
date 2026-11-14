import { parsePhoneNumberFromString, type CountryCode as PhoneCountry } from "libphonenumber-js";
import { regionKey } from "./locations";

/** Normalize a phone number to E.164 (e.g. "+15125550100"). Returns "" if unusable. */
export function normalizePhone(raw: string, defaultCountry: string = "US"): string {
  if (!raw) return "";
  const cleaned = String(raw).trim();
  const parsed = parsePhoneNumberFromString(cleaned, defaultCountry as PhoneCountry);
  if (parsed?.isPossible()) return parsed.number;
  const digits = cleaned.replace(/\D/g, "");
  return digits.length >= 7 ? digits : "";
}

/**
 * Hosts shared by many businesses (social profiles, link-in-bio, site builders'
 * shared domains). For these, the path identifies the business, not the host.
 */
const SHARED_HOSTS = [
  "facebook.com", "fb.com", "instagram.com", "linktr.ee", "linkin.bio", "twitter.com", "x.com",
  "tiktok.com", "youtube.com", "yelp.com", "yelp.ca", "yelp.com.au", "google.com", "goo.gl",
  "g.page", "business.site", "sites.google.com", "booksy.com", "vagaro.com", "square.site",
  "squareup.com", "fresha.com", "styleseat.com", "schedulicity.com", "setmore.com", "linkedin.com",
  "wixsite.com", "weebly.com", "godaddysites.com", "wordpress.com", "blogspot.com", "carrd.co",
  "ubereats.com", "doordash.com", "grubhub.com", "toasttab.com", "order.online", "menufy.com",
];

function isSharedHost(host: string): boolean {
  return SHARED_HOSTS.some((h) => host === h || host.endsWith("." + h));
}

/** Parse a user/website URL string leniently. */
export function parseLooseUrl(raw: string): URL | null {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname.includes(".")) return null;
    return u;
  } catch {
    return null;
  }
}

/**
 * Website identity key: the registrable-ish host without "www."/"m.",
 * or host + path for shared platforms (facebook.com/joesdetailing).
 */
export function normalizeWebsite(raw: string): string {
  const u = parseLooseUrl(raw);
  if (!u) return "";
  const host = u.hostname.toLowerCase().replace(/^(www\d?|m)\./, "");
  if (isSharedHost(host)) {
    const path = u.pathname.toLowerCase().replace(/\/+$/, "");
    return path && path !== "/" ? host + path : "";
  }
  return host;
}

const NAME_STOPWORDS = new Set([
  "the", "llc", "inc", "ltd", "pty", "co", "corp", "corporation", "company", "limited", "plc", "lp", "llp",
]);

export function normalizeName(raw: string): string {
  return String(raw || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !NAME_STOPWORDS.has(w))
    .join(" ");
}

const ADDRESS_ABBREVIATIONS: Record<string, string> = {
  street: "st", avenue: "ave", road: "rd", boulevard: "blvd", drive: "dr", lane: "ln", court: "ct",
  place: "pl", highway: "hwy", parkway: "pkwy", suite: "ste", unit: "unit", north: "n", south: "s",
  east: "e", west: "w", terrace: "tce", crescent: "cres", circle: "cir", square: "sq", apartment: "apt",
  floor: "fl", building: "bldg", parade: "pde", close: "cl",
};
const ADDRESS_DROP = new Set(["usa", "us", "united", "states", "america", "canada", "australia"]);

export function normalizeAddress(raw: string): string {
  return String(raw || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/#/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => ADDRESS_ABBREVIATIONS[w] ?? w)
    .filter((w) => !ADDRESS_DROP.has(w))
    .join(" ");
}

export function normalizeCity(raw: string): string {
  return normalizeName(raw);
}

export function normalizeRegion(raw: string): string {
  return regionKey(String(raw || ""));
}
