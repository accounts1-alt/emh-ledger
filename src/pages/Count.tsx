import { useMemo, useState } from 'react';
import { q, rpc, supabase } from '../lib/supabase';
import { addDays } from '../lib/recon';
import { loadCompare, loadCategories, inCategoryOptions, categoryName } from '../lib/data';
import { fmtShort, fmtRange, money, r2, today } from '../lib/format';
import { PageHead, useLoad, useToast, Loading, ErrorBox, Empty, EditDialog, ReasonDialog, HistoryDialog, AdjustedMark, type FieldDef } from '../components/ui';
import { CompareTable } from './Compare';
import { COINS, NOTES, VOUCH } from '../lib/denoms';
export { COINS, NOTES, VOUCH };

const ALL = [...COINS, ...NOTES, ...VOUCH];

type Row = { date_from: string; date_to: string; note: string } & Record<string, string>;
type Chq = { day: string; bank: string; cheque_no: string; payer: string; amount: string };
type CountRec = { id: string; ref: number; date_from: string; date_to: string; cash_total: number; vouchers_total: number; coins_total: number; notes_total: number; note: string | null; category_id: string; against_pos: boolean; created_at: string; updated_at: string } & Record<string, unknown>;

const blankRow = (d: string): Row => ({ date_from: d, date_to: '', note: '', ...Object.fromEntries(ALL.map(([k]) => [k, ''])) } as Row);
const sumOf = (r: Row, set: typeof ALL) => r2(set.reduce((s, [k, , v]) => s + (Number(r[k]) || 0) * v, 0));
const nextOpenDays = (start: string, n: number) => { const out: string[] = []; let d = start; while (out.length < n) { if (new Date(d + 'T12:00:00Z').getUTCDay() !== 6) out.push(d); d = addDays(d, 1); } return out; };

