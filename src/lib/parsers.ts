// File importers for Em H Butchers' five data sources.
// Pure functions: take the raw file bytes, return clean rows ready to insert.
import * as XLSX from 'xlsx';
import Papa from 'papaparse';

export type Source = 'semtek' | 'paymentsense' | 'stripe_shop' | 'stripe_office' | 'bacs';
export type Merchant = 'paymentsense' | 'amex' | 'stripe_shop' | 'stripe_office';

export const SOURCE_LABEL: Record<Source, string> = {
  semtek: 'Semtek',
  paymentsense: 'Paymentsense (incl. Amex)',
  stripe_shop: 'Stripe Shop',
  stripe_office: 'Stripe Office',
  bacs: 'BACS report',
};

export interface SemtekRow {
  sale_id: string; type: string; txn_at: string; txn_date: string; station: string;
  operator: string; customer_id: string; account_no: string; last_name: string; first_name: string; company: string;
  cash: number; cheque: number; credit_card: number; vouchers: number; coupons: number; bacs: number;
  account: number; on_account: number; off_account: number; amount: number; notes: string;
}
export interface CardRow {
  merchant: Merchant; ext_id: string; txn_at: string; txn_date: string; amount: number; refunded: number; fee: number;
  customer: string; description: string; payout_ref: string | null; card_scheme: string; card_type: string;
  card_last4: string; terminal_id: string;
}
export interface BacsRow { txn_date: string; description: string; amount: number; occurrence: number }

export type ParseResult =
  | { source: 'semtek'; rows: SemtekRow[]; skipped: number; warnings: string[] }
  | { source: 'paymentsense' | 'stripe_shop' | 'stripe_office'; rows: CardRow[]; skipped: number; warnings: string[] }
  | { source: 'bacs'; rows: BacsRow[]; skipped: number; warnings: string[] };

const pad = (n: number) => String(n).padStart(2, '0');
export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v: unknown): number => {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[£,\s"]/g, '');
  if (s === '' || /not available/i.test(s)) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v)).trim();

/** Excel serial date → 'YYYY-MM-DD HH:MM:SS' with no timezone shifting. */
function serialToStamp(serial: number): string {
  // Excel day 0 = 1899-12-30; work in UTC so the wall-clock time is kept exactly.
  const ms = Math.round(serial * 86400) * 1000;
  const d = new Date(Date.UTC(1899, 11, 30) + ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
/** Any reasonable date cell → 'YYYY-MM-DD' (UK day-first for text). */
function toIsoDate(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return serialToStamp(v).slice(0, 10);
  if (v instanceof Date) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${pad(+m[2])}-${pad(+m[1])}`; }
  return null;
}

function readWorkbookRows(buf: ArrayBuffer): unknown[][] {
  const wb = XLSX.read(buf, { type: 'array', cellDates: false, raw: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null, blankrows: false });
}

// ---------- Semtek ----------
export function parseSemtek(buf: ArrayBuffer): ParseResult {
  const rows = readWorkbookRows(buf);
  const hi = rows.findIndex(r => r.some(c => str(c) === 'Sale/Payment ID'));
  if (hi < 0) throw new Error('This does not look like a Semtek export (no "Sale/Payment ID" column).');
  const head = rows[hi].map(str);
  const col = (name: string) => head.indexOf(name);
  const need = ['Sale/Payment ID', 'Type', 'Date & Time', 'Station', 'Cash', 'Cheque', 'Credit Card', 'Vouchers', 'Bacs'];
  for (const n of need) if (col(n) < 0) throw new Error(`Semtek file is missing the "${n}" column.`);
  const out: SemtekRow[] = []; let skipped = 0; const warnings: string[] = [];
  for (const r of rows.slice(hi + 1)) {
    const id = str(r[col('Sale/Payment ID')]);
    if (!id) { skipped++; continue; } // totals row / blanks
    const dt = r[col('Date & Time')];
    let stamp: string;
    if (typeof dt === 'number') stamp = serialToStamp(dt);
    else { const d = toIsoDate(dt); if (!d) { skipped++; warnings.push(`Line ${id}: unreadable date`); continue; } stamp = d + ' 00:00:00'; }
    const g = (n: string) => (col(n) >= 0 ? r[col(n)] : null);
    out.push({
      sale_id: id, type: str(g('Type')), txn_at: stamp, txn_date: stamp.slice(0, 10), station: str(g('Station')),
      operator: str(g('Operator')), customer_id: str(g('CustomerID')), account_no: str(g('Account No')),
      last_name: str(g('LastName')), first_name: str(g('FirstName')), company: str(g('Company')),
      cash: round2(num(g('Cash'))), cheque: round2(num(g('Cheque'))), credit_card: round2(num(g('Credit Card'))),
      vouchers: round2(num(g('Vouchers'))), coupons: round2(num(g('Coupons'))), bacs: round2(num(g('Bacs'))),
      account: round2(num(g('Account'))), on_account: round2(num(g('OnAccount'))), off_account: round2(num(g('OffAccount'))),
      amount: round2(num(g('Amount'))), notes: str(g('Notes')),
    });
  }
  return { source: 'semtek', rows: out, skipped, warnings };
}

// ---------- CSV helper ----------
function readCsv(buf: ArrayBuffer): Record<string, string>[] {
  let text = new TextDecoder('utf-8').decode(buf);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const res = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
  return res.data;
}

// ---------- Paymentsense (+ Amex) ----------
export function parsePaymentsense(buf: ArrayBuffer, amexFeePct: number): ParseResult {
  const data = readCsv(buf);
  if (!data.length || !('Card scheme' in data[0]) || !('Transaction amount' in data[0]))
    throw new Error('This does not look like a Paymentsense transactions file (no "Card scheme" / "Transaction amount" columns).');
  const out: CardRow[] = []; let skipped = 0; const warnings: string[] = [];
  const seen = new Map<string, number>();
  for (const r of data) {
    const date = toIsoDate(r['Transaction date']);
    if (!date) { skipped++; continue; }
    const time = str(r['Transaction time']) || '00:00:00';
    const type = str(r['Transaction type']);
    let amount = round2(num(r['Transaction amount']));
    if (/refund/i.test(type)) amount = -Math.abs(amount);
    if (/declin|fail|void|cancel/i.test(type)) { skipped++; continue; }
    const amex = /american express|amex/i.test(str(r['Card scheme']));
    const merchant: Merchant = amex ? 'amex' : 'paymentsense';
    const last4 = str(r['Card number']).replace(/\D/g, '').slice(-4);
    const terminal = str(r['Terminal ID']);
    let ext = str(r['Transaction ID']);
    if (!ext || /not available/i.test(ext)) {
      const base = `nk:${date}T${time}|${terminal}|${amount.toFixed(2)}|${last4}`;
      const occ = (seen.get(base) ?? 0) + 1; seen.set(base, occ);
      ext = `${base}#${occ}`;
    }
    out.push({
      merchant, ext_id: ext, txn_at: `${date} ${time}`, txn_date: date, amount, refunded: 0,
      fee: amex ? round2(amount * amexFeePct / 100) : 0,
      customer: '', description: type, payout_ref: null, card_scheme: str(r['Card scheme']), card_type: str(r['Card type']),
      card_last4: last4, terminal_id: terminal,
    });
  }
  return { source: 'paymentsense', rows: out, skipped, warnings };
}

