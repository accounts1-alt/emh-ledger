import { useEffect, useMemo, useState } from 'react';
import { all, q, rpc, supabase } from '../lib/supabase';
import { fmtDate, fmtShort, money, r2, today, MERCHANT_LABEL } from '../lib/format';
import { PageHead, Tabs, useLoad, useToast, Loading, ErrorBox, Empty, ReasonDialog, Diff } from '../components/ui';
import type { ChequeRec } from './Posting';

type Kind = 'card' | 'cheque' | 'voucher' | 'cash';
type CardDay = { merchant: string; txn_date: string; unbanked_gross: number; unbanked_net: number; unbanked_txns: number; payout_refs: string | null };
type Expected = { kind: string; posting_id: string; ref: number; since: string; gross: number; fee: number; net: number; items: number };
type BankingRec = { id: string; ref: number; banking_date: string; kind: Kind; merchant: string | null; amount_received: number | null; note: string | null };

export default function BankingPage() {
  const [tab, setTab] = useState<'new' | 'list'>('new');
  return (
    <>
      <PageHead title="Banking" sub="Record what has arrived in the bank. Choose cards, cheques, vouchers or cash, then tick what this banking covers." />
      <Tabs value={tab} onChange={setTab} items={[['new', 'New banking'], ['list', 'Bankings']]} />
      {tab === 'new' ? <NewBanking onDone={() => setTab('list')} /> : <BankingList />}
    </>
  );
}

