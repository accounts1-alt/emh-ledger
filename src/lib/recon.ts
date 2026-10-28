// Semtek vs actual takings. Pure functions so the same logic runs in the app and in tests.
import { round2 } from './parsers';

export interface SemtekDay { txn_date: string; cash: number; cheque: number; credit_card: number; vouchers: number; bacs: number }
export interface CardTxn { txn_date: string; merchant: string; amount: number; against_pos?: boolean }
export interface CountRow { id: string; ref: number; date_from: string; date_to: string; cash_total: number; vouchers_total: number; against_pos?: boolean }
export interface FloatRow { id: string; ref: number; amount: number; date_from: string; date_to: string; unused: boolean }
export interface ChequeRow { received_date: string; amount: number; against_pos: boolean }
export interface VoucherLot { received_date: string; amount: number; against_pos: boolean }
export interface EntryRow { entry_date: string; direction: 'in' | 'out'; account: string; against_pos: boolean; amount: number }
export interface Coverage { source: string; date_from: string; date_to: string }

export const CARD_ACCOUNTS = ['paymentsense', 'amex', 'stripe_shop', 'stripe_office'];
export const TYPES = ['cash', 'cheque', 'vouchers', 'cards', 'bacs'] as const;
export type PayType = typeof TYPES[number];

