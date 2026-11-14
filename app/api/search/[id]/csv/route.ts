import { NextResponse } from "next/server";
import { BATCH_ID_RE, errorResponse } from "@/lib/api";
import { batchCsv, defaultDeps } from "@/lib/pipeline";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    if (!BATCH_ID_RE.test(id)) return NextResponse.json({ error: "Invalid batch id" }, { status: 400 });
    const csv = await batchCsv(id, defaultDeps());
    if (csv === null) return NextResponse.json({ error: "Search not found" }, { status: 404 });
    return new NextResponse("﻿" + csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="webnest-${id}.csv"`,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
