import { createClient } from '@supabase/supabase-js';

// The hub — the same Supabase project the ledger and every other app share.
// This is the public, browser-safe publishable key; what a signed-in user may
// read or write is decided by row-level security in the database, not by this key.
export const SUPABASE_URL = 'https://bcdibbhmiwccvvmryqze.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_YAtej3hTvSDPHPLQVYk-Ig_K4rxgiYr';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

type Res<T> = { data: T | null; error: { message: string } | null };

// Run a query and throw a plain Error on failure, so callers can try/catch.
export async function q<T>(p: PromiseLike<Res<T>>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data as T;
}

export async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}
