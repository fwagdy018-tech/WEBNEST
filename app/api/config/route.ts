import { NextResponse } from "next/server";
import { googleSheets } from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Which integrations are configured (booleans only — never key values). */
export async function GET() {
  return NextResponse.json({
    places: Boolean(process.env.GOOGLE_PLACES_API_KEY),
    pagespeed: Boolean(process.env.PAGESPEED_API_KEY),
    sheets: googleSheets.configured,
    supabase: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    sheetUrl: googleSheets.url,
  });
}
