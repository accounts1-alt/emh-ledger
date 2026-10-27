import { useState } from 'react';
import { q, supabase } from '../lib/supabase';
import { loadCategories, type Category } from '../lib/data';
import { ENTRY_ACCOUNT_LABEL, fmtDate, money, today } from '../lib/format';
import { PageHead, useLoad, useToast, Loading, ErrorBox, Empty, EditDialog, ReasonDialog, HistoryDialog, AdjustedMark } from '../components/ui';

type EntryRec = { id: string; ref: number; entry_date: string; direction: 'in' | 'out'; account: string; category_id: string; against_pos: boolean; amount: number; reference: string | null; note: string | null; created_at: string; updated_at: string };
const IN_ACCOUNTS = ['cash', 'cheque', 'voucher', 'paymentsense', 'amex', 'stripe_shop', 'stripe_office'];
const OUT_ACCOUNTS = ['cash', 'cheque', 'voucher'];

export default function EntryPage() {
  const toast = useToast();
  const cats = useLoad(loadCategories, []);
  const recent = useLoad(() => q(supabase.from('entries').select('*').eq('voided', false).order('entry_date', { ascending: false }).order('ref', { ascending: false }).limit(50)) as Promise<EntryRec[]>, []);
  const blank = { direction: 'in' as 'in' | 'out', entry_date: today(), account: 'cash', category_id: '', against_pos: false, amount: '', reference: '', note: '', bank: '', cheque_no: '', payer: '' };
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState<EntryRec | null>(null); const [voiding, setVoiding] = useState<EntryRec | null>(null); const [hist, setHist] = useState<EntryRec | null>(null);
  const catList = (cats.data ?? []).filter(c => !c.voided && c.direction === f.direction);
  const catName = (id: string) => cats.data?.find(c => c.id === id)?.name ?? '';
  const set = (k: keyof typeof blank, v: unknown) => setF(x => {
    const n = { ...x, [k]: v } as typeof blank;
    if (k === 'direction') { n.category_id = ''; n.against_pos = false; if (v === 'out' && !OUT_ACCOUNTS.includes(n.account)) n.account = 'cash'; }
    if (k === 'category_id') n.against_pos = !!cats.data?.find(c => c.id === v)?.against_pos_default;
    return n;
  });
  const isCard = !['cash', 'cheque', 'voucher'].includes(f.account);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      if (!f.category_id) throw new Error('Choose a category.');
      if (!(Number(f.amount) > 0)) throw new Error('Enter an amount above £0.');
      const e = await q(supabase.from('entries').insert({
        entry_date: f.entry_date, direction: f.direction, account: f.account, category_id: f.category_id,
        against_pos: f.direction === 'in' ? f.against_pos : false, amount: Number(f.amount), reference: f.reference || null, note: f.note || null,
      }).select('id,ref').single()) as { id: string; ref: number };
      if (f.direction === 'in' && f.account === 'cheque') {
        await q(supabase.from('cheques').insert({ received_date: f.entry_date, bank: f.bank || null, cheque_no: f.cheque_no || null, payer: f.payer || f.reference || null, amount: Number(f.amount), entry_id: e.id, against_pos: f.against_pos }));
      }
      toast(`Entry #${e.ref} saved.`); setF({ ...blank, direction: f.direction, entry_date: f.entry_date }); recent.reload();
    } catch (x) { setErr(String((x as Error).message)); }
    setBusy(false);
  };

  return (
    <>
      <PageHead title="Add entry" sub="One payment received or one payment made, outside the weekly count." />
      <section className="card form-card">
        <div className="seg" role="radiogroup" aria-label="Direction">
          <button role="radio" aria-checked={f.direction === 'in'} className={f.direction === 'in' ? 'on' : ''} onClick={() => set('direction', 'in')}>Money received</button>
          <button role="radio" aria-checked={f.direction === 'out'} className={f.direction === 'out' ? 'on' : ''} onClick={() => set('direction', 'out')}>Money spent</button>
        </div>
        <div className="grid3">
          <label className="field"><span>Date</span><input id="e-date" type="date" value={f.entry_date} onChange={e => set('entry_date', e.target.value)} /></label>
          <label className="field"><span>Account</span><select id="e-account" value={f.account} onChange={e => set('account', e.target.value)}>
            {(f.direction === 'in' ? IN_ACCOUNTS : OUT_ACCOUNTS).map(a => <option key={a} value={a}>{ENTRY_ACCOUNT_LABEL[a]}</option>)}</select></label>
          <label className="field"><span>Amount £</span><input id="e-amount" type="number" step="0.01" min="0" value={f.amount} onChange={e => set('amount', e.target.value)} /></label>
          <label className="field"><span>Category</span>
            {cats.loading ? <select disabled><option>Loading…</option></select> : <select id="e-cat" value={f.category_id} onChange={e => set('category_id', e.target.value)}>
              <option value="">Choose…</option>{catList.map((c: Category) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
          </label>
          <label className="field"><span>Reference</span><input id="e-ref" value={f.reference} onChange={e => set('reference', e.target.value)} placeholder="Customer, supplier, invoice…" /></label>
          <label className="field"><span>Note</span><input id="e-note" value={f.note} onChange={e => set('note', e.target.value)} /></label>
        </div>
        {f.direction === 'in' && (
          <label className="check"><input id="e-pos" type="checkbox" checked={f.against_pos} onChange={e => set('against_pos', e.target.checked)} />
            <span><strong>Should be in Semtek</strong> – include in the comparison against Semtek. Untick for separate money such as a wholesale customer.</span></label>
        )}
        {f.direction === 'in' && isCard && !f.against_pos && <p className="small muted">The card payment itself comes in with the card file. This entry tags it as separate money so it is left out of the Semtek comparison and shows under its category.</p>}
        {f.direction === 'in' && f.account === 'cheque' && (
          <div className="grid3">
            <label className="field"><span>Bank</span><input id="e-bank" value={f.bank} onChange={e => set('bank', e.target.value)} /></label>
            <label className="field"><span>Cheque no.</span><input id="e-chqno" value={f.cheque_no} onChange={e => set('cheque_no', e.target.value)} /></label>
            <label className="field"><span>Name on cheque</span><input id="e-payer" value={f.payer} onChange={e => set('payer', e.target.value)} /></label>
          </div>
        )}
        {err && <ErrorBox error={err} />}
        <div className="row end"><button className="primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : f.direction === 'in' ? 'Save money received' : 'Save money spent'}</button></div>
      </section>

      <section className="card">
        <h2>Recent entries</h2>
        {recent.loading ? <Loading /> : recent.error ? <ErrorBox error={recent.error} /> : !recent.data?.length ? <Empty>No entries yet.</Empty> : (
          <div className="table-wrap"><table>
            <thead><tr><th>#</th><th>Date</th><th>Category</th><th>Account</th><th>Reference</th><th className="r">In</th><th className="r">Out</th><th>Semtek?</th><th /></tr></thead>
            <tbody>{recent.data.map(e => (
              <tr key={e.id}><td className="muted">{e.ref}</td><td className="nowrap">{fmtDate(e.entry_date)} <AdjustedMark row={e} onClick={() => setHist(e)} /></td><td>{catName(e.category_id)}</td>
                <td>{ENTRY_ACCOUNT_LABEL[e.account]}</td><td className="wrap">{e.reference}{e.note ? <span className="muted"> · {e.note}</span> : null}</td>
                <td className="r num">{e.direction === 'in' ? money(e.amount) : ''}</td><td className="r num">{e.direction === 'out' ? money(e.amount) : ''}</td>
                <td>{e.direction === 'in' ? (e.against_pos ? 'Yes' : 'Separate') : ''}</td>
                <td className="nowrap"><button className="ghost small" onClick={() => setEdit(e)}>Adjust</button><button className="ghost small" onClick={() => setVoiding(e)}>Void</button></td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      {edit && <EditDialog table="entries" row={edit} title={`Adjust entry #${edit.ref}`} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); recent.reload(); }}
        fields={[{ key: 'entry_date', label: 'Date', type: 'date' }, { key: 'amount', label: 'Amount £', type: 'number' },
          { key: 'category_id', label: 'Category', type: 'select', options: (cats.data ?? []).filter(c => c.direction === edit.direction && !c.voided).map(c => [c.id, c.name]) },
          ...(edit.direction === 'in' ? [{ key: 'against_pos', label: 'Should be in Semtek', type: 'bool' } as const] : []),
          { key: 'reference', label: 'Reference', type: 'text' }, { key: 'note', label: 'Note', type: 'text' }]} />}
      {voiding && <ReasonDialog title={`Void entry #${voiding.ref}`} danger confirm="Void entry" onCancel={() => setVoiding(null)}
        prompt={<>{money(voiding.amount)} {catName(voiding.category_id)} on {fmtDate(voiding.entry_date)} will be removed from every report. It stays in the change history.</>}
        onConfirm={async reason => {
          await q(supabase.from('cheques').update({ voided: true, change_reason: `Entry #${voiding.ref} voided: ${reason}` }).eq('entry_id', voiding.id).eq('voided', false).is('posting_id', null));
          await q(supabase.from('entries').update({ voided: true, change_reason: reason }).eq('id', voiding.id));
          setVoiding(null); recent.reload(); toast('Entry voided.');
        }} />}
      {hist && <HistoryDialog table="entries" id={hist.id} title={`History of entry #${hist.ref}`} onClose={() => setHist(null)} />}
    </>
  );
}
