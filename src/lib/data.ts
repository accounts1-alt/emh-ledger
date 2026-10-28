import { all, q, supabase } from './supabase';
import { compare, matchBacs, addDays, type DayRow, type BacsMatch } from './recon';

export type Settings = { amex_fee_pct: number; voucher_fee_pct: number; default_float: number; bacs_window_days: number; cash_ok_tolerance: number };
export async function loadSettings(): Promise<Settings & { rows: { id: string; key: string; value: unknown; label: string }[] }> {
  const rows = await q(supabase.from('settings').select('id,key,value,label').order('key')) as { id: string; key: string; value: unknown; label: string }[];
  const m = Object.fromEntries(rows.map(r => [r.key, Number(r.value)]));
  return { amex_fee_pct: m.amex_fee_pct ?? 1.9, voucher_fee_pct: m.voucher_fee_pct ?? 1, default_float: m.default_float ?? 0, bacs_window_days: m.bacs_window_days ?? 2, cash_ok_tolerance: m.cash_ok_tolerance ?? 1, rows };
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

export type CardLine = { id: string; txn_date: string; txn_at: string | null; merchant: string; amount: number; fee: number; customer: string | null; card_last4: string | null; card_scheme: string | null; against_pos: boolean; category_id: string; created_at: string; updated_at: string };
export type CompareData = {
  days: DayRow[]; bacs: BacsMatch[]; cards: BacsMatch[]; cheques: BacsMatch[];
  cardsByDay: Map<string, Record<string, number>>; cardRows: Map<string, CardLine>; tolerance: number;
};
const num = <T extends object>(rows: T[]) => rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) && !/date|ref|id|_at|no$/.test(k) ? Number(v) : v])) as T);
const time = (t: string | null) => (t ? String(t).slice(11, 16) : '');

