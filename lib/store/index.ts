import { FileStore } from "./file";
import { SupabaseStore } from "./supabase";
import type { Store } from "./types";

export type { Store } from "./types";

const g = globalThis as unknown as { __webnestStore?: Store };

export function getStore(): Store {
  if (!g.__webnestStore) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    g.__webnestStore = url && key ? new SupabaseStore(url, key) : new FileStore();
  }
  return g.__webnestStore;
}
