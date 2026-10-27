import { readFileSync } from 'node:fs';
import * as P from '../src/lib/parsers';
import { compare, matchBacs } from '../src/lib/recon';
const A = '/mnt/user-data/attachments/53e246b9-d190-5772-8116-476224f66f7f/';
const buf = (f: string) => { const b = readFileSync(A + f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; };
const files: [P.Source, string][] = [
  ['semtek', '03aebacd-posBF57.xls'],
  ['paymentsense', '1498fc89-Transactions_01-10-2026-07-10-2026_All-locations.csv'],
  ['stripe_shop', 'bafb2aed-unified_payments_-_2026-10-27T123249.180.csv'],
  ['stripe_office', 'b8718749-unified_payments_-_2026-10-27T123212.588.csv'],
  ['bacs', '8003b24c-EM_H_Butchers_Ltd_-_Semtek_Bacs_4.xlsx'],
];
const res: Record<string, any> = {};
for (const [s, f] of files) {
  console.log(s, 'sniffed as', P.sniffSource(buf(f), f));
  const r = P.parseFile(s, buf(f), f, 1.9); res[s] = r;
  console.log(s, 'rows', r.rows.length, 'skipped', r.skipped, P.dateRange(r.rows as any), JSON.stringify(r.rows[0]).slice(0, 220));
}
// old-week files too
for (const f of ['0040bf64-1793102212107_Transactions_20-10-2026-25-10-2026_All-locations.csv','a2287df1-1793102212107_unified_payments_-_2026-10-26T084912.326.csv','852fa56c-1793102212108_unified_payments_-_2026-10-26T084833.297.csv','da8c02ad-1793102275837_EM_H_Butchers_Ltd_-_Semtek_Bacs_3.xlsx','621d5485-1793102353131_posA97A.xls'])
  console.log('sniff', f.slice(0,30), P.sniffSource(buf(f), f));
const sem = res.semtek.rows as P.SemtekRow[];
const byDay = new Map<string, any>();
for (const r of sem) { const d = byDay.get(r.txn_date) ?? { txn_date: r.txn_date, cash: 0, cheque: 0, credit_card: 0, vouchers: 0, bacs: 0 }; for (const k of ['cash','cheque','credit_card','vouchers','bacs']) d[k] += (r as any)[k]; byDay.set(r.txn_date, d); }
const cards = [...res.paymentsense.rows, ...res.stripe_shop.rows, ...res.stripe_office.rows];
const coverage = ['semtek','paymentsense','stripe_shop','stripe_office','bacs'].map(s => ({ source: s, date_from: '2026-10-01', date_to: '2026-10-07' }));
const g = compare({ from: '2026-10-01', to: '2026-10-07', semtek: [...byDay.values()], cards, counts: [], floats: [], cheques: [], vouchers: [], entries: [], bacs: res.bacs.rows, coverage });
for (const x of g) console.log(x.from, x.to, 'cards', x.cards, 'bacs', x.bacs, 'cash', x.cash.semtek, x.cash.note ?? '');
const m = matchBacs(res.bacs.rows.map((b: any, i: number) => ({ id: 'b' + i, txn_date: b.txn_date, amount: b.amount, label: b.description })),
  sem.filter(r => r.bacs).map(r => ({ id: r.sale_id, txn_date: r.txn_date, amount: r.bacs, label: r.last_name })), 2);
for (const x of m) console.log(x.bank?.txn_date, x.bank?.label, x.bank?.amount, '<->', x.semtek?.txn_date, x.semtek?.label, x.semtek?.amount, x.dayGap);
