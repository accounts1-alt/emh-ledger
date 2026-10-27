import { useState } from 'react';
import { all, q, supabase } from '../lib/supabase';

import { fmtShort, money, today, MERCHANT_LABEL } from '../lib/format';
import { PageHead, Tabs, DateRange, useLoad, useToast, Loading, ErrorBox, Empty, EditDialog, ReasonDialog, HistoryDialog, AdjustedMark, Modal, type FieldDef } from '../components/ui';
import { useDefaultRange } from './Compare';

type Tab = 'semtek' | 'cards' | 'bacs';
type Rec = Record<string, unknown> & { id: string; created_at: string; updated_at: string; voided: boolean };

const CONF: Record<Tab, { table: string; date: string; fields: FieldDef[]; search: string[] }> = {
  semtek: {
    table: 'semtek_lines', date: 'txn_date', search: ['last_name', 'account_no', 'sale_id', 'operator', 'notes'],
    fields: [{ key: 'txn_date', label: 'Date', type: 'date' }, { key: 'type', label: 'Type', type: 'select', options: [['Sale', 'Sale'], ['Payment', 'Payment']] }, { key: 'last_name', label: 'Customer', type: 'text' },
      { key: 'cash', label: 'Cash £', type: 'number' }, { key: 'cheque', label: 'Cheque £', type: 'number' }, { key: 'credit_card', label: 'Credit card £', type: 'number' },
      { key: 'vouchers', label: 'Vouchers £', type: 'number' }, { key: 'bacs', label: 'BACS £', type: 'number' }, { key: 'on_account', label: 'On account £', type: 'number' }, { key: 'notes', label: 'Notes', type: 'text' }],
  },
  cards: {
    table: 'card_txns', date: 'txn_date', search: ['customer', 'description', 'ext_id', 'card_last4', 'payout_ref'],
    fields: [{ key: 'txn_date', label: 'Date', type: 'date' }, { key: 'amount', label: 'Amount £', type: 'number' }, { key: 'fee', label: 'Fee £', type: 'number' }, { key: 'customer', label: 'Customer', type: 'text' }],
  },
  bacs: {
    table: 'bacs_lines', date: 'txn_date', search: ['description'],
    fields: [{ key: 'txn_date', label: 'Date', type: 'date' }, { key: 'description', label: 'Description', type: 'text' }, { key: 'amount', label: 'Amount £', type: 'number' }],
  },
};

function initialRange(): [string, string] | null {
  try { const r = sessionStorage.getItem('records-range'); if (r) { sessionStorage.removeItem('records-range'); return JSON.parse(r); } } catch { /* storage unavailable */ }
  return null;
}

