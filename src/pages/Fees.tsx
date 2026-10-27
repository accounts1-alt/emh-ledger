import { useState } from 'react';
import { q, supabase } from '../lib/supabase';
import { fmtDate, money, today } from '../lib/format';
import { PageHead, useLoad, useToast, Loading, ErrorBox, Empty, EditDialog, ReasonDialog, HistoryDialog, AdjustedMark } from '../components/ui';

export const FEE_PROVIDER: Record<string, string> = { paymentsense: 'Paymentsense', amex: 'Amex', stripe_shop: 'Stripe Shop', stripe_office: 'Stripe Office', vouchers: 'Voucher scheme', cheques: 'Cheques', other: 'Other' };
type FeeRec = { id: string; ref: number; fee_date: string; provider: string; amount: number; note: string | null; created_at: string; updated_at: string };

export default function FeesPage() {
  const toast = useToast();
  const list = useLoad(() => q(supabase.from('fees').select('*').eq('voided', false).order('fee_date', { ascending: false }).limit(100)) as Promise<FeeRec[]>, []);
  const [f, setF] = useState({ fee_date: today(), provider: 'paymentsense', amount: '', note: '' });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState<FeeRec | null>(null); const [voiding, setVoiding] = useState<FeeRec | null>(null); const [hist, setHist] = useState<FeeRec | null>(null);
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      if (!(Number(f.amount) > 0)) throw new Error('Enter the fee amount.');
      await q(supabase.from('fees').insert({ ...f, amount: Number(f.amount), note: f.note || null }));
      toast('Fee saved.'); setF({ ...f, amount: '', note: '' }); list.reload();
    } catch (e) { setErr(String((e as Error).message)); }
    setBusy(false);
  };
  return (
    <>
      <PageHead title="Fees" sub="Fees charged separately, like the monthly Paymentsense direct debit. Stripe and Amex fees per transaction, and posting fees, are picked up automatically." />
      <section className="card form-card">
        <div className="grid4">
          <label className="field"><span>Date</span><input id="fee-date" type="date" value={f.fee_date} onChange={e => setF({ ...f, fee_date: e.target.value })} /></label>
          <label className="field"><span>Charged by</span><select id="fee-provider" value={f.provider} onChange={e => setF({ ...f, provider: e.target.value })}>{Object.entries(FEE_PROVIDER).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label className="field"><span>Amount £</span><input id="fee-amount" type="number" step="0.01" min="0" value={f.amount} onChange={e => setF({ ...f, amount: e.target.value })} /></label>
          <label className="field"><span>Note</span><input id="fee-note" value={f.note} onChange={e => setF({ ...f, note: e.target.value })} placeholder="e.g. October direct debit" /></label>
        </div>
        {err && <ErrorBox error={err} />}
        <div className="row end"><button className="primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save fee'}</button></div>
      </section>
      <section className="card">
        <h2>Fees entered</h2>
        {list.loading ? <Loading /> : list.error ? <ErrorBox error={list.error} /> : !list.data?.length ? <Empty>No separate fees entered yet.</Empty> : (
          <div className="table-wrap"><table>
            <thead><tr><th>#</th><th>Date</th><th>Charged by</th><th>Note</th><th className="r">Amount</th><th /></tr></thead>
            <tbody>{list.data.map(x => (
              <tr key={x.id}><td className="muted">{x.ref}</td><td className="nowrap">{fmtDate(x.fee_date)} <AdjustedMark row={x} onClick={() => setHist(x)} /></td><td>{FEE_PROVIDER[x.provider]}</td><td>{x.note}</td><td className="r num">{money(x.amount)}</td>
                <td className="nowrap"><button className="ghost small" onClick={() => setEdit(x)}>Adjust</button><button className="ghost small" onClick={() => setVoiding(x)}>Void</button></td></tr>))}</tbody>
          </table></div>
        )}
      </section>
      {edit && <EditDialog table="fees" row={edit} title={`Adjust fee #${edit.ref}`} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); list.reload(); }}
        fields={[{ key: 'fee_date', label: 'Date', type: 'date' }, { key: 'provider', label: 'Charged by', type: 'select', options: Object.entries(FEE_PROVIDER) }, { key: 'amount', label: 'Amount £', type: 'number' }, { key: 'note', label: 'Note', type: 'text' }]} />}
      {voiding && <ReasonDialog title={`Void fee #${voiding.ref}`} danger confirm="Void fee" onCancel={() => setVoiding(null)} prompt={`${money(voiding.amount)} will be removed from the fee reports.`}
        onConfirm={async reason => { await q(supabase.from('fees').update({ voided: true, change_reason: reason }).eq('id', voiding.id)); setVoiding(null); list.reload(); toast('Fee voided.'); }} />}
      {hist && <HistoryDialog table="fees" id={hist.id} title={`History of fee #${hist.ref}`} onClose={() => setHist(null)} />}
    </>
  );
}
