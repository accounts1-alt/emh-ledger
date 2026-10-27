// Semtek vs actual takings. Pure functions so the same logic runs in the app and in tests.
import { round2 } from './parsers';

export interface SemtekDay { txn_date: string; cash: number; cheque: number; credit_card: number; vouchers: number; bacs: number }
export interface CardTxn { txn_date: string; merchant: string; amount: number }
export interface CountRow { id: string; ref: number; date_from: string; date_to: string; cash_total: number; vouchers_total: number }
export interface FloatRow { id: string; ref: number; amount: number; date_from: string; date_to: string; unused: boolean }
export interface ChequeRow { received_date: string; amount: number; against_pos: boolean }
export interface VoucherLot { received_date: string; amount: number; against_pos: boolean }
export interface EntryRow { entry_date: string; direction: 'in' | 'out'; account: string; against_pos: boolean; amount: number }
export interface Coverage { source: string; date_from: string; date_to: string }

export const CARD_ACCOUNTS = ['paymentsense', 'amex', 'stripe_shop', 'stripe_office'];
export const TYPES = ['cash', 'cheque', 'vouchers', 'cards', 'bacs'] as const;
export type PayType = typeof TYPES[number];

export interface Figure { semtek: number; actual: number | null; diff: number | null; note?: string }
export interface CompareGroup {
  from: string; to: string; days: string[];
  cash: Figure; cheque: Figure; vouchers: Figure; cards: Figure; bacs: Figure;
  counts: number[]; floats: number[]; floatTotal: number; countTotal: number;
  missing: string[];
}

export const addDays = (iso: string, n: number) => {
  const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5);
export function eachDay(from: string, to: string): string[] {
  const out: string[] = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out;
}

const fig = (semtek: number, actual: number | null, note?: string): Figure =>
  ({ semtek: round2(semtek), actual: actual === null ? null : round2(actual), diff: actual === null ? null : round2(actual - semtek), note });

/**
 * Build comparison rows for [from, to]. Days are merged into one row wherever a count or a float
 * spans several days, because cash for those days can only be checked together.
 */