export default function RecordsPage() {
  const toast = useToast();
  const [init] = useState(initialRange);
  const [dFrom, dTo, setRange, ready] = useDefaultRange(7);
  const [override, setOverride] = useState<[string, string] | null>(init);
  const from = override?.[0] ?? dFrom, to = override?.[1] ?? dTo;
  const [tab, setTab] = useState<Tab>('semtek');
  const [search, setSearch] = useState(''); const [showVoided, setShowVoided] = useState(false);
  const c = CONF[tab];
  const list = useLoad(async () => (ready || override) ? all((a, b) => {
    let qy = supabase.from(c.table).select('*').gte(c.date, from).lte(c.date, to).order(c.date).order('created_at').range(a, b);
    if (!showVoided) qy = qy.eq('voided', false);
    return qy;
  }) as Promise<Rec[]> : null, [tab, from, to, showVoided, ready]);
  const [edit, setEdit] = useState<Rec | null>(null); const [voiding, setVoiding] = useState<Rec | null>(null); const [hist, setHist] = useState<Rec | null>(null);
  const [adding, setAdding] = useState(false);
  const s = search.trim().toLowerCase();
  const rows = (list.data ?? []).filter(r => !s || c.search.some(k => String(r[k] ?? '').toLowerCase().includes(s)) || String(r.amount ?? '').includes(s));

  return (
    <>
      <PageHead title="Records" sub="Every imported line. Adjust a figure that is wrong at source: the app keeps your corrected figure and the original in its history.">
        {(ready || override) && <DateRange from={from} to={to} onChange={(f, t) => { setOverride([f, t]); setRange(f, t); }} />}
      </PageHead>
      <Tabs value={tab} onChange={setTab} items={[['semtek', 'Semtek lines'], ['cards', 'Card transactions'], ['bacs', 'BACS report lines']]} />
      <div className="row wrap-row toolbar">
        <input id="rec-search" className="search" placeholder="Search name, reference, amount…" value={search} onChange={e => setSearch(e.target.value)} />
        <label className="check small"><input type="checkbox" checked={showVoided} onChange={e => setShowVoided(e.target.checked)} /> Show voided</label>
        {tab === 'semtek' && <button className="ghost" onClick={() => setAdding(true)}>+ Add a missing Semtek line</button>}
      </div>
      {list.loading || !list.data ? (list.error ? <ErrorBox error={list.error} /> : <Loading />) : !rows.length ? <Empty>No lines for these dates{s ? ' match your search' : ''}.</Empty> : (
        <section className="card flush"><div className="table-wrap"><table>
          {tab === 'semtek' && <>
            <thead><tr><th>Date</th><th>Time</th><th>Type</th><th>Till</th><th>Customer</th><th className="r">Cash</th><th className="r">Cheque</th><th className="r">Card</th><th className="r">Vouchers</th><th className="r">BACS</th><th className="r">On account</th><th /></tr></thead>
            <tbody>{rows.map(r => (
              <tr key={r.id} className={r.voided ? 'voided' : ''}><td className="nowrap">{fmtShort(String(r.txn_date))} <AdjustedMark row={r} onClick={() => setHist(r)} />{r.manual ? <span className="chip muted-chip">added by hand</span> : null}</td>
                <td className="muted small">{String(r.txn_at ?? '').slice(11, 16)}</td><td>{String(r.type)}</td><td className="muted small">{String(r.station)}</td>
                <td className="wrap">{String(r.last_name ?? '')}<div className="muted small">{String(r.account_no ?? '')}</div></td>
                {['cash', 'cheque', 'credit_card', 'vouchers', 'bacs', 'on_account'].map(k => <td key={k} className="r num">{money(Number(r[k]), { blankZero: true })}</td>)}
                <td className="nowrap">{!r.voided && <><button className="ghost small" onClick={() => setEdit(r)}>Adjust</button><button className="ghost small" onClick={() => setVoiding(r)}>Void</button></>}</td></tr>))}</tbody>
            <tfoot><tr><th colSpan={5}>Total ({rows.filter(r => !r.voided).length} lines)</th>{['cash', 'cheque', 'credit_card', 'vouchers', 'bacs', 'on_account'].map(k => <td key={k} className="r num">{money(rows.filter(r => !r.voided).reduce((x, r) => x + Number(r[k]), 0))}</td>)}<td /></tr></tfoot>
          </>}
          {tab === 'cards' && <>
            <thead><tr><th>Date</th><th>Time</th><th>Provider</th><th>Customer / card</th><th className="r">Amount</th><th className="r">Fee</th><th className="r">Net</th><th>Banked</th><th /></tr></thead>
            <tbody>{rows.map(r => (
              <tr key={r.id} className={r.voided ? 'voided' : ''}><td className="nowrap">{fmtShort(String(r.txn_date))} <AdjustedMark row={r} onClick={() => setHist(r)} /></td><td className="muted small">{String(r.txn_at ?? '').slice(11, 16)}</td>
                <td>{MERCHANT_LABEL[String(r.merchant)]}</td><td className="wrap">{String(r.customer || '')}{r.card_last4 ? <span className="muted small"> ****{String(r.card_last4)} {String(r.card_scheme ?? '')}</span> : null}</td>
                <td className="r num">{money(Number(r.amount))}</td><td className="r num">{money(Number(r.fee), { blankZero: true })}</td><td className="r num">{money(Number(r.net))}</td>
                <td>{r.banking_id ? <span className="chip ok">banked</span> : <span className="chip pending">waiting</span>}</td>
                <td className="nowrap">{!r.voided && <><button className="ghost small" onClick={() => setEdit(r)}>Adjust</button><button className="ghost small" onClick={() => setVoiding(r)}>Void</button></>}</td></tr>))}</tbody>
            <tfoot><tr><th colSpan={4}>Total</th>{['amount', 'fee', 'net'].map(k => <td key={k} className="r num">{money(rows.filter(r => !r.voided).reduce((x, r) => x + Number(r[k]), 0))}</td>)}<td colSpan={2} /></tr></tfoot>
          </>}
          {tab === 'bacs' && <>
            <thead><tr><th>Date</th><th>Description</th><th className="r">Amount</th><th /></tr></thead>
            <tbody>{rows.map(r => (
              <tr key={r.id} className={r.voided ? 'voided' : ''}><td className="nowrap">{fmtShort(String(r.txn_date))} <AdjustedMark row={r} onClick={() => setHist(r)} /></td><td>{String(r.description)}</td><td className="r num">{money(Number(r.amount))}</td>
                <td className="nowrap">{!r.voided && <><button className="ghost small" onClick={() => setEdit(r)}>Adjust</button><button className="ghost small" onClick={() => setVoiding(r)}>Void</button></>}</td></tr>))}</tbody>
            <tfoot><tr><th colSpan={2}>Total</th><td className="r num">{money(rows.filter(r => !r.voided).reduce((x, r) => x + Number(r.amount), 0))}</td><td /></tr></tfoot>
          </>}
        </table></div></section>
      )}
      {edit && <EditDialog table={c.table} row={edit} fields={c.fields} title="Adjust line" onClose={() => setEdit(null)} onSaved={() => { setEdit(null); list.reload(); }} />}
      {voiding && <ReasonDialog title="Void line" danger confirm="Void line" onCancel={() => setVoiding(null)} prompt="This line will be left out of every report and comparison. It stays in the change history and can be seen with “Show voided”."
        onConfirm={async reason => { await q(supabase.from(c.table).update({ voided: true, change_reason: reason }).eq('id', voiding.id)); setVoiding(null); list.reload(); toast('Line voided.'); }} />}
      {hist && <HistoryDialog table={c.table} id={hist.id} title="Line history" onClose={() => setHist(null)} />}
      {adding && <AddSemtek onClose={() => setAdding(false)} onSaved={() => { setAdding(false); list.reload(); }} defaultDate={to || today()} />}
    </>
  );
}