// ---------- Stripe ----------
export const STRIPE_FINGERPRINT: Record<'stripe_shop' | 'stripe_office', string> = {
  stripe_shop: 'AVxUpsKI38',
  stripe_office: 'IKo7WxoBxa',
};
/** The account code Stripe builds into every charge id (ch_3XXXX<account code>…). */
export const stripeFingerprint = (id: string) => (id.startsWith('ch_') || id.startsWith('py_') ? id.slice(9, 19) : '');

export function detectStripeAccount(buf: ArrayBuffer): 'stripe_shop' | 'stripe_office' | null {
  const data = readCsv(buf);
  for (const r of data) {
    const fp = stripeFingerprint(str(r['id']));
    if (fp === STRIPE_FINGERPRINT.stripe_shop) return 'stripe_shop';
    if (fp === STRIPE_FINGERPRINT.stripe_office) return 'stripe_office';
  }
  return null;
}

export function parseStripe(buf: ArrayBuffer, account: 'stripe_shop' | 'stripe_office'): ParseResult {
  const data = readCsv(buf);
  if (!data.length || !('id' in data[0]) || !('Amount' in data[0]) || !('Status' in data[0]))
    throw new Error('This does not look like a Stripe payments export (no "id" / "Amount" / "Status" columns).');
  const dateCol = 'Created date (UTC)' in data[0] ? 'Created date (UTC)' : 'Created (UTC)';
  const out: CardRow[] = []; let skipped = 0; const warnings: string[] = [];
  for (const r of data) {
    const status = str(r['Status']).toLowerCase();
    if (!['paid', 'refunded', 'partially refunded', 'succeeded'].includes(status)) { skipped++; continue; }
    const created = str(r[dateCol]);
    const date = toIsoDate(created);
    if (!date) { skipped++; continue; }
    const time = (created.split(/[ T]/)[1] || '00:00:00').slice(0, 8);
    const gross = num(r['Amount']); const refunded = num(r['Amount Refunded']);
    const desc = str(r['Description']); const custDesc = str(r['Customer Description']);
    const customer = account === 'stripe_shop'
      ? desc.split(' | ')[0].replace(/\s+/g, ' ')
      : (custDesc || desc);
    out.push({
      merchant: account, ext_id: str(r['id']), txn_at: `${date} ${time}`, txn_date: date,
      amount: round2(gross - refunded), refunded: round2(refunded), fee: round2(num(r['Fee'])),
      customer, description: desc.replace(/\s+/g, ' '), payout_ref: str(r['Transfer']) || null,
      card_scheme: '', card_type: '', card_last4: '', terminal_id: '',
    });
  }
  return { source: account, rows: out, skipped, warnings };
}

