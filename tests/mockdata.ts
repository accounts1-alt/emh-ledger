import { readFileSync, writeFileSync } from 'node:fs';
import * as P from '../src/lib/parsers';
const A = '/mnt/user-data/attachments/53e246b9-d190-5772-8116-476224f66f7f/';
const buf = (f: string) => { const b = readFileSync(A + f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; };
const sem = P.parseSemtek(buf('03aebacd-posBF57.xls')).rows;
const cards = [...P.parsePaymentsense(buf('1498fc89-Transactions_01-10-2026-07-10-2026_All-locations.csv'), 1.9).rows,
  ...P.parseStripe(buf('bafb2aed-unified_payments_-_2026-10-27T123249.180.csv'), 'stripe_shop').rows,
  ...P.parseStripe(buf('b8718749-unified_payments_-_2026-10-27T123212.588.csv'), 'stripe_office').rows];
const bacs = P.parseBacs(buf('8003b24c-EM_H_Butchers_Ltd_-_Semtek_Bacs_4.xlsx'), 'x.xlsx').rows;
const now = new Date().toISOString();
let n = 0; const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const daily = new Map<string, any>();
for (const r of sem) { const d = daily.get(r.txn_date) ?? { txn_date: r.txn_date, cash: 0, cheque: 0, credit_card: 0, vouchers: 0, bacs: 0, on_account: 0, lines: 0 }; for (const k of ['cash','cheque','credit_card','vouchers','bacs','on_account']) d[k] = Math.round((d[k] + (r as any)[k]) * 100) / 100; d.lines++; daily.set(r.txn_date, d); }
const cd = new Map<string, any>();
for (const c of cards) { const k = c.merchant + c.txn_date; const d = cd.get(k) ?? { merchant: c.merchant, txn_date: c.txn_date, gross: 0, fee: 0, net: 0, txns: 0, unbanked_gross: 0, unbanked_net: 0, unbanked_txns: 0, payout_refs: c.payout_ref };
  d.gross += c.amount; d.fee += c.fee; d.net += c.amount - c.fee; d.txns++; d.unbanked_gross += c.amount; d.unbanked_net += c.amount - c.fee; d.unbanked_txns++; cd.set(k, d); }
const out = {
  settings: [['amex_fee_pct', 1.9, 'Amex fee %'], ['voucher_fee_pct', 1, 'Voucher scheme fee %'], ['default_float', 90, 'Default float amount (£)'], ['bacs_window_days', 2, 'BACS matching window (days either side)']].map(([key, value, label]) => ({ id: id(), key, value, label })),
  categories: [['Semtek (POS)', 'in', true, 'pos', 1], ['Wholesale', 'in', false, null, 10], ['Loan', 'in', false, null, 20], ['Expenses', 'out', false, null, 10], ['RM', 'out', false, null, 20], ['Loan', 'out', false, null, 30]].map(([name, direction, against_pos_default, system_key, sort]) => ({ id: id(), name, direction, against_pos_default, system_key, sort, voided: false })),
  semtek_lines: sem.map(r => ({ ...r, id: id(), voided: false, manual: false, created_at: now, updated_at: now })),
  card_txns: cards.map(r => ({ ...r, id: id(), net: Math.round((r.amount - r.fee) * 100) / 100, banking_id: null, voided: false, created_at: now, updated_at: now })),
  bacs_lines: bacs.map(r => ({ ...r, id: id(), voided: false, created_at: now, updated_at: now })),
  v_semtek_daily: [...daily.values()],
  v_card_daily: [...cd.values()],
  v_coverage: ['semtek', 'paymentsense', 'stripe_shop', 'stripe_office', 'bacs'].map(source => ({ source, date_from: '2026-10-01', date_to: '2026-10-07' })),
  counts: [{ id: id(), ref: 1, date_from: '2026-10-02', date_to: '2026-10-02', cash_total: 122.04, vouchers_total: 0, coins_total: 22.04, notes_total: 100, note: null, created_at: now, updated_at: now },
           { id: id(), ref: 2, date_from: '2026-10-06', date_to: '2026-10-07', cash_total: 396.82, vouchers_total: 0, coins_total: 36.82, notes_total: 360, note: null, created_at: now, updated_at: now }],
  floats: [{ id: id(), ref: 1, amount: 92.18, date_from: '2026-10-02', date_to: '2026-10-02', unused: false }, { id: id(), ref: 2, amount: 183, date_from: '2026-10-06', date_to: '2026-10-07', unused: false }],
  cheques: [{ id: id(), received_date: '2026-10-02', amount: 100, against_pos: true, payer: 'Stark', bank: 'HSBC', cheque_no: '000123', status: 'office', posting_id: null, banking_id: null, bounced: false, created_at: now, updated_at: now },
            { id: id(), received_date: '2026-10-07', amount: 330, against_pos: true, payer: 'Lemberger', bank: 'Barclays', cheque_no: '004411', status: 'office', posting_id: null, banking_id: null, bounced: false, created_at: now, updated_at: now }],
  voucher_lots: [{ id: id(), received_date: '2026-10-01', amount: 20, against_pos: true, count_id: null, entry_id: null, posting_id: null }],
  v_movements: [{ account: 'cash', mdate: '2026-10-02', amount: 122.04, detail: 'Count #1', src: 'count', src_id: null }, { account: 'cash', mdate: '2026-10-01', amount: -275.18, detail: 'Floats', src: 'float', src_id: null }, { account: 'float', mdate: '2026-10-01', amount: 275.18, detail: 'Floats', src: 'float', src_id: null }, { account: 'float', mdate: '2026-10-02', amount: -92.18, detail: 'Float #1 counted back', src: 'float', src_id: null }, { account: 'cheques_office', mdate: '2026-10-02', amount: 430, detail: 'Cheques', src: 'cheque', src_id: null }, { account: 'paymentsense', mdate: '2026-10-07', amount: 1030.26, detail: 'Card takings', src: 'cards', src_id: null }],
};
writeFileSync(process.argv[2], JSON.stringify(out));
console.log('mock rows', Object.fromEntries(Object.entries(out).map(([k, v]) => [k, (v as any[]).length])));
