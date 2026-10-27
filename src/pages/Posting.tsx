import { useEffect, useState } from 'react';
import { q, rpc, supabase } from '../lib/supabase';
import { loadSettings } from '../lib/data';
import { fmtDate, fmtShort, money, r2, today } from '../lib/format';
import { PageHead, Tabs, useLoad, useToast, Loading, ErrorBox, Empty, ReasonDialog, EditDialog, HistoryDialog, AdjustedMark } from '../components/ui';

export type ChequeRec = { id: string; received_date: string; bank: string | null; cheque_no: string | null; payer: string | null; amount: number; posting_id: string | null; banking_id: string | null; status: string; bounced: boolean; against_pos: boolean; created_at: string; updated_at: string };
type Lot = { id: string; received_date: string; amount: number; count_id: string | null; entry_id: string | null; posting_id: string | null };
type PostingRec = { id: string; ref: number; posting_date: string; kind: 'cheque' | 'voucher'; fee_fixed: number; fee_pct: number; banking_id: string | null; note: string | null };

export default function PostingPage() {
  const [tab, setTab] = useState<'new' | 'list' | 'cheques'>('new');
  return (
    <>
      <PageHead title="Posting" sub="Cheques taken to the bank and vouchers sent to the voucher company. They stay “posted” until you record them as banked." />
      <Tabs value={tab} onChange={setTab} items={[['new', 'New posting'], ['list', 'Postings'], ['cheques', 'Cheque register']]} />
      {tab === 'new' ? <NewPosting onDone={() => setTab('list')} /> : tab === 'list' ? <PostingList /> : <ChequeRegister />}
    </>
  );
}

function NewPosting({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [kind, setKind] = useState<'cheque' | 'voucher'>('cheque');
  const settings = useLoad(loadSettings, []);
  const items = useLoad(async () => kind === 'cheque'
    ? (q(supabase.from('cheques').select('*').eq('voided', false).eq('status', 'office').order('received_date')) as Promise<ChequeRec[]>)
    : (q(supabase.from('voucher_lots').select('*').eq('voided', false).is('posting_id', null).order('received_date')) as Promise<Lot[]>), [kind]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [date, setDate] = useState(today()); const [feeFixed, setFeeFixed] = useState('0'); const [feePct, setFeePct] = useState('0'); const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setSel(new Set()); setFeeFixed('0'); setFeePct(kind === 'voucher' ? String(settings.data?.voucher_fee_pct ?? 1) : '0'); }, [kind, settings.data]);
  const rows = (items.data ?? []) as (ChequeRec | Lot)[];
  const gross = r2(rows.filter(r => sel.has(r.id)).reduce((s, r) => s + Number(r.amount), 0));
  const fee = r2((Number(feeFixed) || 0) + gross * (Number(feePct) || 0) / 100);
  const toggle = (id: string) => setSel(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const ref = await rpc<number>('create_posting', { p_kind: kind, p_date: date, p_fee_fixed: Number(feeFixed) || 0, p_fee_pct: Number(feePct) || 0, p_note: note || null, p_items: [...sel] });
      toast(`Posting #${ref} saved: ${sel.size} item${sel.size > 1 ? 's' : ''}, ${money(gross)}.`); onDone();
    } catch (e) { setErr(String((e as Error).message)); }
    setBusy(false);
  };

  return (
    <section className="card">
      <div className="seg" role="radiogroup" aria-label="What are you posting">
        <button role="radio" aria-checked={kind === 'cheque'} className={kind === 'cheque' ? 'on' : ''} onClick={() => setKind('cheque')}>Cheques</button>
        <button role="radio" aria-checked={kind === 'voucher'} className={kind === 'voucher' ? 'on' : ''} onClick={() => setKind('voucher')}>Vouchers</button>
      </div>
      {items.loading ? <Loading /> : items.error ? <ErrorBox error={items.error} /> : !rows.length ? <Empty>Nothing waiting to be posted. Every {kind} received has already been posted.</Empty> : (
        <div className="table-wrap"><table>
          <thead><tr><th><input type="checkbox" aria-label="Select all" checked={sel.size === rows.length} onChange={e => setSel(e.target.checked ? new Set(rows.map(r => r.id)) : new Set())} /></th>
            <th>Received</th>{kind === 'cheque' ? <><th>Name</th><th>Bank</th><th>Cheque no.</th></> : <th>From</th>}<th className="r">Amount</th></tr></thead>
          <tbody>{rows.map(r => (
            <tr key={r.id} className="click" onClick={() => toggle(r.id)}>
              <td><input type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r.id)} onClick={e => e.stopPropagation()} aria-label="Select" /></td>
              <td className="nowrap">{fmtDate(r.received_date)}</td>
              {kind === 'cheque' ? <><td>{(r as ChequeRec).payer}</td><td>{(r as ChequeRec).bank}</td><td>{(r as ChequeRec).cheque_no}</td></> : <td>{(r as Lot).count_id ? 'Weekly count' : 'Entry'}</td>}
              <td className="r num">{money(r.amount)}</td>
            </tr>))}</tbody>
        </table></div>
      )}
      <div className="grid4">
        <label className="field"><span>Posted on</span><input id="p-date" type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
        <label className="field"><span>Fixed fee £</span><input id="p-fee-fixed" type="number" step="0.01" min="0" value={feeFixed} onChange={e => setFeeFixed(e.target.value)} /></label>
        <label className="field"><span>Fee %</span><input id="p-fee-pct" type="number" step="0.01" min="0" value={feePct} onChange={e => setFeePct(e.target.value)} /></label>
        <label className="field"><span>Note</span><input id="p-note" value={note} onChange={e => setNote(e.target.value)} /></label>
      </div>
      <div className="totals">
        <div><span>Selected</span><strong>{sel.size} · {money(gross)}</strong></div>
        <div><span>Fees</span><strong>{money(fee)}</strong></div>
        <div><span>Expected in the bank</span><strong>{money(gross - fee)}</strong></div>
      </div>
      {err && <ErrorBox error={err} />}
      <div className="row end"><button className="primary" disabled={busy || !sel.size} onClick={save}>{busy ? 'Saving…' : 'Save posting'}</button></div>
    </section>
  );
}

