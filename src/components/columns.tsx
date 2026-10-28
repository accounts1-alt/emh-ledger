import type { Col } from './DataGrid';
import { AdjustedMark } from './ui';
import { fmtShort, MERCHANT_LABEL } from '../lib/format';
import { categoryName, type Category } from '../lib/data';

type R = Record<string, unknown> & { id: string; created_at?: string; updated_at?: string };
const t = (r: R, k: string) => String(r[k] ?? '');
const time = (r: R) => t(r, 'txn_at').slice(11, 16);
const dateCol = (key: string, onHist?: (r: R) => void): Col<R> => ({
  key, label: 'Date', kind: 'date', value: r => t(r, key), text: r => fmtShort(t(r, key)),
  render: r => <span className="nowrap">{fmtShort(t(r, key))} {onHist && <AdjustedMark row={r} onClick={() => onHist(r)} />}{r.manual ? <span className="chip muted-chip">by hand</span> : null}</span>,
});
const moneyCol = (key: string, label: string, total = true): Col<R> => ({ key, label, kind: 'money', value: r => Number(r[key] ?? 0), total });

export const semtekCols = (opts: { onHist?: (r: R) => void; withDate?: boolean } = {}): Col<R>[] => [
  ...(opts.withDate === false ? [] : [dateCol('txn_date', opts.onHist)]),
  { key: 'time', label: 'Time', value: time },
  { key: 'type', label: 'Type', value: r => t(r, 'type') },
  { key: 'station', label: 'Till', value: r => t(r, 'station') },
  { key: 'operator', label: 'Operator', value: r => t(r, 'operator') },
  { key: 'last_name', label: 'Customer', value: r => t(r, 'last_name').trim() },
  { key: 'account_no', label: 'Account', value: r => t(r, 'account_no') },
  moneyCol('cash', 'Cash'), moneyCol('cheque', 'Cheque'), moneyCol('credit_card', 'Card'), moneyCol('vouchers', 'Vouchers'),
  moneyCol('bacs', 'BACS'), moneyCol('on_account', 'On account'),
];

export const cardCols = (cats: Category[] | null | undefined, opts: { onHist?: (r: R) => void; withDate?: boolean } = {}): Col<R>[] => [
  ...(opts.withDate === false ? [] : [dateCol('txn_date', opts.onHist)]),
  { key: 'time', label: 'Time', value: time },
  { key: 'merchant', label: 'Provider', value: r => MERCHANT_LABEL[t(r, 'merchant')] ?? t(r, 'merchant') },
  { key: 'customer', label: 'Customer', value: r => t(r, 'customer') },
  { key: 'card', label: 'Card', value: r => (r.card_last4 ? `****${t(r, 'card_last4')} ${t(r, 'card_scheme')}`.trim() : '') },
  { key: 'category', label: 'Category', value: r => categoryName(cats, r.category_id) + (r.against_pos === false ? ' (not in Semtek)' : '') },
  moneyCol('amount', 'Amount'), moneyCol('fee', 'Fee'), { key: 'net', label: 'Net', kind: 'money', total: true, value: r => Number(r.net ?? Number(r.amount ?? 0) - Number(r.fee ?? 0)) },
  { key: 'banked', label: 'Banked', value: r => (r.banking_id ? 'banked' : 'waiting'),
    render: r => (r.banking_id ? <span className="chip ok">banked</span> : <span className="chip pending">waiting</span>) },
];

export const bacsCols = (cats: Category[] | null | undefined, opts: { onHist?: (r: R) => void } = {}): Col<R>[] => [
  dateCol('txn_date', opts.onHist),
  { key: 'description', label: 'Description', value: r => t(r, 'description') },
  { key: 'category', label: 'Category', value: r => categoryName(cats, r.category_id) },
  moneyCol('amount', 'Amount'),
];
