import type { Batch, Candidate, CandidateState } from "../types";

export interface Store {
  kind: "supabase" | "file";
  createBatch(batch: Batch): Promise<void>;
  getBatch(id: string): Promise<Batch | null>;
  updateBatch(id: string, patch: Partial<Omit<Batch, "id" | "createdAt">>): Promise<void>;
  /** Insert candidates, ignoring ones already stored for the batch. Returns how many were new. */
  insertCandidates(candidates: Candidate[]): Promise<number>;
  listCandidates(batchId: string, states?: CandidateState[]): Promise<Candidate[]>;
  updateCandidates(updates: Candidate[]): Promise<void>;
  /** Atomic named lock with expiry. True if acquired (or already held by holder). */
  tryLock(name: string, holder: string, ttlSeconds: number): Promise<boolean>;
  releaseLock(name: string, holder: string): Promise<void>;
}
