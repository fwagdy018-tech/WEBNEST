import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api";
import { createSearch, defaultDeps } from "@/lib/pipeline";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    return NextResponse.json(await createSearch(body, defaultDeps()));
  } catch (err) {
    return errorResponse(err);
  }
}
