import type { Lead } from "./types";

/** Required columns, in the order they are created in a new sheet. */
export const SHEET_COLUMNS = [
  "Business Name",
  "Phone",
  "Email",
  "Address",
  "City",
  "State / Province",
  "Country",
  "Rating",
  "Reviews Count",
  "Website URL",
  "Website Status",
  "Mobile PageSpeed",
  "Desktop PageSpeed",
  "Website Quality",
  "Google Maps Link",
  "Data Source",
  "Source URL",
  "Date Found",
  "Search Batch ID",
  // Extra system columns (appended after the required ones):
  "Audit Notes",
  "Last Seen Date",
  "Last Seen Batch ID",
  "Google Place ID",
] as const;

export type SheetColumn = (typeof SHEET_COLUMNS)[number];
export type SheetRecord = Partial<Record<SheetColumn, string | number>>;

/** Columns never filled on an existing row (they describe the first discovery). */
export const NEVER_FILL: SheetColumn[] = ["Date Found", "Search Batch ID", "Last Seen Date", "Last Seen Batch ID"];

export function leadToRecord(lead: Lead): SheetRecord {
  return {
    "Business Name": lead.name,
    Phone: lead.phone,
    Email: lead.email,
    Address: lead.address,
    City: lead.city,
    "State / Province": lead.region,
    Country: lead.country,
    Rating: lead.rating ?? "",
    "Reviews Count": lead.reviews ?? "",
    "Website URL": lead.websiteUrl,
    "Website Status": lead.websiteStatus,
    "Mobile PageSpeed": lead.mobileScore ?? "",
    "Desktop PageSpeed": lead.desktopScore ?? "",
    "Website Quality": lead.websiteQuality,
    "Google Maps Link": lead.mapsUrl,
    "Data Source": lead.dataSource,
    "Source URL": lead.sourceUrl,
    "Date Found": lead.dateFound,
    "Search Batch ID": lead.batchId,
    "Audit Notes": lead.auditNotes,
    "Last Seen Date": lead.dateFound,
    "Last Seen Batch ID": lead.batchId,
    "Google Place ID": lead.placeId,
  };
}