export default function CountPage() {
  const toast = useToast();
  const recent = useLoad(() => q(supabase.from('counts').select('*').eq('voided', false).order('date_from', { ascending: false }).limit(30)) as Promise<CountRec[]>, []);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [cheques, setCheques] = useState<Chq[]>([]);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<[string, string] | null>(null);
  const cats = useLoad(loadCategories, []);
  const [edit, setEdit] = useState<CountRec | null>(null); const [voiding, setVoiding] = useState<CountRec | null>(null); const [hist, setHist] = useState<CountRec | null>(null);

  // start the form at the day after the last count, skipping Saturdays
  const start = useMemo(() => {
    const last = recent.data?.[0]?.date_to; return last ? addDays(last, 1) : addDays(today(), -7);
  }, [recent.data]);
  const form = rows ?? nextOpenDays(start, 6).map(blankRow);
  const setForm = (fn: (r: Row[]) => Row[]) => setRows(fn(form));
  const setCell = (i: number, k: string, v: string) => setForm(r => r.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const used = form.filter(r => r.date_from && (sumOf(r, ALL) > 0 || r.note));
  const days = used.map(r => r.date_from);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const chqs = cheques.filter(c => Number(c.amount));
      for (const c of chqs) if (!c.day) throw new Error('Choose the day each cheque came in.');
      // cheques on a day with no cash or vouchers counted are saved on their own
      const loose = chqs.filter(c => !days.includes(c.day));
      const payload = used.map(r => ({
        date_from: r.date_from, date_to: r.date_to || r.date_from, note: r.note,
        ...Object.fromEntries(ALL.map(([k]) => [k, Number(r[k]) || 0])),
        cheques: cheques.filter(c => c.day === r.date_from && Number(c.amount)).map(c => ({ received_date: c.day, bank: c.bank, cheque_no: c.cheque_no, payer: c.payer, amount: Number(c.amount) })),
      }));
      if (!payload.length && !loose.length) throw new Error('Fill in at least one day or one cheque.');
      if (payload.length) await rpc('save_count_batch', { p_rows: payload });
      if (loose.length) await q(supabase.from('cheques').insert(loose.map(c => ({ received_date: c.day, bank: c.bank || null, cheque_no: c.cheque_no || null, payer: c.payer || null, amount: Number(c.amount), against_pos: true }))));
      const allDays = [...used.flatMap(r => [r.date_from, r.date_to || r.date_from]), ...loose.map(c => c.day)];
      setSaved([allDays.reduce((a, d) => (d < a ? d : a)), allDays.reduce((a, d) => (d > a ? d : a))]); setRows(null); setCheques([]); recent.reload();
      toast([payload.length ? `${payload.length} count${payload.length > 1 ? 's' : ''}` : '', loose.length ? `${loose.length} cheque${loose.length > 1 ? 's' : ''} on ${payload.length ? 'days with no cash count' : 'their own'}` : ''].filter(Boolean).join(' and ') + ' saved.');
    } catch (e) { setErr(String((e as Error).message)); }
    setBusy(false);
  };

  return (
    <>
      <PageHead title="Weekly count" sub="Enter the shop's counts for the week. Each row is saved to its own date and compared with Semtek. Use “to” when one count covers several days." />
      {saved && <SavedResult range={saved} onClose={() => setSaved(null)} />}
      <div className="count-layout">
      <section className="card flush">
        <div className="table-wrap"><table className="count-grid">
          <thead>
            <tr><th /><th colSpan={COINS.length + 1} className="grp">Coins (number counted)</th><th colSpan={NOTES.length + 1} className="grp">Notes (number counted)</th><th className="grp">Cash</th><th /></tr>
            <tr><th className="l">Day</th>{COINS.map(([k, l]) => <th key={k}>{l}</th>)}<th className="r">£</th>{NOTES.map(([k, l]) => <th key={k}>{l}</th>)}<th className="r">£</th><th className="r">Total</th><th /></tr>
          </thead>
          <tbody>{form.map((r, i) => (
            <tr key={i}>
              <td className="day-cell">
                <input id={`cd-${i}-from`} type="date" value={r.date_from} onChange={e => setCell(i, 'date_from', e.target.value)} aria-label="Day" />
                {r.date_to !== ''
                  ? <label className="to-row"><span>to</span><input id={`cd-${i}-to`} type="date" value={r.date_to} min={r.date_from} onChange={e => setCell(i, 'date_to', e.target.value)} /></label>
                  : <button className="linkish small" onClick={() => setCell(i, 'date_to', addDays(r.date_from, 1))}>covers more days?</button>}
              </td>
              {COINS.map(([k]) => <td key={k}><input id={`cd-${i}-${k}`} className="cnt" type="number" min="0" inputMode="numeric" value={r[k]} onChange={e => setCell(i, k, e.target.value)} /></td>)}
              <td className="r num sub">{money(sumOf(r, COINS), { blankZero: true })}</td>
              {NOTES.map(([k]) => <td key={k}><input id={`cd-${i}-${k}`} className="cnt" type="number" min="0" inputMode="numeric" value={r[k]} onChange={e => setCell(i, k, e.target.value)} /></td>)}
              <td className="r num sub">{money(sumOf(r, NOTES), { blankZero: true })}</td>
              <td className="r num"><strong>{money(sumOf(r, [...COINS, ...NOTES]), { blankZero: true })}</strong></td>
              <td><button className="ghost small" aria-label="Remove day" onClick={() => setForm(x => x.filter((_, j) => j !== i))}>✕</button></td>
            </tr>
          ))}</tbody>
          <tfoot><tr><td><button className="ghost small" onClick={() => setForm(x => [...x, blankRow(x.length ? addDays(x[x.length - 1].date_from, 1) : start)])}>+ Add a day</button></td>
            <td colSpan={COINS.length} /><td className="r num">{money(form.reduce((s, r) => s + sumOf(r, COINS), 0))}</td><td colSpan={NOTES.length} /><td className="r num">{money(form.reduce((s, r) => s + sumOf(r, NOTES), 0))}</td>
            <td className="r num"><strong>{money(form.reduce((s, r) => s + sumOf(r, [...COINS, ...NOTES]), 0))}</strong></td><td /></tr></tfoot>
        </table></div>
      </section>
      <section className="card flush">
        <div className="table-wrap"><table className="count-grid">
          <thead>
            <tr><th /><th colSpan={VOUCH.length + 1} className="grp">Vouchers (number counted)</th></tr>
            <tr><th className="l">Day</th>{VOUCH.map(([k, l]) => <th key={k}>{l}</th>)}<th className="r">£</th></tr>
          </thead>
          <tbody>{form.map((r, i) => (
            <tr key={i}>
              <td className="day-label nowrap">{r.date_from ? fmtShort(r.date_from) : '–'}</td>
              {VOUCH.map(([k]) => <td key={k}><input id={`cd-${i}-${k}`} className="cnt" type="number" min="0" inputMode="numeric" value={r[k]} onChange={e => setCell(i, k, e.target.value)} /></td>)}
              <td className="r num sub">{money(sumOf(r, VOUCH), { blankZero: true })}</td>
            </tr>
          ))}</tbody>
          <tfoot><tr><td /><td colSpan={VOUCH.length} /><td className="r num">{money(form.reduce((s, r) => s + sumOf(r, VOUCH), 0))}</td></tr></tfoot>
        </table></div>
      </section>
      </div>

      <section className="card">
        <h2>Cheques</h2>
        {cheques.length === 0 && <p className="muted small">No cheques added for this batch.</p>}
        {cheques.length > 0 && <div className="table-wrap"><table>
          <thead><tr><th>Day</th><th>Bank</th><th>Cheque no.</th><th>Name</th><th className="r">Amount £</th><th /></tr></thead>
          <tbody>{cheques.map((c, i) => {
            const set = (k: keyof Chq, v: string) => setCheques(x => x.map((y, j) => (j === i ? { ...y, [k]: v } : y)));
            return (
              <tr key={i}>
                <td><select id={`chq-${i}-day`} value={c.day} onChange={e => set('day', e.target.value)}><option value="">Choose…</option>{form.filter(r => r.date_from).map(r => <option key={r.date_from} value={r.date_from}>{fmtShort(r.date_from)}</option>)}</select></td>
                <td><input id={`chq-${i}-bank`} value={c.bank} onChange={e => set('bank', e.target.value)} /></td>
                <td><input id={`chq-${i}-no`} value={c.cheque_no} onChange={e => set('cheque_no', e.target.value)} /></td>
                <td><input id={`chq-${i}-payer`} value={c.payer} onChange={e => set('payer', e.target.value)} /></td>
                <td><input id={`chq-${i}-amt`} className="r" type="number" step="0.01" min="0" value={c.amount} onChange={e => set('amount', e.target.value)} /></td>
                <td><button className="ghost small" aria-label="Remove cheque" onClick={() => setCheques(x => x.filter((_, j) => j !== i))}>✕</button></td>
              </tr>);
          })}</tbody>
          <tfoot><tr><td colSpan={4} className="r">Cheques total</td><td className="r num">{money(cheques.reduce((s, c) => s + (Number(c.amount) || 0), 0))}</td><td /></tr></tfoot>
        </table></div>}
        <button className="ghost small" onClick={() => setCheques(x => [...x, { day: x[x.length - 1]?.day ?? form[0]?.date_from ?? '', bank: '', cheque_no: '', payer: '', amount: '' }])}>+ Add a cheque</button>
      </section>

      {err && <ErrorBox error={err} />}
      <div className="row end sticky-actions">
        <span className="muted small">{used.length} day{used.length === 1 ? '' : 's'} filled · {cheques.filter(c => Number(c.amount)).length} cheque{cheques.length === 1 ? '' : 's'}</span>
        <button className="ghost" onClick={() => { setRows(null); setCheques([]); }}>Clear</button>
        <button className="primary" disabled={busy || (!used.length && !cheques.some(c => Number(c.amount)))} onClick={save}>{busy ? 'Saving…' : 'Save counts'}</button>
      </div>

      <section className="card">
        <h2>Recent counts</h2>
        {recent.loading ? <Loading /> : recent.error ? <ErrorBox error={recent.error} /> : !recent.data?.length ? <Empty>No counts yet.</Empty> : (
          <div className="table-wrap"><table>
            <thead><tr><th>#</th><th>Date</th><th className="r">Coins</th><th className="r">Notes</th><th className="r">Cash</th><th className="r">Vouchers</th><th>Category</th><th>Note</th><th /></tr></thead>
            <tbody>{recent.data.map(c => (
              <tr key={c.id}><td className="muted">{c.ref}</td><td className="nowrap">{fmtRange(c.date_from, c.date_to)} <AdjustedMark row={c} onClick={() => setHist(c)} /></td>
                <td className="r num">{money(c.coins_total)}</td><td className="r num">{money(c.notes_total)}</td><td className="r num"><strong>{money(c.cash_total)}</strong></td>
                <td className="r num">{money(c.vouchers_total, { blankZero: true })}</td><td className="small">{categoryName(cats.data, c.category_id)}</td><td className="small">{c.note}</td>
                <td className="nowrap"><button className="ghost small" onClick={() => setEdit(c)}>Adjust</button><button className="ghost small" onClick={() => setVoiding(c)}>Void</button></td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      {edit && <EditDialog table="counts" row={edit} title={`Adjust count #${edit.ref}`} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); recent.reload(); }}
        fields={[{ key: 'date_from', label: 'Day', type: 'date' }, { key: 'date_to', label: 'To', type: 'date' },
          ...ALL.map(([k, l]) => ({ key: k, label: `${k.startsWith('v') ? 'Voucher ' : ''}${l} (count)`, type: 'int' } as FieldDef)), { key: 'category_id', label: 'Category (cash)', type: 'select', options: inCategoryOptions(cats.data, edit.category_id) }, { key: 'against_pos', label: 'Cash should be in Semtek', type: 'bool' }, { key: 'note', label: 'Note', type: 'text' }]} />}
      {voiding && <ReasonDialog title={`Void count #${voiding.ref}`} danger confirm="Void count" onCancel={() => setVoiding(null)}
        prompt={<>This removes the {fmtRange(voiding.date_from, voiding.date_to)} count ({money(voiding.cash_total)} cash) and its cheques from every report. It stays in the change history.</>}
        onConfirm={async reason => {
          await q(supabase.from('cheques').update({ voided: true, change_reason: `Count #${voiding.ref} voided: ${reason}` }).eq('count_id', voiding.id).eq('voided', false).is('posting_id', null));
          await q(supabase.from('counts').update({ voided: true, change_reason: reason }).eq('id', voiding.id));
          setVoiding(null); recent.reload(); toast('Count voided.');
        }} />}
      {hist && <HistoryDialog table="counts" id={hist.id} title={`History of count #${hist.ref}`} onClose={() => setHist(null)} />}
    </>
  );
}

function SavedResult({ range, onClose }: { range: [string, string]; onClose: () => void }) {
  const { data, error, loading } = useLoad(() => loadCompare(range[0], range[1]), [range[0], range[1]]);
  return (
    <section className="card highlight">
      <div className="row between"><h2>Saved – here is how it compares with Semtek</h2><button className="ghost small" onClick={onClose}>Hide</button></div>
      {loading ? <Loading /> : error ? <ErrorBox error={error} /> : <CompareTable days={data!.days} />}
    </section>
  );
}
