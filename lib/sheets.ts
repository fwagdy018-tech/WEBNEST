/**
 * Minimal Google Sheets client using a service account (server-side only).
 * Writes use valueInputOption=RAW so scraped text can never become a formula.
 */
import crypto from "node:crypto";
import { SHEET_COLUMNS } from "./columns";
import { fetchWithRetry, googleErrorMessage, PermanentError } from "./http";

export interface SheetData {
  headers: string[];
  /** Data rows; rows[i] is sheet row i + 2 (row 1 is the header). */
  rows: string[][];
}

export interface CellUpdate {
  row: number; // 1-based sheet row
  col: number; // 0-based column index
  value: string | number;
}

export interface SheetClient {
  configured: boolean;
  url: string | null;
  /** Read every row, making sure the tab and all required headers exist. */
  readAll(): Promise<SheetData>;
  append(rows: (string | number)[][]): Promise<void>;
  updateCells(updates: CellUpdate[]): Promise<void>;
}

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
let tokenCache: { token: string; exp: number } | null = null;

function b64url(input: Buffer | string) {
  return Buffer.from(input).toString("base64url");
}

async function accessToken(): Promise<string> {
  if (tokenCache && tokenCache.exp - 60 > Date.now() / 1000) return tokenCache.token;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!;
  const key = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: email, scope: SCOPE, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  let signature: string;
  try {
    signature = crypto.createSign("RSA-SHA256").update(`${header}.${claims}`).sign(key, "base64url");
  } catch {
    throw new PermanentError("GOOGLE_PRIVATE_KEY could not be parsed. Paste the private_key from the service-account JSON, keeping the \\n sequences.");
  }
  const res = await fetchWithRetry("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claims}.${signature}` }),
  });
  if (!res.ok) throw new PermanentError(`Google service-account login failed: ${await googleErrorMessage(res)}`);
  const json = await res.json();
  tokenCache = { token: json.access_token, exp: now + (json.expires_in ?? 3600) };
  return tokenCache.token;
}

export function columnLetter(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

class GoogleSheetClient implements SheetClient {
  private sheetId = process.env.GOOGLE_SHEET_ID || "";
  private tab = process.env.GOOGLE_SHEET_TAB || "Leads";

  get configured() {
    return Boolean(process.env.GOOGLE_SHEET_ID && process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY);
  }
  get url() {
    return this.sheetId ? `https://docs.google.com/spreadsheets/d/${this.sheetId}/edit` : null;
  }
  private get range() {
    return `'${this.tab.replace(/'/g, "''")}'`;
  }

  private async api(path: string, init: RequestInit = {}) {
    const token = await accessToken();
    const res = await fetchWithRetry(`https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers || {}) },
    });
    if (!res.ok) {
      const msg = await googleErrorMessage(res);
      if (res.status === 403 || res.status === 404) {
        throw new PermanentError(
          `Google Sheets access failed (${res.status}): ${msg}. Check GOOGLE_SHEET_ID and share the sheet with ${process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL} as Editor.`,
        );
      }
      throw new Error(`Google Sheets API error (${res.status}): ${msg}`);
    }
    return res.json();
  }

  private async ensureTab() {
    const meta = await this.api("?fields=sheets.properties.title");
    const exists = (meta.sheets ?? []).some((s: { properties: { title: string } }) => s.properties.title === this.tab);
    if (!exists) {
      await this.api(":batchUpdate", { method: "POST", body: JSON.stringify({ requests: [{ addSheet: { properties: { title: this.tab } } }] }) });
    }
  }

  async readAll(): Promise<SheetData> {
    let json;
    try {
      json = await this.api(`/values/${encodeURIComponent(this.range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`);
    } catch (err) {
      if (err instanceof PermanentError && /Unable to parse range/i.test(err.message)) {
        await this.ensureTab();
        json = { values: [] };
      } else throw err;
    }
    const values: string[][] = (json.values ?? []).map((r: unknown[]) => r.map((v) => (v == null ? "" : String(v))));
    const headers = [...(values[0] ?? [])];
    const missing = SHEET_COLUMNS.filter((c) => !headers.some((h) => h.trim().toLowerCase() === c.toLowerCase()));
    if (missing.length) {
      const start = headers.length;
      headers.push(...missing);
      await this.api(
        `/values/${encodeURIComponent(`${this.range}!${columnLetter(start)}1`)}?valueInputOption=RAW`,
        { method: "PUT", body: JSON.stringify({ values: [missing] }) },
      );
    }
    return { headers, rows: values.slice(1) };
  }

  async append(rows: (string | number)[][]) {
    if (!rows.length) return;
    await this.api(`/values/${encodeURIComponent(`${this.range}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      method: "POST",
      body: JSON.stringify({ values: rows }),
    });
  }

  async updateCells(updates: CellUpdate[]) {
    if (!updates.length) return;
    const data = updates.map((u) => ({ range: `${this.range}!${columnLetter(u.col)}${u.row}`, values: [[u.value]] }));
    for (let i = 0; i < data.length; i += 500) {
      await this.api("/values:batchUpdate", { method: "POST", body: JSON.stringify({ valueInputOption: "RAW", data: data.slice(i, i + 500) }) });
    }
  }
}

export const googleSheets: SheetClient = new GoogleSheetClient();