function PostingList() {
  const toast = useToast();
  const data = useLoad(async () => {
    const [p, c, v] = await Promise.all([
      q(supabase.from('postings').select('*').eq('voided', false).order('posting_date', { ascending: false }).limit(60)),
      q(supabase.from('cheques').select('posting_id,amount,banking_id').eq('voided', false).not('posting_id', 'is', null).is('bounce_of', null)),
      q(supabase.from('voucher_lots').select('posting_id,amount').eq('voided', false).not('posting_id', 'is', null)),
    ]) as [PostingRec[], { posting_id: string; amount: number; banking_id: string | null }[], { posting_id: string; amount: number }[]];
    return p.map(x => {
      const items = x.kind === 'cheque' ? c.filter(i => i.posting_id === x.id) : v.filter(i => i.posting_id === x.id);
      const gross = r2(items.reduce((s, i) => s + Number(i.amount), 0));
      const fee = r2(Number(x.fee_fixed) + gross * Number(x.fee_pct) / 100);
      const banked = x.kind === 'cheque' ? (c.filter(i => i.posting_id === x.id && i.banking_id).length) : (x.banking_id ? items.length : 0);
      return { ...x, n: items.length, gross, fee, banked };
    });
  }, []);
  const [voiding, setVoiding] = useState<PostingRec | null>(null);
  if (data.loading) return <Loading />; if (data.error) return <ErrorBox error={data.error} />;
  if (!data.data?.length) return <Empty>No postings yet.</Empty>;
  return (
    <section className="card flush"><div className="table-wrap"><table>
      <thead><tr><th>#</th><th>Posted</th><th>What</th><th className="r">Items</th><th className="r">Amount</th><th className="r">Fees</th><th className="r">Expected</th><th>Banked</th><th /></tr></thead>
      <tbody>{data.data.map(p => (
        <tr key={p.id}><td className="muted">{p.ref}</td><td className="nowrap">{fmtDate(p.posting_date)}</td><td>{p.kind === 'cheque' ? 'Cheques' : 'Vouchers'}{p.note ? <span className="muted small"> · {p.note}</span> : null}</td>
          <td className="r num">{p.n}</td><td className="r num">{money(p.gross)}</td><td className="r num">{money(p.fee, { blankZero: true })}</td><td className="r num">{money(p.gross - p.fee)}</td>
          <td>{p.banked === 0 ? <span className="chip pending">waiting</span> : p.banked < p.n ? <span className="chip pending">{p.banked} of {p.n}</span> : <span className="chip ok">banked</span>}</td>
          <td>{p.banked === 0 && <button className="ghost small" onClick={() => setVoiding(p)}>Void</button>}</td></tr>
      ))}</tbody>
    </table></div>
    {voiding && <ReasonDialog title={`Void posting #${voiding.ref}`} danger confirm="Void posting" onCancel={() => setVoiding(null)}
      prompt="Everything in this posting goes back to the office, ready to post again."
      onConfirm={async reason => { await rpc('void_posting', { p_id: voiding.id, p_reason: reason }); setVoiding(null); data.reload(); toast('Posting voided.'); }} />}
    </section>
  );
}

