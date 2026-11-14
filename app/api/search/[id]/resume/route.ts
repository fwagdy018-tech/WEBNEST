import { NextResponse } from "next/server";
import { BATCH_ID_RE, errorResponse } from "@/lib/api";
import { defaultDeps, resumeSearch } from "@/lib/pipeline";

export const runtime = "nodejs";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    if (!BATCH_ID_RE.test(id)) return NextResponse.json({ error: "Invalid batch id" }, { status: 400 });
    const status = await resumeSearch(id, defaultDeps());
    return status ? NextResponse.json(status) : NextResponse.json({ error: "Search not found" }, { status: 404 });
  } catch (err) {
    return errorResponse(err);
  }
}
