import { all, q, supabase } from './supabase';
import { compare, matchBacs, addDays, type CompareGroup, type BacsMatch } from './recon';

export type Settings = { amex_fee_pct: number; voucher_fee_pct: number; default_float: number; bacs_window_days: number };
export async function loadSettings(): Promise<Settings & { rows: { id: string; key: string; value: unknown; label: string }[] }> {
  const rows = await q(supabase.from('settings').select('id,key,value,label').order('key')) as { id: string; key: string; value: unknown; label: string }[];
  const m = Object.fromEntries(rows.map(r => [r.key, Number(r.value)]));
  return { amex_fee_pct: m.amex_fee_pct ?? 1.9, voucher_fee_pct: m.voucher_fee_pct ?? 1, default_float: m.default_float ?? 0, bacs_window_days: m.bacs_window_days ?? 2, rows };
}

export type Category = { id: string; name: string; direction: 'in' | 'out'; against_pos_default: boolean; system_key: string | null; sort: number; voided: boolean };
/** Options for a "money received" category picker. Keeps a retired category if the record already uses it. */
export const inCategoryOptions = (cats: Category[] | null | undefined, current?: unknown): [string, string][] =>
  (cats ?? []).filter(c => c.direction === 'in' && (!c.voided || c.id === current)).map(c => [c.id, c.name]);
export const categoryName = (cats: Category[] | null | undefined, id: unknown) => (cats ?? []).find(c => c.id === id)?.name ?? '';
export const loadCategories = async () => q(supabase.from('categories').select('*').order('direction').order('sort').order('name')) as Promise<Category[]>;

export type Coverage = { source: string; date_from: string; date_to: string };
export async function loadCoverage(): Promise<Coverage[]> {
  return q(supabase.from('v_coverage').select('*')) as Promise<Coverage[]>;
}

/** Everything the Semtek comparison needs for a date range. */
export async function loadCompare(from: string, to: string): Promise<{ groups: CompareGroup[]; bacs: BacsMatch[]; cardsByDay: Map<string, Record<string, number>> }> {
  // widen by a week so counts/floats that straddle the range edge are seen
  const wFrom = addDays(from, -7), wTo = addDays(to, 7);
  const [semtek, cards, counts, floats, cheques, vouchers, entries, bacsLines, semBacs, coverage, settings] = await Promise.all([
    q(supabase.from('v_semtek_daily').select('*').gte('txn_date', from).lte('txn_date', to)),
    all((a, b) => supabase.from('card_txns').select('txn_date,merchant,amount,against_pos').eq('voided', false).gte('txn_date', from).lte('txn_date', to).range(a, b)),
    q(supabase.from('counts').select('id,ref,date_from,date_to,cash_total,vouchers_total,against_pos').eq('voided', false).lte('date_from', wTo).gte('date_to', wFrom)),
    q(supabase.from('floats').select('id,ref,amount,date_from,date_to,unused').eq('voided', false).lte('date_from', wTo).gte('date_to', wFrom)),
    q(supabase.from('cheques').select('received_date,amount,against_pos').eq('voided', false).gte('received_date', from).lte('received_date', to)),
    q(supabase.from('voucher_lots').select('received_date,amount,against_pos').eq('voided', false).gte('received_date', from).lte('received_date', to)),
    q(supabase.from('entries').select('entry_date,direction,account,against_pos,amount').eq('voided', false).gte('entry_date', from).lte('entry_date', to)),
    q(supabase.from('bacs_lines').select('id,txn_date,amount,description').eq('voided', false).gte('txn_date', addDays(from, -3)).lte('txn_date', addDays(to, 3))),
    q(supabase.from('semtek_lines').select('id,txn_date,bacs,last_name,account_no').eq('voided', false).neq('bacs', 0).gte('txn_date', addDays(from, -3)).lte('txn_date', addDays(to, 3))),
    loadCoverage(),
    loadSettings(),
  ]) as unknown as [
    { txn_date: string; cash: number; cheque: number; credit_card: number; vouchers: number; bacs: number }[],
    { txn_date: string; merchant: string; amount: number; against_pos: boolean }[],
    { id: string; ref: number; date_from: string; date_to: string; cash_total: number; vouchers_total: number; against_pos: boolean }[],
    { id: string; ref: number; amount: number; date_from: string; date_to: string; unused: boolean }[],
    { received_date: string; amount: number; against_pos: boolean }[],
    { received_date: string; amount: number; against_pos: boolean }[],
    { entry_date: string; direction: 'in' | 'out'; account: string; against_pos: boolean; amount: number }[],
    { id: string; txn_date: string; amount: number; description: string }[],
    { id: string; txn_date: string; bacs: number; last_name: string; account_no: string }[],
    Coverage[], Settings,
  ];
  const num = <T extends object>(rows: T[]) => rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) && !/date|ref|id/.test(k) ? Number(v) : v])) as T);
  const groups = compare({
    from, to, semtek: num(semtek), cards: num(cards), counts: num(counts), floats: num(floats), cheques: num(cheques),
    vouchers: num(vouchers), entries: num(entries), bacs: num(bacsLines).filter(b => b.txn_date >= from && b.txn_date <= to), coverage,
  });
  const bacs = matchBacs(
    num(bacsLines).map(b => ({ id: b.id, txn_date: b.txn_date, amount: Number(b.amount), label: b.description })),
    num(semBacs).map(s => ({ id: s.id, txn_date: s.txn_date, amount: Number(s.bacs), label: [s.last_name, s.account_no].filter(Boolean).join(', ') })),
    settings.bacs_window_days,
  ).filter(m => { const d = (m.bank ?? m.semtek)!.txn_date; return d >= from && d <= to; });
  const cardsByDay = new Map<string, Record<string, number>>();
  for (const c of num(cards).filter(c => c.against_pos !== false)) { const m = cardsByDay.get(c.txn_date) ?? {}; m[c.merchant] = (m[c.merchant] ?? 0) + Number(c.amount); cardsByDay.set(c.txn_date, m); }
  return { groups, bacs, cardsByDay };
}

export type Movement = { account: string; mdate: string; amount: number; detail: string; src: string; src_id: string | null };
export async function loadMovements(upTo: string): Promise<Movement[]> {
  const rows = await all((a, b) => supabase.from('v_movements').select('*').lte('mdate', upTo).order('mdate').range(a, b)) as Movement[];
  return rows.map(r => ({ ...r, amount: Number(r.amount) }));
}

export async function latestSemtekDate(): Promise<string | null> {
  const r = await q(supabase.from('semtek_lines').select('txn_date').eq('voided', false).order('txn_date', { ascending: false }).limit(1)) as { txn_date: string }[];
  return r[0]?.txn_date ?? null;
}
