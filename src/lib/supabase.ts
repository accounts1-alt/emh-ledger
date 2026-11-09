import { createClient } from '@supabase/supabase-js';

export const SUPABASE_URL = 'https://bcdibbhmiwccvvmryqze.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_YAtej3hTvSDPHPLQVYk-Ig_K4rxgiYr';
// The nightly robot runs this same code on a server with a secret key; the website always uses the publishable key and the user's login.
const serverKey = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env?.SUPABASE_SECRET_KEY;
export const supabase = createClient(SUPABASE_URL, serverKey || SUPABASE_KEY, { auth: { persistSession: !serverKey, autoRefreshToken: !serverKey } });

type Res<T> = { data: T | null; error: { message: string } | null };

/** Await a Supabase call and throw a readable error instead of returning one. */
export async function q<T>(p: PromiseLike<Res<T>>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(friendly(error.message));
  return data as T;
}

/** Fetch every row of a query, 1000 at a time. */
export async function all<T>(make: (from: number, to: number) => PromiseLike<Res<T[]>>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const page = await q(make(from, from + 999));
    out.push(...(page ?? []));
    if (!page || page.length < 1000) break;
  }
  return out;
}

export async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  return q(supabase.rpc(fn, args) as unknown as PromiseLike<Res<T>>);
}

function friendly(msg: string) {
  if (/row-level security/i.test(msg)) return 'Your login is not allowed to change this data.';
  if (/JWT|not authenticated/i.test(msg)) return 'Your session has ended. Sign in again.';
  return msg;
}
