import { useMemo, useState } from 'react';
import { all, supabase } from '../lib/supabase';
import { loadCategories, categoryName, inCategoryOptions, latestSemtekDate } from '../lib/data';
import { addDays } from '../lib/recon';
import { fmtShort, money, r2, today } from '../lib/format';
import { DateRange, useLoad, Loading, ErrorBox, EditDialog, type FieldDef } from '../components/ui';
import { DataGrid, type Col } from '../components/DataGrid';
import { DENOMS } from '../components/CashInput';
import { VOUCH } from '../lib/denoms';

type Line = {
  src: 'opening' | 'count' | 'float' | 'entry' | 'banking'; src_id: string; ref: number | null; mdate: string; what: string;
  reference: string | null; category_id: string | null; amount: number; broken_down: boolean; balance: number; key: string;
} & Record<string, unknown>;

const TABLE: Record<string, string> = { count: 'counts', float: 'floats', entry: 'entries', banking: 'bankings', opening: 'opening_balances' };
const denomFields = DENOMS.map(([k, l]) => ({ key: k, label: `${l} (number)`, type: 'int' } as FieldDef));

/** Every movement of office cash, coin by coin and note by note, with the running balance. */
export default function CashBook() {
  const cats = useLoad(loadCategories, []);
  const book = useLoad(async () => {
    const rows = await all((a, b) => supabase.from('v_cash_book').select('*').order('mdate').range(a, b)) as Line[];
    const order: Record<string, number> = { opening: 0, float: 1, count: 2, entry: 3, banking: 4 };
    rows.sort((x, y) => (x.mdate < y.mdate ? -1 : x.mdate > y.mdate ? 1 : (order[x.src] - order[y.src]) || ((x.ref ?? 0) - (y.ref ?? 0))));
    let bal = 0;
    return rows.map((r, i) => { bal = r2(bal + Number(r.amount)); return { ...r, amount: Number(r.amount), balance: bal, key: `${r.src}-${r.src_id}-${i}` } as Line; });
  }, []);
  const [range, setRange] = useState<[string, string] | null>(null);
  const end = useLoad(async () => (await latestSemtekDate()) ?? today(), []);
  const from = range?.[0] ?? (end.data ? addDays(end.data, -27) : ''), to = range?.[1] ?? (end.data && end.data > today() ? end.data : today());
  const [edit, setEdit] = useState<{ table: string; row: Record<string, unknown>; title: string; fields: FieldDef[] } | null>(null);

  // what should be in the office now, by coin and note
  const now = useMemo(() => {
    const upTo = (book.data ?? []).filter(r => r.mdate <= today());
    const total = r2(upTo.reduce((s, r) => s + r.amount, 0));
    const per = Object.fromEntries(DENOMS.map(([k]) => [k, upTo.reduce((s, r) => s + Number(r[k] ?? 0), 0)]));
    const broken = r2(DENOMS.reduce((s, [k, , v]) => s + per[k] * v, 0));
    return { total, per, broken, rest: r2(total - broken) };
  }, [book.data]);

  const rows = (book.data ?? []).filter(r => r.mdate >= from && r.mdate <= to);
  const cols: Col<Line>[] = [
    { key: 'date', label: 'Date', kind: 'date', value: r => r.mdate, text: r => fmtShort(r.mdate) },
    { key: 'what', label: 'What', value: r => `${r.what}${r.ref ? ` #${r.ref}` : ''}` },
    { key: 'reference', label: 'Reference', value: r => r.reference ?? '' },
    { key: 'category', label: 'Category', value: r => categoryName(cats.data, r.category_id) },
    ...DENOMS.map(([k, l]) => ({ key: k, label: l, kind: 'number' as const, value: (r: Line) => Number(r[k] ?? 0), text: (r: Line) => (Number(r[k]) ? String(r[k]) : ''),
      render: (r: Line) => (Number(r[k]) ? <span className={Number(r[k]) < 0 ? 'bad' : ''}>{Number(r[k])}</span> : ''), className: 'denom-col' })),
    { key: 'in', label: 'In', kind: 'money', total: true, value: r => (r.amount > 0 ? r.amount : 0) },
    { key: 'out', label: 'Out', kind: 'money', total: true, value: r => (r.amount < 0 ? -r.amount : 0) },
    { key: 'balance', label: 'Balance', kind: 'money', value: r => r.balance, render: r => <strong>{money(r.balance)}</strong> },
  ];

  const openEdit = async (r: Line) => {
    const table = TABLE[r.src];
    const got = await all((a, b) => supabase.from(table).select('*').eq('id', r.src_id).range(a, b)) as Record<string, unknown>[];
    const row = got[0]; if (!row) return;
    const fields: FieldDef[] =
      r.src === 'count' ? [{ key: 'date_from', label: 'Day', type: 'date' }, { key: 'date_to', label: 'To', type: 'date' }, ...denomFields,
        ...VOUCH.map(([k, l]) => ({ key: k, label: `Voucher ${l} (number)`, type: 'int' } as FieldDef)), { key: 'category_id', label: 'Category (cash)', type: 'select', options: inCategoryOptions(cats.data, row.category_id) }, { key: 'note', label: 'Note', type: 'text' }]
      : r.src === 'float' ? [{ key: 'prepared_date', label: 'Prepared on', type: 'date' }, { key: 'date_from', label: 'For day', type: 'date' }, { key: 'date_to', label: 'Until', type: 'date' }, ...denomFields,
        { key: 'amount', label: 'Amount £ (worked out from the coins and notes if they are filled in)', type: 'number' }, { key: 'unused', label: 'Not used', type: 'bool' }, { key: 'unused_date', label: 'Back in office on (if not used)', type: 'date' }, { key: 'note', label: 'Note', type: 'text' }]
      : r.src === 'entry' ? [{ key: 'entry_date', label: 'Date', type: 'date' }, ...denomFields, { key: 'amount', label: 'Amount £ (worked out from the coins and notes if they are filled in)', type: 'number' },
        { key: 'category_id', label: 'Category', type: 'select', options: (cats.data ?? []).filter(c => c.direction === row.direction && (!c.voided || c.id === row.category_id)).map(c => [c.id, c.name] as [string, string]) },
        { key: 'reference', label: 'Reference', type: 'text' }, { key: 'note', label: 'Note', type: 'text' }]
      : r.src === 'banking' ? [{ key: 'banking_date', label: 'Banked on', type: 'date' }, ...denomFields, { key: 'amount_received', label: 'Amount £ (worked out from the coins and notes if they are filled in)', type: 'number' }, { key: 'note', label: 'Note', type: 'text' }]
      : [{ key: 'as_of', label: 'As of', type: 'date' }, { key: 'amount', label: 'Amount £', type: 'number' }];
    setEdit({ table, row, title: `Adjust: ${r.what}${r.ref ? ` #${r.ref}` : ''}`, fields });
  };

  if (book.loading || end.loading) return <Loading />;
  if (book.error) return <ErrorBox error={book.error} />;
  return (
    <>
      <section className="card">
        <div className="row between wrap-row"><h2>Office cash now <span className="num">{money(now.total)}</span></h2>
          <span className="small muted">Everything counted in, less floats, cash spent and cash banked, up to today.</span></div>
        <div className="denom-strip">
          {DENOMS.map(([k, l]) => <div key={k} className={now.per[k] < 0 ? 'neg' : ''}><span>{l}</span><strong className="num">{now.per[k]}</strong></div>)}
        </div>
        {Math.abs(now.rest) >= 0.01 && <p className="small muted">{money(now.rest)} of the balance isn't broken down into coins and notes (the opening balance, and anything entered before coins and notes were recorded).</p>}
      </section>
      <div className="row wrap-row toolbar">
        <DateRange from={from} to={to} onChange={(f, t) => setRange([f, t])} />
        <button className="ghost" onClick={book.reload}>Refresh</button>
      </div>
      <section className="card flush">
        <DataGrid rows={rows} rowKey={r => r.key} cols={cols} empty="No cash movements in these dates."
          rowClass={r => (r.broken_down ? '' : 'not-broken')}
          actions={r => <button className="ghost small" onClick={() => openEdit(r)}>Adjust</button>} />
      </section>
      <p className="small muted">Coins and notes are numbers of each (minus = went out). Lines in italics weren't broken down into coins and notes.</p>
      {edit && <EditDialog table={edit.table} row={edit.row} title={edit.title} fields={edit.fields} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); book.reload(); }} />}
    </>
  );
}