function NewBanking({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [kind, setKind] = useState<Kind>('card');
  const [merchant, setMerchant] = useState('paymentsense');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [date, setDate] = useState(today()); const [amount, setAmount] = useState(''); const [touched, setTouched] = useState(false); const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const data = useLoad(async () => {
    if (kind === 'card') return { cards: await q(supabase.from('v_card_daily').select('merchant,txn_date,unbanked_gross,unbanked_net,unbanked_txns,payout_refs').eq('merchant', merchant).gt('unbanked_txns', 0).order('txn_date')) as CardDay[] };
    if (kind === 'cheque') {
      const [ch, p] = await Promise.all([
        q(supabase.from('cheques').select('*').eq('voided', false).eq('status', 'posted').order('received_date')) as Promise<ChequeRec[]>,
        q(supabase.from('postings').select('id,ref,posting_date,fee_fixed,fee_pct').eq('kind', 'cheque').eq('voided', false)) as Promise<{ id: string; ref: number; posting_date: string; fee_fixed: number; fee_pct: number }[]>,
      ]);
      return { cheques: ch, postings: p };
    }
    if (kind === 'voucher') return { vouchers: await q(supabase.from('v_expected').select('*').eq('kind', 'vouchers').order('since')) as Expected[] };
    return {};
  }, [kind, merchant]);
  useEffect(() => { setSel(new Set()); setTouched(false); setAmount(''); }, [kind, merchant]);

  const toggle = (id: string) => setSel(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const expected = useMemo(() => {
    const d = data.data; if (!d) return 0;
    if (kind === 'card') return r2((d.cards ?? []).filter(c => sel.has(c.txn_date)).reduce((s, c) => s + Number(c.unbanked_net), 0));
    if (kind === 'voucher') return r2((d.vouchers ?? []).filter(v => sel.has(v.posting_id)).reduce((s, v) => s + Number(v.net), 0));
    if (kind === 'cheque') {
      const chosen = (d.cheques ?? []).filter(c => sel.has(c.id));
      let fee = 0;
      for (const p of d.postings ?? []) {
        const inP = chosen.filter(c => c.posting_id === p.id); if (!inP.length) continue;
        const sum = inP.reduce((s, c) => s + Number(c.amount), 0);
        fee += sum * Number(p.fee_pct) / 100 + (inP.length === (d.cheques ?? []).filter(c => c.posting_id === p.id).length ? Number(p.fee_fixed) : 0);
      }
      return r2(chosen.reduce((s, c) => s + Number(c.amount), 0) - fee);
    }
    return 0;
  }, [data.data, sel, kind]);
  useEffect(() => { if (!touched && kind !== 'cash') setAmount(expected ? expected.toFixed(2) : ''); }, [expected, touched, kind]);
  const received = Number(amount) || 0;

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      let items: string[] = [];
      if (kind === 'card') {
        const days = [...sel];
        const tx = await all((a, b) => supabase.from('card_txns').select('id').eq('merchant', merchant).eq('voided', false).is('banking_id', null).in('txn_date', days).range(a, b)) as { id: string }[];
        items = tx.map(t => t.id);
      } else items = [...sel];
      if (kind === 'cash' && !(received > 0)) throw new Error('Enter the amount of cash banked.');
      const ref = await rpc<number>('create_banking', { p_kind: kind, p_date: date, p_merchant: kind === 'card' ? merchant : null, p_amount: received, p_note: note || null, p_items: items });
      toast(`Banking #${ref} saved.`); onDone();
    } catch (e) { setErr(String((e as Error).message)); }
    setBusy(false);
  };

  const d = data.data;
  return (
    <section className="card">
      <div className="seg" role="radiogroup" aria-label="What are you banking">
        {([['card', 'Cards'], ['cheque', 'Cheques'], ['voucher', 'Vouchers'], ['cash', 'Cash']] as [Kind, string][]).map(([k, l]) =>
          <button key={k} role="radio" aria-checked={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{l}</button>)}
      </div>
      {kind === 'card' && <Tabs value={merchant} onChange={setMerchant} items={Object.entries(MERCHANT_LABEL) as [string, string][]} />}

      {data.loading ? <Loading /> : data.error ? <ErrorBox error={data.error} /> : (
        <>
          {kind === 'card' && (!d?.cards?.length ? <Empty>No unbanked {MERCHANT_LABEL[merchant]} takings. Import the latest file first if you expect some.</Empty> : (
            <div className="table-wrap"><table>
              <thead><tr><th /><th>Day taken</th><th className="r">Transactions</th><th className="r">Takings</th><th className="r">Fees</th><th className="r">Expected</th><th>Payout</th></tr></thead>
              <tbody>{d.cards.map(c => (
                <tr key={c.txn_date} className="click" onClick={() => toggle(c.txn_date)}>
                  <td><input type="checkbox" checked={sel.has(c.txn_date)} onChange={() => toggle(c.txn_date)} onClick={e => e.stopPropagation()} aria-label="Select day" /></td>
                  <td className="nowrap">{fmtDate(c.txn_date)}</td><td className="r num">{c.unbanked_txns}</td><td className="r num">{money(c.unbanked_gross)}</td>
                  <td className="r num">{money(c.unbanked_gross - c.unbanked_net, { blankZero: true })}</td><td className="r num"><strong>{money(c.unbanked_net)}</strong></td>
                  <td className="small muted mono">{c.payout_refs ?? ''}</td>
                </tr>))}</tbody>
            </table></div>))}
          {kind === 'cheque' && (!d?.cheques?.length ? <Empty>No posted cheques waiting. Post them first on the Posting page.</Empty> : (
            <div className="table-wrap"><table>
              <thead><tr><th><input type="checkbox" aria-label="Select all" checked={sel.size === d.cheques.length} onChange={e => setSel(e.target.checked ? new Set(d.cheques!.map(c => c.id)) : new Set())} /></th><th>Posting</th><th>Received</th><th>Name</th><th>Cheque no.</th><th className="r">Amount</th></tr></thead>
              <tbody>{d.cheques.map(c => {
                const p = d.postings?.find(x => x.id === c.posting_id);
                return (<tr key={c.id} className="click" onClick={() => toggle(c.id)}>
                  <td><input type="checkbox" checked={sel.has(c.id)} onChange={() => toggle(c.id)} onClick={e => e.stopPropagation()} aria-label="Select cheque" /></td>
                  <td className="nowrap">#{p?.ref} · {p ? fmtShort(p.posting_date) : ''}</td><td className="nowrap">{fmtShort(c.received_date)}</td><td>{c.payer}</td><td>{c.cheque_no}</td><td className="r num">{money(c.amount)}</td></tr>);
              })}</tbody>
            </table></div>))}
          {kind === 'voucher' && (!d?.vouchers?.length ? <Empty>No voucher postings waiting to be paid.</Empty> : (
            <div className="table-wrap"><table>
              <thead><tr><th /><th>Posting</th><th>Posted</th><th className="r">Vouchers</th><th className="r">Fee</th><th className="r">Expected</th></tr></thead>
              <tbody>{d.vouchers.map(v => (
                <tr key={v.posting_id} className="click" onClick={() => toggle(v.posting_id)}>
                  <td><input type="checkbox" checked={sel.has(v.posting_id)} onChange={() => toggle(v.posting_id)} onClick={e => e.stopPropagation()} aria-label="Select posting" /></td>
                  <td>#{v.ref}</td><td>{fmtDate(v.since)}</td><td className="r num">{money(v.gross)}</td><td className="r num">{money(v.fee)}</td><td className="r num"><strong>{money(v.net)}</strong></td></tr>))}</tbody>
            </table></div>))}
          {kind === 'cash' && <p className="muted">Cash taken from the office to the bank. It comes off the office cash balance.</p>}
        </>
      )}

      <div className="grid3">
        <label className="field"><span>In the bank on</span><input id="b-date" type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
        <label className="field"><span>Amount received £</span><input id="b-amount" type="number" step="0.01" value={amount} onChange={e => { setTouched(true); setAmount(e.target.value); }} /></label>
        <label className="field"><span>Note</span><input id="b-note" value={note} onChange={e => setNote(e.target.value)} /></label>
      </div>
      {kind !== 'cash' && (
        <div className="totals">
          <div><span>Expected after fees</span><strong>{money(expected)}</strong></div>
          <div><span>Received</span><strong>{money(received)}</strong></div>
          <div><span>Difference</span><Diff v={sel.size ? r2(received - expected) : null} /></div>
        </div>
      )}
      {err && <ErrorBox error={err} />}
      <div className="row end"><button className="primary" disabled={busy || (kind !== 'cash' && !sel.size) || (kind === 'cash' && !received)} onClick={save}>{busy ? 'Saving…' : 'Save banking'}</button></div>
    </section>
  );
}

export async function loadBankings(from?: string, to?: string) {
  let bq = supabase.from('bankings').select('*').eq('voided', false).order('banking_date', { ascending: false });
  if (from) bq = bq.gte('banking_date', from); if (to) bq = bq.lte('banking_date', to);
  if (!from) bq = bq.limit(100);
  const banks = await q(bq) as BankingRec[];
  const ids = banks.map(b => b.id);
  if (!ids.length) return [];
  const [cards, cheques, posts] = await Promise.all([
    all((a, b) => supabase.from('card_txns').select('banking_id,amount,fee').in('banking_id', ids).eq('voided', false).range(a, b)) as Promise<{ banking_id: string; amount: number; fee: number }[]>,
    q(supabase.from('cheques').select('banking_id,amount,posting_id').in('banking_id', ids).eq('voided', false).is('bounce_of', null)) as Promise<{ banking_id: string; amount: number; posting_id: string }[]>,
    q(supabase.from('postings').select('id,banking_id,fee_fixed,fee_pct,ref').in('banking_id', ids)) as Promise<{ id: string; banking_id: string; fee_fixed: number; fee_pct: number; ref: number }[]>,
  ]);
  const vlots = posts.length ? await q(supabase.from('voucher_lots').select('posting_id,amount').in('posting_id', posts.map(p => p.id)).eq('voided', false)) as { posting_id: string; amount: number }[] : [];
  return banks.map(b => {
    let gross = 0, fee = 0, items = 0;
    if (b.kind === 'card') { const t = cards.filter(c => c.banking_id === b.id); gross = t.reduce((s, c) => s + Number(c.amount), 0); fee = t.reduce((s, c) => s + Number(c.fee), 0); items = t.length; }
    if (b.kind === 'cheque') { const t = cheques.filter(c => c.banking_id === b.id); gross = t.reduce((s, c) => s + Number(c.amount), 0); items = t.length; }
    if (b.kind === 'voucher') { for (const p of posts.filter(p => p.banking_id === b.id)) { const g = vlots.filter(v => v.posting_id === p.id).reduce((s, v) => s + Number(v.amount), 0); gross += g; fee += Number(p.fee_fixed) + g * Number(p.fee_pct) / 100; items += 1; } }
    if (b.kind === 'cash') { gross = Number(b.amount_received ?? 0); items = 1; }
    const expected = r2(gross - fee);
    const received = b.amount_received === null ? null : Number(b.amount_received);
    return { ...b, gross: r2(gross), fee: r2(fee), expected, received, diff: received === null ? null : r2(received - expected), items };
  });
}

function BankingList() {
  const toast = useToast();
  const list = useLoad(() => loadBankings(), []);
  const [voiding, setVoiding] = useState<BankingRec | null>(null);
  if (list.loading) return <Loading />; if (list.error) return <ErrorBox error={list.error} />;
  if (!list.data?.length) return <Empty>No bankings yet.</Empty>;
  return (
    <section className="card flush"><div className="table-wrap"><table>
      <thead><tr><th>#</th><th>In bank</th><th>What</th><th className="r">Items</th><th className="r">Gross</th><th className="r">Fees</th><th className="r">Expected</th><th className="r">Received</th><th className="r">Difference</th><th /></tr></thead>
      <tbody>{list.data.map(b => (
        <tr key={b.id}><td className="muted">{b.ref}</td><td className="nowrap">{fmtDate(b.banking_date)}</td>
          <td>{b.kind === 'card' ? `Cards – ${MERCHANT_LABEL[b.merchant!]}` : b.kind === 'cheque' ? 'Cheques' : b.kind === 'voucher' ? 'Vouchers' : 'Cash'}{b.note ? <span className="muted small"> · {b.note}</span> : null}</td>
          <td className="r num">{b.items}</td><td className="r num">{money(b.gross)}</td><td className="r num">{money(b.fee, { blankZero: true })}</td><td className="r num">{money(b.expected)}</td>
          <td className="r num">{money(b.received)}</td><td className="r"><Diff v={b.diff} /></td>
          <td><button className="ghost small" onClick={() => setVoiding(b)}>Void</button></td></tr>
      ))}</tbody>
    </table></div>
    {voiding && <ReasonDialog title={`Void banking #${voiding.ref}`} danger confirm="Void banking" onCancel={() => setVoiding(null)}
      prompt="Everything in this banking goes back to waiting, so it can be banked again."
      onConfirm={async reason => { await rpc('void_banking', { p_id: voiding.id, p_reason: reason }); setVoiding(null); list.reload(); toast('Banking voided.'); }} />}
    </section>
  );
}