// ---------- BACS report ----------
export function parseBacs(buf: ArrayBuffer, filename: string): ParseResult {
  let grid: unknown[][];
  if (/\.csv$/i.test(filename)) {
    const text = new TextDecoder('utf-8').decode(buf).replace(/^﻿/, '');
    grid = Papa.parse<unknown[]>(text, { skipEmptyLines: true }).data;
  } else grid = readWorkbookRows(buf);
  const hi = grid.findIndex(r => r.some(c => /^date$/i.test(str(c))));
  if (hi < 0) throw new Error('No "Date" column found in the BACS file.');
  const head = grid[hi].map(c => str(c).toLowerCase());
  const iDate = head.indexOf('date');
  const iDesc = head.findIndex(h => /reference|description|memo/.test(h));
  const iAmt = head.indexOf('amount'); const iDr = head.indexOf('debit'); const iCr = head.indexOf('credit');
  if (iDesc < 0 || (iAmt < 0 && iCr < 0)) throw new Error('BACS file needs Date, Description/Reference and Amount (or Debit/Credit) columns.');
  const out: BacsRow[] = []; let skipped = 0; const seen = new Map<string, number>();
  for (const r of grid.slice(hi + 1)) {
    const date = toIsoDate(r[iDate]);
    if (!date) { skipped++; continue; } // section titles, opening/closing balance, totals
    const amount = round2(iAmt >= 0 ? Math.abs(num(r[iAmt])) : num(r[iCr]) - (iDr >= 0 ? num(r[iDr]) : 0));
    if (amount === 0) { skipped++; continue; }
    const description = str(r[iDesc]);
    const key = `${date}|${description}|${amount.toFixed(2)}`;
    const occ = (seen.get(key) ?? 0) + 1; seen.set(key, occ);
    out.push({ txn_date: date, description, amount, occurrence: occ });
  }
  return { source: 'bacs', rows: out, skipped, warnings: [] };
}

/** Guess a file's source from its contents, to warn when the wrong slot was picked. */
export function sniffSource(buf: ArrayBuffer, filename: string): Source | null {
  if (/\.xlsx?$/i.test(filename)) {
    try {
      const rows = readWorkbookRows(buf).slice(0, 15).flat().map(str);
      if (rows.includes('Sale/Payment ID')) return 'semtek';
      if (rows.some(s => /bacs/i.test(s)) || rows.includes('Debit')) return 'bacs';
    } catch { return null; }
    return null;
  }
  const first = new TextDecoder('utf-8').decode(buf.slice(0, 2000));
  if (/Card scheme/.test(first)) return 'paymentsense';
  if (/"?id"?,.*Status/.test(first)) return detectStripeAccount(buf);
  if (/date/i.test(first) && /amount/i.test(first)) return 'bacs';
  return null;
}

export function parseFile(source: Source, buf: ArrayBuffer, filename: string, amexFeePct: number): ParseResult {
  switch (source) {
    case 'semtek': return parseSemtek(buf);
    case 'paymentsense': return parsePaymentsense(buf, amexFeePct);
    case 'stripe_shop': case 'stripe_office': return parseStripe(buf, source);
    case 'bacs': return parseBacs(buf, filename);
  }
}

export function dateRange(rows: { txn_date: string }[]): [string | null, string | null] {
  if (!rows.length) return [null, null];
  let lo = rows[0].txn_date, hi = rows[0].txn_date;
  for (const r of rows) { if (r.txn_date < lo) lo = r.txn_date; if (r.txn_date > hi) hi = r.txn_date; }
  return [lo, hi];
}

const MONTHS: Record<string, number> = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
/**
 * The period a file covers, where the file says so: Paymentsense puts it in the file name
 * ("Transactions_01-10-2026-07-10-2026_…"), the BACS report in its heading ("For the period 1 October 2026 to 7 October 2026").
 * Otherwise null, and the first/last transaction dates are used.
 */
export function guessPeriod(source: Source, buf: ArrayBuffer, filename: string): [string, string] | null {
  if (source === 'paymentsense') {
    const m = filename.match(/(\d{2})-(\d{2})-(\d{4})-(\d{2})-(\d{2})-(\d{4})/);
    if (m) return [`${m[3]}-${m[2]}-${m[1]}`, `${m[6]}-${m[5]}-${m[4]}`];
  }
  if (source === 'bacs' && /\.xlsx?$/i.test(filename)) {
    try {
      const text = readWorkbookRows(buf).slice(0, 8).flat().map(str).join(' ');
      const m = text.match(/period\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\s+to\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i);
      if (m && MONTHS[m[2].toLowerCase()] && MONTHS[m[5].toLowerCase()])
        return [`${m[3]}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(+m[1])}`, `${m[6]}-${pad(MONTHS[m[5].toLowerCase()])}-${pad(+m[4])}`];
    } catch { return null; }
  }
  return null;
}