export function compare(input: {
  from: string; to: string;
  semtek: SemtekDay[]; cards: CardTxn[]; counts: CountRow[]; floats: FloatRow[];
  cheques: ChequeRow[]; vouchers: VoucherLot[]; entries: EntryRow[];
  bacs: { txn_date: string; amount: number }[]; coverage: Coverage[];
}): CompareGroup[] {
  const days = eachDay(input.from, input.to);
  const idx = new Map(days.map((d, i) => [d, i]));
  // union-find over day indexes
  const parent = days.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (a: string, b: string) => {
    const lo = a < input.from ? input.from : a, hi = b > input.to ? input.to : b;
    if (lo > hi) return;
    const first = idx.get(lo)!;
    for (const d of eachDay(lo, hi)) parent[find(idx.get(d)!)] = find(first);
  };
  for (const c of input.counts) if (c.date_to > c.date_from) join(c.date_from, c.date_to);
  for (const f of input.floats) if (!f.unused && f.date_to > f.date_from) join(f.date_from, f.date_to);

  const groupOf = new Map<string, number>();
  const groups = new Map<number, string[]>();
  days.forEach((d, i) => { const r = find(i); groupOf.set(d, r); if (!groups.has(r)) groups.set(r, []); groups.get(r)!.push(d); });

  const sum = <T,>(rows: T[], day: (r: T) => string, val: (r: T) => number, g: number) =>
    rows.reduce((s, r) => (groupOf.get(day(r)) === g ? s + val(r) : s), 0);
  const covered = (source: string, ds: string[]) =>
    ds.every(d => input.coverage.some(c => (c.source === source) && c.date_from <= d && c.date_to >= d));

  const out: CompareGroup[] = [];
  for (const [g, ds] of [...groups.entries()].sort((a, b) => (a[1][0] < b[1][0] ? -1 : 1))) {
    const sem = (k: keyof SemtekDay) => sum(input.semtek, r => r.txn_date, r => Number(r[k]) || 0, g);
    const counts = input.counts.filter(c => groupOf.get(c.date_from) === g || (c.date_from < input.from && groupOf.get(c.date_to) === g));
    const floats = input.floats.filter(f => !f.unused && (groupOf.get(f.date_from) === g || (f.date_from < input.from && groupOf.get(f.date_to) === g)));
    const countTotal = counts.reduce((s, c) => s + Number(c.cash_total), 0);
    const floatTotal = floats.reduce((s, f) => s + Number(f.amount), 0);
    const cashEntries = sum(input.entries.filter(e => e.account === 'cash' && e.direction === 'in' && e.against_pos), e => e.entry_date, e => Number(e.amount), g);

    const semCash = sem('cash');
    let cashActual: number | null = null; let cashNote: string | undefined;
    if (counts.length) {
      cashActual = countTotal - floatTotal + cashEntries;
      if (!floats.length) cashNote = 'No float recorded for these dates';
    } else if (cashEntries) { cashActual = cashEntries; cashNote = 'No count entered yet'; }
    else if (semCash !== 0 || floats.length) cashNote = 'No count entered yet';

    const chqActual = sum(input.cheques.filter(c => c.against_pos), c => c.received_date, c => Number(c.amount), g);
    const vchActual = sum(input.vouchers.filter(v => v.against_pos), v => v.received_date, v => Number(v.amount), g)
      + 0;
    const cardGross = sum(input.cards, c => c.txn_date, c => Number(c.amount), g);
    const cardNonPos = sum(input.entries.filter(e => CARD_ACCOUNTS.includes(e.account) && e.direction === 'in' && !e.against_pos), e => e.entry_date, e => Number(e.amount), g);
    const bacsActual = sum(input.bacs, b => b.txn_date, b => Number(b.amount), g);

    const missing: string[] = [];
    if (!covered('semtek', ds)) missing.push('Semtek');
    const cardSources = ['paymentsense', 'stripe_shop', 'stripe_office'].filter(s => !covered(s, ds));
    const cardsComplete = cardSources.length === 0;
    if (!cardsComplete) missing.push(...cardSources.map(s => ({ paymentsense: 'Paymentsense', stripe_shop: 'Stripe Shop', stripe_office: 'Stripe Office' } as Record<string, string>)[s]));
    const bacsCovered = covered('bacs', ds);
    if (!bacsCovered) missing.push('BACS report');
    const countsDone = counts.length > 0;

    out.push({
      from: ds[0], to: ds[ds.length - 1], days: ds,
      cash: fig(semCash, cashActual, cashNote),
      cheque: fig(sem('cheque'), countsDone || chqActual ? chqActual : (sem('cheque') ? null : 0), !countsDone && !chqActual && sem('cheque') ? 'No count entered yet' : undefined),
      vouchers: fig(sem('vouchers'), countsDone || vchActual ? vchActual : (sem('vouchers') ? null : 0), !countsDone && !vchActual && sem('vouchers') ? 'No count entered yet' : undefined),
      cards: fig(sem('credit_card'), cardsComplete || cardGross ? cardGross - cardNonPos : null, cardsComplete ? (cardNonPos ? `£${cardNonPos.toFixed(2)} non-POS card payments excluded` : undefined) : 'Card files missing for some days'),
      bacs: fig(sem('bacs'), bacsCovered || bacsActual ? bacsActual : null, bacsCovered ? undefined : 'BACS report not loaded for these dates'),
      counts: counts.map(c => c.ref), floats: floats.map(f => f.ref), floatTotal: round2(floatTotal), countTotal: round2(countTotal),
      missing,
    });
  }
  return out;
}

export interface BacsMatchInput { id: string; txn_date: string; amount: number; label: string }
export interface BacsMatch { bank: BacsMatchInput | null; semtek: BacsMatchInput | null; dayGap: number | null }

/** Pair each BACS report line with a Semtek BACS line of the same amount within ±window days. */
export function matchBacs(bank: BacsMatchInput[], semtek: BacsMatchInput[], windowDays: number): BacsMatch[] {
  const free = [...semtek].sort((a, b) => (a.txn_date < b.txn_date ? -1 : 1));
  const used = new Set<string>();
  const out: BacsMatch[] = [];
  for (const b of [...bank].sort((a, c) => (a.txn_date < c.txn_date ? -1 : 1))) {
    let best: BacsMatchInput | null = null; let bestGap = Infinity;
    for (const s of free) {
      if (used.has(s.id) || Math.abs(s.amount - b.amount) > 0.004) continue;
      const gap = Math.abs(daysBetween(s.txn_date, b.txn_date));
      if (gap <= windowDays && gap < bestGap) { best = s; bestGap = gap; }
    }
    if (best) { used.add(best.id); out.push({ bank: b, semtek: best, dayGap: daysBetween(best.txn_date, b.txn_date) }); }
    else out.push({ bank: b, semtek: null, dayGap: null });
  }
  for (const s of free) if (!used.has(s.id)) out.push({ bank: null, semtek: s, dayGap: null });
  return out.sort((a, b) => ((a.bank ?? a.semtek)!.txn_date < (b.bank ?? b.semtek)!.txn_date ? -1 : 1));
}
