/**
 * Business discovery through the official Google Places API (New) Text Search.
 * https://developers.google.com/maps/documentation/places/web-service/text-search
 *
 * Notes:
 *  - Text Search returns at most 60 results (3 pages of 20) per query. To
 *    cover a whole state, the pipeline searches map rectangles and splits any
 *    rectangle that returns a full page into 4 smaller ones.
 *  - Review the Google Maps Platform Terms for storing/exporting Places content.
 */
import { fetchWithRetry, googleErrorMessage, PermanentError } from "./http";
import type { Rect } from "./types";

const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.addressComponents",
  "places.nationalPhoneNumber",
  "places.internationalPhoneNumber",
  "places.rating",
  "places.userRatingCount",
  "places.websiteUri",
  "places.googleMapsUri",
  "places.businessStatus",
  "nextPageToken",
].join(",");

export interface PlaceResult {
  id: string;
  name: string;
  address: string;
  city: string;
  regionCode: string;
  regionName: string;
  countryCode: string;
  phone: string;
  rating: number | null;
  reviews: number | null;
  website: string;
  mapsUrl: string;
  businessStatus: string;
}

export interface PlacesPage {
  places: PlaceResult[];
  nextPageToken: string | null;
}

export interface PlacesClient {
  configured: boolean;
  search(textQuery: string, regionCode: string, pageToken: string | null, rect?: Rect): Promise<PlacesPage>;
  /** Map boundary (viewport) of a state / city / area, or null if not found. */
  locate(areaQuery: string, regionCode: string): Promise<Rect | null>;
}

interface AddressComponent {
  longText?: string;
  shortText?: string;
  types?: string[];
}

function component(comps: AddressComponent[], type: string) {
  return comps.find((c) => c.types?.includes(type));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapPlace(p: any): PlaceResult {
  const comps: AddressComponent[] = p.addressComponents ?? [];
  const city =
    component(comps, "locality") ?? component(comps, "postal_town") ?? component(comps, "sublocality") ?? component(comps, "administrative_area_level_3");
  const region = component(comps, "administrative_area_level_1");
  const country = component(comps, "country");
  return {
    id: p.id,
    name: p.displayName?.text ?? "",
    address: p.formattedAddress ?? "",
    city: city?.longText ?? "",
    regionCode: region?.shortText ?? "",
    regionName: region?.longText ?? "",
    countryCode: country?.shortText ?? "",
    phone: p.internationalPhoneNumber ?? p.nationalPhoneNumber ?? "",
    rating: typeof p.rating === "number" ? p.rating : null,
    reviews: typeof p.userRatingCount === "number" ? p.userRatingCount : null,
    website: p.websiteUri ?? "",
    mapsUrl: p.googleMapsUri ?? "",
    businessStatus: p.businessStatus ?? "",
  };
}

async function post(body: Record<string, unknown>, fieldMask: string): Promise<Response> {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) throw new PermanentError("GOOGLE_PLACES_API_KEY is not configured.");
  return fetchWithRetry(
    ENDPOINT,
    {
      method: "POST",
      headers: { "content-type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": fieldMask },
      body: JSON.stringify(body),
    },
    { retries: 3, timeoutMs: 30_000 },
  );
}

const AREA_TYPES = ["administrative_area_level_1", "locality", "administrative_area_level_2", "sublocality", "postal_code", "neighborhood", "colloquial_area"];

export const googlePlaces: PlacesClient = {
  get configured() {
    return Boolean(process.env.GOOGLE_PLACES_API_KEY);
  },
  async locate(areaQuery, regionCode) {
    const res = await post({ textQuery: areaQuery, regionCode: regionCode.toLowerCase(), pageSize: 5, languageCode: "en" }, "places.viewport,places.types");
    if (!res.ok) {
      const msg = await googleErrorMessage(res);
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        throw new PermanentError(`Google Places API rejected the request (${res.status}): ${msg}`);
      }
      throw new Error(`Google Places API error (${res.status}): ${msg}`);
    }
    const json = await res.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const list: any[] = (json.places ?? []).filter((p: any) => p.viewport?.low && p.viewport?.high);
    const best = list.find((p) => (p.types ?? []).some((t: string) => AREA_TYPES.includes(t))) ?? list[0];
    return best ? { low: best.viewport.low, high: best.viewport.high } : null;
  },
  async search(textQuery, regionCode, pageToken, rect) {
    const body: Record<string, unknown> = { textQuery, regionCode: regionCode.toLowerCase(), pageSize: 20, languageCode: "en" };
    if (rect) body.locationRestriction = { rectangle: rect };
    if (pageToken) body.pageToken = pageToken;
    const res = await post(body, FIELD_MASK);
    if (!res.ok) {
      const msg = await googleErrorMessage(res);
      if (res.status === 400 && pageToken) return { places: [], nextPageToken: null }; // expired page token
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        throw new PermanentError(`Google Places API rejected the request (${res.status}): ${msg}`);
      }
      throw new Error(`Google Places API error (${res.status}): ${msg}`);
    }
    const json = await res.json();
    return { places: (json.places ?? []).map(mapPlace), nextPageToken: json.nextPageToken ?? null };
  },
};
