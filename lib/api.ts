import { NextResponse } from "next/server";
import { PermanentError } from "./http";

export function errorResponse(err: unknown) {
  const msg = (err as Error)?.message || "Unexpected error";
  const isUserError = err instanceof PermanentError || /^(Choose|Select|Minimum|Number of)/.test(msg);
  if (!isUserError) console.error("[webnest]", err);
  return NextResponse.json({ error: isUserError ? msg : `Server error: ${msg}` }, { status: isUserError ? 400 : 500 });
}

export const BATCH_ID_RE = /^WN-\d{8}-\d{4}-[0-9A-F]{4}$/;
