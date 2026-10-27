import { useState } from 'react';
import { q, supabase } from '../lib/supabase';
import { addDays } from '../lib/recon';
import { loadSettings } from '../lib/data';
import { fmtDate, fmtRange, fmtShort, money, today } from '../lib/format';
import { PageHead, useLoad, useToast, Loading, ErrorBox, Empty, EditDialog, ReasonDialog, HistoryDialog, AdjustedMark } from '../components/ui';

type FloatRec = { id: string; ref: number; prepared_date: string; amount: number; date_from: string; date_to: string; unused: boolean; unused_date: string | null; note: string | null; status: 'out' | 'counted' | 'unused'; counted_date: string | null; dates_mismatch: boolean; created_at: string; updated_at: string };
type Line = { date_from: string; date_to: string; amount: string };

export default function FloatsPage() {
  const toast = useToast();
  const settings = useLoad(loadSettings, []);
  const list = useLoad(() => q(supabase.from('v_float_status').select('*').order('date_from', { ascending: false }).limit(60)) as Promise<FloatRec[]>, []);
  const [prepared, setPrepared] = useState(today());
  const [lines, setLines] = useState<Line[] | null>(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState<FloatRec | null>(null); const [unused, setUnused] = useState<FloatRec | null>(null);
  const [voiding, setVoiding] = useState<FloatRec | null>(null); const [hist, setHist] = useState<FloatRec | null>(null);
  const [unusedDate, setUnusedDate] = useState(today());

  const def = String(settings.data?.default_float || '');
  const nextWeek = () => { const out: Line[] = []; let d = addDays(prepared, 1); while (out.length < 6) { if (new Date(d + 'T12:00:00Z').getUTCDay() !== 6) out.push({ date_from: d, date_to: '', amount: def }); d = addDays(d, 1); } return out; };
  const form = lines ?? nextWeek();
  const setLine = (i: number, k: keyof Line, v: string) => setLines(form.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const valid = form.filter(l => l.date_from && Number(l.amount) > 0);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await q(supabase.from('floats').insert(valid.map(l => ({ prepared_date: prepared, amount: Number(l.amount), date_from: l.date_from, date_to: l.date_to || l.date_from }))));
      toast(`${valid.length} float${valid.length > 1 ? 's' : ''} saved, ${money(valid.reduce((s, l) => s + Number(l.amount), 0))} moved from office cash to the shop.`);
      setLines(null); list.reload();
    } catch (e) { setErr(String((e as Error).message)); }
    setBusy(false);
  };
  const out = (list.data ?? []).filter(f => f.status === 'out');

  return (
    <>
      <PageHead title="Floats" sub="A float moves cash from the office to the shop. It is never an expense: it is taken off the count before comparing with Semtek." />
      <section className="card">
        <h2>Prepare floats</h2>
        <div className="row wrap-row">
          <label className="field inline"><span>Prepared on</span><input id="f-prepared" type="date" value={prepared} onChange={e => { setPrepared(e.target.value); setLines(null); }} /></label>
        </div>
        <div className="table-wrap"><table>
          <thead><tr><th>For day</th><th>Until (if it covers more days)</th><th className="r">Amount £</th><th /></tr></thead>
          <tbody>{form.map((l, i) => (
            <tr key={i}>
              <td><input id={`fl-${i}-from`} type="date" value={l.date_from} onChange={e => setLine(i, 'date_from', e.target.value)} /> <span className="muted small">{l.date_from && new Date(l.date_from + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })}</span></td>
              <td><input id={`fl-${i}-to`} type="date" value={l.date_to} min={l.date_from} onChange={e => setLine(i, 'date_to', e.target.value)} /></td>
              <td><input id={`fl-${i}-amt`} className="r" type="number" step="0.01" min="0" value={l.amount} onChange={e => setLine(i, 'amount', e.target.value)} /></td>
              <td><button className="ghost small" aria-label="Remove" onClick={() => setLines(form.filter((_, j) => j !== i))}>✕</button></td>
            </tr>))}</tbody>
          <tfoot><tr><td colSpan={2}><button className="ghost small" onClick={() => setLines([...form, { date_from: form.length ? addDays(form[form.length - 1].date_from, 1) : prepared, date_to: '', amount: def }])}>+ Add a float</button></td>
            <td className="r num"><strong>{money(valid.reduce((s, l) => s + Number(l.amount), 0))}</strong></td><td /></tr></tfoot>
        </table></div>
        {err && <ErrorBox error={err} />}
        <div className="row end"><button className="primary" disabled={busy || !valid.length} onClick={save}>{busy ? 'Saving…' : `Save ${valid.length} float${valid.length === 1 ? '' : 's'}`}</button></div>
      </section>

      <section className="card">
        <h2>Floats {out.length ? <span className="chip pending">{out.length} not counted back yet · {money(out.reduce((s, f) => s + Number(f.amount), 0))}</span> : null}</h2>
        {list.loading ? <Loading /> : list.error ? <ErrorBox error={list.error} /> : !list.data?.length ? <Empty>No floats yet. Prepare next week's floats above.</Empty> : (
          <div className="table-wrap"><table>
            <thead><tr><th>#</th><th>Covers</th><th className="r">Amount</th><th>Prepared</th><th>Status</th><th /></tr></thead>
            <tbody>{list.data.map(f => (
              <tr key={f.id}>
                <td className="muted">{f.ref}</td>
                <td className="nowrap">{fmtRange(f.date_from, f.date_to)} <AdjustedMark row={f} onClick={() => setHist(f)} /></td>
                <td className="r num">{money(f.amount)}</td><td className="nowrap">{fmtShort(f.prepared_date)}</td>
                <td>{f.status === 'counted' ? <span className="chip ok">counted back {f.counted_date ? fmtShort(f.counted_date) : ''}</span>
                  : f.status === 'unused' ? <span className="chip muted-chip">not used{f.unused_date ? `, back ${fmtShort(f.unused_date)}` : ''}</span>
                  : <span className="chip pending">at shop</span>}
                  {f.dates_mismatch && f.status !== 'unused' && <div className="warn small">Count dates don't line up with this float</div>}</td>
                <td className="nowrap">
                  <button className="ghost small" onClick={() => setEdit(f)}>Change dates</button>
                  {f.status === 'out' && <button className="ghost small" onClick={() => setUnused(f)}>Not used</button>}
                  <button className="ghost small" onClick={() => setVoiding(f)}>Void</button>
                </td>
              </tr>))}</tbody>
          </table></div>
        )}
      </section>
      {edit && <EditDialog table="floats" row={edit} title={`Float #${edit.ref}`} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); list.reload(); }}
        fields={[{ key: 'date_from', label: 'For day', type: 'date' }, { key: 'date_to', label: 'Until', type: 'date' }, { key: 'amount', label: 'Amount £', type: 'number' }, { key: 'prepared_date', label: 'Prepared on', type: 'date' }, { key: 'note', label: 'Note', type: 'text' }]} />}
      {unused && <ReasonDialog title={`Float #${unused.ref} not used`} confirm="Back to office cash" onCancel={() => setUnused(null)}
        prompt={<>{money(unused.amount)} prepared for {fmtRange(unused.date_from, unused.date_to)} goes back into office cash.</>}
        extra={<label className="field"><span>Back in the office on</span><input id="unused-date" type="date" value={unusedDate} onChange={e => setUnusedDate(e.target.value)} /></label>}
        onConfirm={async reason => { await q(supabase.from('floats').update({ unused: true, unused_date: unusedDate, change_reason: `Not used: ${reason}` }).eq('id', unused.id)); setUnused(null); list.reload(); toast('Float returned to office cash.'); }} />}
      {voiding && <ReasonDialog title={`Void float #${voiding.ref}`} danger confirm="Void float" onCancel={() => setVoiding(null)}
        prompt={<>Use this only for a float entered by mistake. {money(voiding.amount)} for {fmtDate(voiding.date_from)} will disappear from every report.</>}
        onConfirm={async reason => { await q(supabase.from('floats').update({ voided: true, change_reason: reason }).eq('id', voiding.id)); setVoiding(null); list.reload(); toast('Float voided.'); }} />}
      {hist && <HistoryDialog table="floats" id={hist.id} title={`History of float #${hist.ref}`} onClose={() => setHist(null)} />}
    </>
  );
}
