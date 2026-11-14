import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Batch, Candidate, CandidateState } from "../types";
import type { Store } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */
const toBatch = (r: any): Batch => ({
  id: r.id,
  params: r.params,
  stage: r.stage,
  phase: r.phase,
  cursor: r.cursor,
  exportMode: r.export_mode,
  message: r.message,
  error: r.error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const toCandidate = (r: any): Candidate => ({
  batchId: r.batch_id,
  placeId: r.place_id,
  state: r.state,
  lead: r.lead,
  reason: r.reason,
  attempts: r.attempts,
});
const fromCandidate = (c: Candidate) => ({
  batch_id: c.batchId,
  place_id: c.placeId,
  state: c.state,
  lead: c.lead,
  reason: c.reason,
  attempts: c.attempts,
  updated_at: new Date().toISOString(),
});

function check<T>(res: { data: T; error: any }, what: string): T {
  if (res.error) throw new Error(`Supabase ${what} failed: ${res.error.message}`);
  return res.data;
}

export class SupabaseStore implements Store {
  kind = "supabase" as const;
  private db: SupabaseClient;

  constructor(url: string, serviceKey: string) {
    this.db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  async createBatch(b: Batch) {
    check(
      await this.db.from("webnest_batches").insert({
        id: b.id, params: b.params, stage: b.stage, phase: b.phase, cursor: b.cursor, export_mode: b.exportMode,
        message: b.message, error: b.error, created_at: b.createdAt, updated_at: b.updatedAt,
      }),
      "create batch",
    );
  }

  async getBatch(id: string) {
    const data = check(await this.db.from("webnest_batches").select("*").eq("id", id).maybeSingle(), "get batch");
    return data ? toBatch(data) : null;
  }

  async updateBatch(id: string, p: Partial<Batch>) {
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (p.params !== undefined) row.params = p.params;
    if (p.stage !== undefined) row.stage = p.stage;
    if (p.phase !== undefined) row.phase = p.phase;
    if (p.cursor !== undefined) row.cursor = p.cursor;
    if (p.exportMode !== undefined) row.export_mode = p.exportMode;
    if (p.message !== undefined) row.message = p.message;
    if (p.error !== undefined) row.error = p.error;
    check(await this.db.from("webnest_batches").update(row).eq("id", id), "update batch");
  }

  async insertCandidates(cands: Candidate[]) {
    if (!cands.length) return 0;
    const data = check(
      await this.db
        .from("webnest_candidates")
        .upsert(cands.map(fromCandidate), { onConflict: "batch_id,place_id", ignoreDuplicates: true })
        .select("place_id"),
      "insert candidates",
    );
    return (data as unknown[] | null)?.length ?? 0;
  }

  async listCandidates(batchId: string, states?: CandidateState[]) {
    const out: Candidate[] = [];
    for (let from = 0; ; from += 1000) {
      let q = this.db.from("webnest_candidates").select("*").eq("batch_id", batchId).order("place_id").range(from, from + 999);
      if (states?.length) q = q.in("state", states);
      const data = check(await q, "list candidates") as any[];
      out.push(...data.map(toCandidate));
      if (data.length < 1000) return out;
    }
  }

  async updateCandidates(cands: Candidate[]) {
    if (!cands.length) return;
    check(await this.db.from("webnest_candidates").upsert(cands.map(fromCandidate), { onConflict: "batch_id,place_id" }), "update candidates");
  }

  async tryLock(name: string, holder: string, ttlSeconds: number) {
    const data = check(await this.db.rpc("webnest_try_lock", { p_name: name, p_holder: holder, p_ttl_seconds: ttlSeconds }), "lock");
    return data === true;
  }

  async releaseLock(name: string, holder: string) {
    check(await this.db.rpc("webnest_release_lock", { p_name: name, p_holder: holder }), "unlock");
  }
}