/** Everything the Semtek comparison needs for a date range. */
export async function loadCompare(from: string, to: string): Promise<CompareData> {
  // widen by a week so counts/floats that straddle the range edge are seen
  const wFrom = addDays(from, -7), wTo = addDays(to, 7);
  const [semtek, cards, counts, floats, cheques, vouchers, entries, bacsLines, semLines, coverage, settings] = await Promise.all([
    q(supabase.from('v_semtek_daily').select('*').gte('txn_date', from).lte('txn_date', to)),
    all((a, b) => supabase.from('card_txns').select('id,txn_date,txn_at,merchant,amount,fee,customer,card_last4,card_scheme,against_pos,category_id,created_at,updated_at').eq('voided', false).gte('txn_date', from).lte('txn_date', to).range(a, b)),
    q(supabase.from('counts').select('id,ref,date_from,date_to,cash_total,vouchers_total,against_pos').eq('voided', false).lte('date_from', wTo).gte('date_to', wFrom)),
    q(supabase.from('floats').select('id,ref,amount,date_from,date_to,unused').eq('voided', false).lte('date_from', wTo).gte('date_to', wFrom)),
    q(supabase.from('cheques').select('id,received_date,amount,against_pos,payer,cheque_no').eq('voided', false).gte('received_date', from).lte('received_date', to)),
    q(supabase.from('voucher_lots').select('received_date,amount,against_pos').eq('voided', false).gte('received_date', from).lte('received_date', to)),
    q(supabase.from('entries').select('entry_date,direction,account,against_pos,amount').eq('voided', false).gte('entry_date', from).lte('entry_date', to)),
    q(supabase.from('bacs_lines').select('id,txn_date,amount,description').eq('voided', false).gte('txn_date', addDays(from, -3)).lte('txn_date', addDays(to, 3))),
    // Semtek lines paid by card, cheque or BACS (for line-by-line pairing)
    all((a, b) => supabase.from('semtek_lines').select('id,txn_date,txn_at,credit_card,cheque,bacs,last_name,account_no').eq('voided', false).or('credit_card.neq.0,cheque.neq.0,bacs.neq.0').gte('txn_date', addDays(from, -3)).lte('txn_date', addDays(to, 3)).range(a, b)),
    loadCoverage(),
    loadSettings(),
  ]) as unknown as [
    { txn_date: string; cash: number; cheque: number; credit_card: number; vouchers: number; bacs: number }[],
    CardLine[],
    { id: string; ref: number; date_from: string; date_to: string; cash_total: number; vouchers_total: number; against_pos: boolean }[],
    { id: string; ref: number; amount: number; date_from: string; date_to: string; unused: boolean }[],
    { id: string; received_date: string; amount: number; against_pos: boolean; payer: string | null; cheque_no: string | null }[],
    { received_date: string; amount: number; against_pos: boolean }[],
    { entry_date: string; direction: 'in' | 'out'; account: string; against_pos: boolean; amount: number }[],
    { id: string; txn_date: string; amount: number; description: string }[],
    { id: string; txn_date: string; txn_at: string | null; credit_card: number; cheque: number; bacs: number; last_name: string; account_no: string }[],
    Coverage[], Settings,
  ];
  const inRange = (m: BacsMatch) => { const d = (m.bank ?? m.semtek)!.txn_date; return d >= from && d <= to; };
  const sl = num(semLines);
  const who = (s: { last_name: string; account_no: string }) => [s.last_name, s.account_no].filter(Boolean).join(', ');
  const cardList = num(cards);
  const days = compare({
    from, to, semtek: num(semtek), cards: cardList, counts: num(counts), floats: num(floats), cheques: num(cheques),
    vouchers: num(vouchers), entries: num(entries), bacs: num(bacsLines).filter(b => b.txn_date >= from && b.txn_date <= to), coverage,
    cashTolerance: settings.cash_ok_tolerance,
  });
  const bacs = matchBacs(
    num(bacsLines).map(b => ({ id: b.id, txn_date: b.txn_date, amount: Number(b.amount), label: b.description })),
    sl.filter(s => Number(s.bacs) !== 0).map(s => ({ id: s.id, txn_date: s.txn_date, amount: Number(s.bacs), label: who(s) })),
    settings.bacs_window_days,
  ).filter(inRange);
  const MERCH: Record<string, string> = { paymentsense: 'Paymentsense', amex: 'Amex', stripe_shop: 'Stripe Shop', stripe_office: 'Stripe Office' };
  const cardsMatched = matchBacs(
    cardList.filter(c => c.against_pos !== false).map(c => ({ id: c.id, txn_date: c.txn_date, amount: Number(c.amount), label: `${MERCH[c.merchant]} ${time(c.txn_at)}${c.customer ? ' · ' + c.customer : ''}${c.card_last4 ? ' ****' + c.card_last4 : ''}` })),
    sl.filter(s => Number(s.credit_card) !== 0 && s.txn_date >= from && s.txn_date <= to).map(s => ({ id: s.id, txn_date: s.txn_date, amount: Number(s.credit_card), label: `${time(s.txn_at)} ${who(s)}` })),
    0,
  );
  const chequesMatched = matchBacs(
    num(cheques).filter(c => c.against_pos).map(c => ({ id: c.id, txn_date: c.received_date, amount: Number(c.amount), label: [c.payer, c.cheque_no ? '#' + c.cheque_no : ''].filter(Boolean).join(' ') })),
    sl.filter(s => Number(s.cheque) !== 0 && s.txn_date >= from && s.txn_date <= to).map(s => ({ id: s.id, txn_date: s.txn_date, amount: Number(s.cheque), label: `${time(s.txn_at)} ${who(s)}` })),
    0,
  );
  const cardsByDay = new Map<string, Record<string, number>>();
  for (const c of cardList.filter(c => c.against_pos !== false)) { const m = cardsByDay.get(c.txn_date) ?? {}; m[c.merchant] = (m[c.merchant] ?? 0) + Number(c.amount); cardsByDay.set(c.txn_date, m); }
  return { days, bacs, cards: cardsMatched, cheques: chequesMatched, cardsByDay, cardRows: new Map(cardList.map(c => [c.id, c])), tolerance: settings.cash_ok_tolerance };
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
