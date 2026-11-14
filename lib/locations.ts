import type { CountryCode } from "./types";

export interface Region {
  /** Short code matching Google's administrative_area_level_1 short name. */
  code: string;
  name: string;
  /** A few major cities as suggestions; any city/area can be typed. */
  cities: string[];
}

export interface Country {
  code: CountryCode;
  name: string;
  regionLabel: string;
  regions: Region[];
}

const r = (code: string, name: string, cities: string): Region => ({
  code,
  name,
  cities: cities.split("|"),
});

export const COUNTRIES: Country[] = [
  {
    code: "US",
    name: "United States",
    regionLabel: "State",
    regions: [
      r("AL", "Alabama", "Birmingham|Montgomery|Huntsville|Mobile"),
      r("AK", "Alaska", "Anchorage|Fairbanks|Juneau"),
      r("AZ", "Arizona", "Phoenix|Tucson|Mesa|Scottsdale"),
      r("AR", "Arkansas", "Little Rock|Fayetteville|Fort Smith"),
      r("CA", "California", "Los Angeles|San Diego|San Jose|San Francisco|Sacramento|Fresno"),
      r("CO", "Colorado", "Denver|Colorado Springs|Aurora|Fort Collins"),
      r("CT", "Connecticut", "Bridgeport|New Haven|Hartford|Stamford"),
      r("DE", "Delaware", "Wilmington|Dover|Newark"),
      r("DC", "District of Columbia", "Washington"),
      r("FL", "Florida", "Miami|Orlando|Tampa|Jacksonville"),
      r("GA", "Georgia", "Atlanta|Savannah|Augusta"),
      r("HI", "Hawaii", "Honolulu|Hilo"),
      r("ID", "Idaho", "Boise|Meridian|Idaho Falls"),
      r("IL", "Illinois", "Chicago|Aurora|Naperville|Springfield"),
      r("IN", "Indiana", "Indianapolis|Fort Wayne|Evansville"),
      r("IA", "Iowa", "Des Moines|Cedar Rapids|Davenport"),
      r("KS", "Kansas", "Wichita|Overland Park|Kansas City"),
      r("KY", "Kentucky", "Louisville|Lexington|Bowling Green"),
      r("LA", "Louisiana", "New Orleans|Baton Rouge|Shreveport"),
      r("ME", "Maine", "Portland|Lewiston|Bangor"),
      r("MD", "Maryland", "Baltimore|Frederick|Rockville"),
      r("MA", "Massachusetts", "Boston|Worcester|Springfield|Cambridge"),
      r("MI", "Michigan", "Detroit|Grand Rapids|Lansing|Ann Arbor"),
      r("MN", "Minnesota", "Minneapolis|Saint Paul|Rochester"),
      r("MS", "Mississippi", "Jackson|Gulfport|Southaven"),
      r("MO", "Missouri", "Kansas City|St. Louis|Springfield"),
      r("MT", "Montana", "Billings|Missoula|Bozeman"),
      r("NE", "Nebraska", "Omaha|Lincoln"),
      r("NV", "Nevada", "Las Vegas|Henderson|Reno"),
      r("NH", "New Hampshire", "Manchester|Nashua|Concord"),
      r("NJ", "New Jersey", "Newark|Jersey City|Paterson|Trenton"),
      r("NM", "New Mexico", "Albuquerque|Las Cruces|Santa Fe"),
      r("NY", "New York", "New York|Buffalo|Rochester|Albany"),
      r("NC", "North Carolina", "Charlotte|Raleigh|Greensboro|Durham"),
      r("ND", "North Dakota", "Fargo|Bismarck|Grand Forks"),
      r("OH", "Ohio", "Columbus|Cleveland|Cincinnati|Toledo"),
      r("OK", "Oklahoma", "Oklahoma City|Tulsa|Norman"),
      r("OR", "Oregon", "Portland|Salem|Eugene"),
      r("PA", "Pennsylvania", "Philadelphia|Pittsburgh|Allentown"),
      r("RI", "Rhode Island", "Providence|Warwick|Cranston"),
      r("SC", "South Carolina", "Charleston|Columbia|Greenville"),
      r("SD", "South Dakota", "Sioux Falls|Rapid City"),
      r("TN", "Tennessee", "Nashville|Memphis|Knoxville|Chattanooga"),
      r("TX", "Texas", "Houston|Dallas|Austin|San Antonio|Fort Worth"),
      r("UT", "Utah", "Salt Lake City|Provo|West Valley City"),
      r("VT", "Vermont", "Burlington|South Burlington|Rutland"),
      r("VA", "Virginia", "Virginia Beach|Richmond|Norfolk|Arlington"),
      r("WA", "Washington", "Seattle|Spokane|Tacoma|Bellevue"),
      r("WV", "West Virginia", "Charleston|Huntington|Morgantown"),
      r("WI", "Wisconsin", "Milwaukee|Madison|Green Bay"),
      r("WY", "Wyoming", "Cheyenne|Casper|Laramie"),
    ],
  },
  {
    code: "CA",
    name: "Canada",
    regionLabel: "Province / Territory",
    regions: [
      r("AB", "Alberta", "Calgary|Edmonton|Red Deer"),
      r("BC", "British Columbia", "Vancouver|Surrey|Burnaby|Victoria"),
      r("MB", "Manitoba", "Winnipeg|Brandon"),
      r("NB", "New Brunswick", "Moncton|Saint John|Fredericton"),
      r("NL", "Newfoundland and Labrador", "St. John's|Mount Pearl"),
      r("NS", "Nova Scotia", "Halifax|Sydney"),
      r("NT", "Northwest Territories", "Yellowknife"),
      r("NU", "Nunavut", "Iqaluit"),
      r("ON", "Ontario", "Toronto|Ottawa|Mississauga|Brampton|Hamilton"),
      r("PE", "Prince Edward Island", "Charlottetown|Summerside"),
      r("QC", "Quebec", "Montreal|Quebec City|Laval|Gatineau"),
      r("SK", "Saskatchewan", "Saskatoon|Regina"),
      r("YT", "Yukon", "Whitehorse"),
    ],
  },
  {
    code: "AU",
    name: "Australia",
    regionLabel: "State / Territory",
    regions: [
      r("NSW", "New South Wales", "Sydney|Newcastle|Wollongong|Central Coast"),
      r("VIC", "Victoria", "Melbourne|Geelong|Ballarat"),
      r("QLD", "Queensland", "Brisbane|Gold Coast|Sunshine Coast|Townsville"),
      r("WA", "Western Australia", "Perth|Mandurah|Bunbury"),
      r("SA", "South Australia", "Adelaide|Mount Gambier"),
      r("TAS", "Tasmania", "Hobart|Launceston"),
      r("ACT", "Australian Capital Territory", "Canberra"),
      r("NT", "Northern Territory", "Darwin|Alice Springs"),
    ],
  },
];

export function getCountry(code: string): Country | undefined {
  return COUNTRIES.find((c) => c.code === code);
}

export function getRegion(country: string, region: string): Region | undefined {
  return getCountry(country)?.regions.find((r) => r.code === region);
}

/** Map a country name or code (as typed in a sheet) to a country code. */
export function countryCodeFrom(value: string): CountryCode | undefined {
  const v = value.trim().toLowerCase();
  if (!v) return undefined;
  for (const c of COUNTRIES) {
    if (v === c.code.toLowerCase() || v === c.name.toLowerCase()) return c.code;
  }
  if (v === "usa" || v === "united states of america" || v === "u.s.") return "US";
  return undefined;
}

/** Map a region name or code (e.g. "Texas" or "TX") to its lower-case code. */
export function regionKey(value: string): string {
  const v = value.trim().toLowerCase();
  for (const c of COUNTRIES) {
    for (const r of c.regions) {
      if (v === r.code.toLowerCase() || v === r.name.toLowerCase()) return r.code.toLowerCase();
    }
  }
  return v;
}
