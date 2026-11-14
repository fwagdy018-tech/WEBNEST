/**
 * Local JSON-file store for development and tests when Supabase is not
 * configured. Safe within ONE server process only — use Supabase in production.
 */
import fs from "node:fs";
import path from "node:path";
import type { Batch, Candidate, CandidateState } from "../types";
import type { Store } from "./types";

interface Data {
  batches: Record<string, Batch>;
  candidates: Record<string, Record<string, Candidate>>;
}

export class FileStore implements Store {
  kind = "file" as const;
  private data: Data;
  private locks = new Map<string, { holder: string; expires: number }>();

  constructor(private file: string | null = path.join(process.cwd(), ".webnest-data", "store.json")) {
    this.data = { batches: {}, candidates: {} };
    if (file && fs.existsSync(/*turbopackIgnore: true*/ file)) {
      this.data = JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8"));
    }
  }

  private save() {
    if (!this.file) return;
    fs.mkdirSync(/*turbopackIgnore: true*/ path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(/*turbopackIgnore: true*/ tmp, JSON.stringify(this.data));
    fs.renameSync(/*turbopackIgnore: true*/ tmp, this.file);
  }

  private clone<T>(v: T): T {
    return structuredClone(v);
  }

  async createBatch(b: Batch) {
    this.data.batches[b.id] = this.clone(b);
    this.data.candidates[b.id] = {};
    this.save();
  }
  async getBatch(id: string) {
    return this.data.batches[id] ? this.clone(this.data.batches[id]) : null;
  }
  async updateBatch(id: string, patch: Partial<Batch>) {
    const b = this.data.batches[id];
    if (!b) throw new Error("Batch not found");
    Object.assign(b, this.clone(patch), { updatedAt: new Date().toISOString() });
    this.save();
  }
  async insertCandidates(cands: Candidate[]) {
    let n = 0;
    for (const c of cands) {
      const m = (this.data.candidates[c.batchId] ??= {});
      if (!m[c.placeId]) {
        m[c.placeId] = this.clone(c);
        n++;
      }
    }
    this.save();
    return n;
  }
  async listCandidates(batchId: string, states?: CandidateState[]) {
    const all = Object.values(this.data.candidates[batchId] ?? {});
    return this.clone(states?.length ? all.filter((c) => states.includes(c.state)) : all);
  }
  async updateCandidates(cands: Candidate[]) {
    for (const c of cands) (this.data.candidates[c.batchId] ??= {})[c.placeId] = this.clone(c);
    this.save();
  }
  async tryLock(name: string, holder: string, ttlSeconds: number) {
    const cur = this.locks.get(name);
    if (cur && cur.expires > Date.now() && cur.holder !== holder) return false;
    this.locks.set(name, { holder, expires: Date.now() + ttlSeconds * 1000 });
    return true;
  }
  async releaseLock(name: string, holder: string) {
    if (this.locks.get(name)?.holder === holder) this.locks.delete(name);
  }
}