function AddSemtek({ onClose, onSaved, defaultDate }: { onClose: () => void; onSaved: () => void; defaultDate: string }) {
  const toast = useToast();
  const [f, setF] = useState({ txn_date: defaultDate, type: 'Sale', last_name: '', cash: '', cheque: '', credit_card: '', vouchers: '', bacs: '', reason: '' });
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const amt = ['cash', 'cheque', 'credit_card', 'vouchers', 'bacs'] as const;
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      if (!f.reason.trim()) throw new Error('Say why this line is being added.');
      const vals = Object.fromEntries(amt.map(k => [k, Number(f[k]) || 0]));
      const total = Object.values(vals).reduce((s, v) => s + v, 0);
      if (!total) throw new Error('Enter at least one amount.');
      await q(supabase.from('semtek_lines').insert({ sale_id: `MANUAL-${crypto.randomUUID()}`, type: f.type, txn_date: f.txn_date, txn_at: `${f.txn_date} 00:00:00`, station: 'manual', last_name: f.last_name || null, ...vals, amount: total, off_account: f.type === 'Payment' ? total : 0, manual: true, notes: `Added by hand: ${f.reason.trim()}` }));
      toast('Line added.'); onSaved();
    } catch (e) { setErr(String((e as Error).message)); setBusy(false); }
  };
  return (
    <Modal title="Add a missing Semtek line" onClose={onClose}>
      <div className="stack">
        <p className="small muted">For a sale or payment that should be in Semtek but isn't. It is marked “added by hand” everywhere.</p>
        <div className="grid2">
          <label className="field"><span>Date</span><input id="as-date" type="date" value={f.txn_date} onChange={e => setF({ ...f, txn_date: e.target.value })} /></label>
          <label className="field"><span>Type</span><select id="as-type" value={f.type} onChange={e => setF({ ...f, type: e.target.value })}><option>Sale</option><option>Payment</option></select></label>
          <label className="field"><span>Customer</span><input id="as-name" value={f.last_name} onChange={e => setF({ ...f, last_name: e.target.value })} /></label>
          {amt.map(k => <label key={k} className="field"><span>{k === 'credit_card' ? 'Card' : k === 'bacs' ? 'BACS' : k[0].toUpperCase() + k.slice(1)} £</span><input id={`as-${k}`} type="number" step="0.01" value={f[k]} onChange={e => setF({ ...f, [k]: e.target.value })} /></label>)}
        </div>
        <label className="field"><span>Reason</span><input id="as-reason" value={f.reason} onChange={e => setF({ ...f, reason: e.target.value })} placeholder="e.g. Payment taken on paper while the till was down" /></label>
        {err && <ErrorBox error={err} />}
        <div className="row end"><button className="ghost" onClick={onClose}>Cancel</button><button className="primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Add line'}</button></div>
      </div>
    </Modal>
  );
}