export function ChequeRegister() {
  const toast = useToast();
  const [filter, setFilter] = useState<'office' | 'posted' | 'banked' | 'all'>('posted');
  const list = useLoad(async () => {
    let qy = supabase.from('cheques').select('*').eq('voided', false).order('received_date', { ascending: false }).limit(300);
    if (filter === 'banked') qy = qy.in('status', ['banked', 'bounced', 'minus']); else if (filter !== 'all') qy = qy.eq('status', filter);
    return q(qy) as Promise<ChequeRec[]>;
  }, [filter]);
  const [act, setAct] = useState<{ c: ChequeRec; kind: 'return' | 'bounce' } | null>(null);
  const [edit, setEdit] = useState<ChequeRec | null>(null); const [hist, setHist] = useState<ChequeRec | null>(null);
  return (
    <section className="card">
      <div className="row between wrap-row">
        <Tabs value={filter} onChange={setFilter} items={[['office', 'In office'], ['posted', 'Posted'], ['banked', 'Banked'], ['all', 'All']]} />
        <span className="muted small">Returned = sent back before banking, goes back to be posted again. Bounced = unpaid after banking, adds a minus cheque.</span>
      </div>
      {list.loading ? <Loading /> : list.error ? <ErrorBox error={list.error} /> : !list.data?.length ? <Empty>No cheques here.</Empty> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Received</th><th>Name</th><th>Bank</th><th>Cheque no.</th><th className="r">Amount</th><th>Status</th><th /></tr></thead>
          <tbody>{list.data.map(c => (
            <tr key={c.id}><td className="nowrap">{fmtShort(c.received_date)} <AdjustedMark row={c} onClick={() => setHist(c)} /></td><td>{c.payer}</td><td>{c.bank}</td><td>{c.cheque_no}</td>
              <td className="r num">{money(c.amount)}</td>
              <td><span className={`chip ${c.status === 'banked' ? 'ok' : c.status === 'bounced' || c.status === 'minus' ? 'short' : 'pending'}`}>{c.status === 'minus' ? 'minus line for bounce' : c.status === 'office' ? 'in office' : c.status}</span></td>
              <td className="nowrap">
                {c.status === 'posted' && <button className="ghost small" onClick={() => setAct({ c, kind: 'return' })}>Returned</button>}
                {c.status === 'banked' && <button className="ghost small" onClick={() => setAct({ c, kind: 'bounce' })}>Bounced</button>}
                {c.status !== 'minus' && <button className="ghost small" onClick={() => setEdit(c)}>Adjust</button>}
              </td></tr>
          ))}</tbody>
        </table></div>
      )}
      {act && <ReasonDialog title={act.kind === 'return' ? 'Cheque returned before banking' : 'Cheque bounced'} danger={act.kind === 'bounce'}
        confirm={act.kind === 'return' ? 'Mark returned' : 'Mark bounced'} onCancel={() => setAct(null)}
        prompt={act.kind === 'return'
          ? <>{money(act.c.amount)} from {act.c.payer || 'this customer'} comes off its posting and goes back to “in office”, ready to post again.</>
          : <>{money(act.c.amount)} from {act.c.payer || 'this customer'} is marked bounced and a minus cheque of {money(-act.c.amount)} is added on {fmtDate(act.c.received_date)}. That day will stop matching Semtek until you enter the minus cheque in Semtek too.</>}
        onConfirm={async reason => { await rpc(act.kind === 'return' ? 'return_cheque' : 'bounce_cheque', { p_id: act.c.id, p_reason: reason }); setAct(null); list.reload(); toast(act.kind === 'return' ? 'Cheque back in the office.' : 'Cheque marked bounced.'); }} />}
      {edit && <EditDialog table="cheques" row={edit} title="Adjust cheque" onClose={() => setEdit(null)} onSaved={() => { setEdit(null); list.reload(); }}
        fields={[{ key: 'received_date', label: 'Received', type: 'date' }, { key: 'payer', label: 'Name', type: 'text' }, { key: 'bank', label: 'Bank', type: 'text' }, { key: 'cheque_no', label: 'Cheque no.', type: 'text' }, { key: 'amount', label: 'Amount £', type: 'number' }, { key: 'against_pos', label: 'Should be in Semtek', type: 'bool' }]} />}
      {hist && <HistoryDialog table="cheques" id={hist.id} title="Cheque history" onClose={() => setHist(null)} />}
    </section>
  );
}