export type Status = 'match' | 'ok' | 'diff' | 'waiting' | 'none';
export interface Figure { semtek: number; actual: number | null; diff: number | null; status: Status; note?: string }
export interface CashCell extends Figure {
  from: string; to: string; span: number;
  counts: number[]; floats: number[]; countTotal: number; floatTotal: number; entries: number;
}
export interface DayRow {
  date: string; semtekLoaded: boolean;
  /** Cash is checked per count/float period; it sits on the first day of that period (span = days it covers). */
  cash: CashCell | null; cashFrom: string; cashTo: string;
  cheque: Figure; vouchers: Figure; cards: Figure; bacs: Figure;
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

function fig(semtek: number, actual: number | null, note?: string, tolerance = 0): Figure {
  const sm = round2(semtek), ac = actual === null ? null : round2(actual);
  if (ac === null) return { semtek: sm, actual: null, diff: null, status: sm === 0 ? 'none' : 'waiting', note };
  const diff = round2(ac - sm);
  if (sm === 0 && ac === 0) return { semtek: 0, actual: 0, diff: 0, status: 'none', note };
  const status: Status = Math.abs(diff) < 0.005 ? 'match' : Math.abs(diff) <= tolerance + 0.0001 ? 'ok' : 'diff';
  return { semtek: sm, actual: ac, diff, status, note };
}

/** A source counts as loaded for a day if the day falls between its first import and the end of its latest import. */
export function makeCoverage(coverage: Coverage[]) {
  const span = new Map<string, [string, string]>();
  for (const c of coverage) {
    const cur = span.get(c.source);
    span.set(c.source, cur ? [c.date_from < cur[0] ? c.date_from : cur[0], c.date_to > cur[1] ? c.date_to : cur[1]] : [c.date_from, c.date_to]);
  }
  const has = (source: string) => span.has(source);
  const covered = (source: string, d: string) => { const r = span.get(source); return !!r && r[0] <= d && d <= r[1]; };
  return { has, covered, span };
}
export const CARD_SOURCES = ['paymentsense', 'stripe_shop', 'stripe_office'];
export const SOURCE_NAME: Record<string, string> = { semtek: 'Semtek', paymentsense: 'Paymentsense', stripe_shop: 'Stripe Shop', stripe_office: 'Stripe Office', bacs: 'BACS report' };

/**
 * One row per day. Cheques, vouchers, cards and BACS are compared day by day. Cash is compared over the
 * period a count or float covers (several days when one float or count covers more than one day).
 */
export function compare(input: {
  from: string; to: string;
  semtek: SemtekDay[]; cards: CardTxn[]; counts: CountRow[]; floats: FloatRow[];
  cheques: ChequeRow[]; vouchers: VoucherLot[]; entries: EntryRow[];
  bacs: { txn_date: string; amount: number }[]; coverage: Coverage[]; cashTolerance?: number;
}): DayRow[] {
  const tol = input.cashTolerance ?? 0;
  const days = eachDay(input.from, input.to);
  const idx = new Map(days.map((d, i) => [d, i]));
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

  const cov = makeCoverage(input.coverage);
  const semtekLoaded = (d: string) => cov.covered('semtek', d);
  const cardsLoaded = (d: string) => CARD_SOURCES.filter(s => cov.has(s)).every(s => cov.covered(s, d)) && CARD_SOURCES.some(s => cov.has(s));
  const onDay = <T,>(rows: T[], day: (r: T) => string, val: (r: T) => number, d: string) => rows.reduce((s, r) => (day(r) === d ? s + val(r) : s), 0);
  const semOn = (k: keyof SemtekDay, d: string) => onDay(input.semtek, r => r.txn_date, r => Number(r[k]) || 0, d);

  // cash per group
  const cashCells = new Map<number, CashCell>();
  for (const [g, ds] of groups) {
    const inG = (d: string) => groupOf.get(d) === g;
    const counts = input.counts.filter(c => inG(c.date_from) || (c.date_from < input.from && inG(c.date_to)));
    const floats = input.floats.filter(f => !f.unused && (inG(f.date_from) || (f.date_from < input.from && inG(f.date_to))));
    const countTotal = counts.filter(c => c.against_pos !== false).reduce((s, c) => s + Number(c.cash_total), 0);
    const floatTotal = floats.reduce((s, f) => s + Number(f.amount), 0);
    const entries = input.entries.filter(e => e.account === 'cash' && e.direction === 'in' && e.against_pos && inG(e.entry_date)).reduce((s, e) => s + Number(e.amount), 0);
    const semCash = ds.reduce((s, d) => s + semOn('cash', d), 0);
    let actual: number | null = null; let note: string | undefined;
    if (!ds.every(semtekLoaded)) note = 'Semtek not loaded yet';
    else if (counts.length) { actual = countTotal - floatTotal + entries; if (!floats.length) note = 'No float recorded for these dates'; }
    else if (semCash !== 0 || floats.length) note = 'No count entered yet';
    else if (entries) actual = entries;
    const f = fig(semCash, actual, note, tol);
    if (note === 'Semtek not loaded yet') f.status = counts.length || floats.length || entries ? 'waiting' : 'none';
    cashCells.set(g, { ...f, from: ds[0], to: ds[ds.length - 1], span: ds.length, counts: counts.map(c => c.ref), floats: floats.map(x => x.ref), countTotal: round2(countTotal), floatTotal: round2(floatTotal), entries: round2(entries) });
  }

  return days.map(d => {
    const g = groupOf.get(d)!; const cell = cashCells.get(g)!;
    const loaded = semtekLoaded(d);
    const countDone = cell.counts.length > 0;
    const waitSemtek = (f: Figure): Figure => (loaded ? f : { ...f, actual: f.actual, diff: null, status: f.actual || f.semtek ? 'waiting' : 'none', note: 'Semtek not loaded yet' });
    const chq = onDay(input.cheques.filter(c => c.against_pos), c => c.received_date, c => Number(c.amount), d);
    const vch = onDay(input.vouchers.filter(v => v.against_pos), v => v.received_date, v => Number(v.amount), d);
    const cardIn = onDay(input.cards.filter(c => c.against_pos !== false), c => c.txn_date, c => Number(c.amount), d);
    const cardOther = onDay(input.cards.filter(c => c.against_pos === false), c => c.txn_date, c => Number(c.amount), d)
      + onDay(input.entries.filter(e => CARD_ACCOUNTS.includes(e.account) && e.direction === 'in' && !e.against_pos), e => e.entry_date, e => Number(e.amount), d);
    const bacs = onDay(input.bacs, b => b.txn_date, b => Number(b.amount), d);
    const sChq = semOn('cheque', d), sVch = semOn('vouchers', d);
    return {
      date: d, semtekLoaded: loaded,
      cash: cell.from === d ? cell : null, cashFrom: cell.from, cashTo: cell.to,
      cheque: waitSemtek(fig(sChq, countDone || chq ? chq : sChq ? null : 0, !countDone && !chq && sChq ? 'No count entered yet' : undefined)),
      vouchers: waitSemtek(fig(sVch, countDone || vch ? vch : sVch ? null : 0, !countDone && !vch && sVch ? 'No count entered yet' : undefined)),
      cards: waitSemtek(cardsLoaded(d)
        ? fig(semOn('credit_card', d), cardIn, cardOther ? `£${cardOther.toFixed(2)} in other categories left out` : undefined)
        : fig(semOn('credit_card', d), null, 'Card files not imported for this day yet')),
      bacs: waitSemtek(cov.covered('bacs', d) ? fig(semOn('bacs', d), bacs) : fig(semOn('bacs', d), null, 'BACS report not imported for this day yet')),
    };
  });
}

export interface BacsMatchInput { id: string; txn_date: string; amount: number; label: string }
export interface BacsMatch { bank: BacsMatchInput | null; semtek: BacsMatchInput | null; dayGap: number | null }

/** Pair each line on one side with a Semtek line of the same amount within ±window days (0 = same day). Used for BACS, cards and cheques. */
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
