import { useState } from 'react';
import { q, rpc, supabase } from '../lib/supabase';
import { fmtShort, money } from '../lib/format';
import { Tabs, useLoad, useToast, Loading, ErrorBox, Empty, ReasonDialog, EditDialog, HistoryDialog, AdjustedMark } from '../components/ui';

type Status = 'office' | 'posted' | 'banked' | 'all';
type Ref = { ref: number; posting_date?: string; banking_date?: string } | null;
type ChequeRow = {
  id: string; received_date: string; bank: string | null; cheque_no: string | null; payer: string | null; amount: number; status: string; bounced: boolean;
  against_pos: boolean; opening: boolean; count_id: string | null; entry_id: string | null; posting_id: string | null; banking_id: string | null;
  postings: Ref; bankings: Ref; created_at: string; updated_at: string;
};
type LotRow = {
  id: string; received_date: string; amount: number; opening: boolean; count_id: string | null; entry_id: string | null; posting_id: string | null; against_pos: boolean;
  postings: { ref: number; posting_date: string; fee_fixed: number; fee_pct: number; bankings: Ref } | null;
  counts: { ref: number } | null; entries: { ref: number } | null; created_at: string; updated_at: string;
};

const chip = (status: string) => {
  const label = status === 'minus' ? 'minus line for bounce' : status === 'office' ? 'in office' : status;
  const cls = status === 'banked' ? 'ok' : status === 'bounced' || status === 'minus' ? 'short' : 'pending';
  return <span className={`chip ${cls}`}>{label}</span>;
};

function StatusTabs({ value, onChange, counts }: { value: Status; onChange: (s: Status) => void; counts: Record<Status, number> }) {
  return <Tabs value={value} onChange={onChange} items={[['office', `In office (${counts.office})`], ['posted', `Posted (${counts.posted})`], ['banked', `Banked (${counts.banked})`], ['all', `All (${counts.all})`]]} />;
}

export function ChequeRegister() {
  const toast = useToast();
  const [filter, setFilter] = useState<Status>('office');
  const [search, setSearch] = useState('');
  const list = useLoad(() => q(supabase.from('cheques').select('*, postings(ref,posting_date), bankings(ref,banking_date)').eq('voided', false).order('received_date', { ascending: false }).limit(2000)) as Promise<ChequeRow[]>, []);
  const [act, setAct] = useState<{ c: ChequeRow; kind: 'return' | 'bounce' } | null>(null);
  const [edit, setEdit] = useState<ChequeRow | null>(null); const [hist, setHist] = useState<ChequeRow | null>(null);
  const all = list.data ?? [];
  const group = (c: ChequeRow): Status => (c.status === 'office' ? 'office' : c.status === 'posted' ? 'posted' : 'banked');
  const counts = { office: all.filter(c => group(c) === 'office').length, posted: all.filter(c => group(c) === 'posted').length, banked: all.filter(c => group(c) === 'banked').length, all: all.length };
  const s = search.trim().toLowerCase();
  const rows = all.filter(c => (filter === 'all' || group(c) === filter) && (!s || [c.payer, c.bank, c.cheque_no, String(c.amount)].some(v => String(v ?? '').toLowerCase().includes(s))));
  const total = rows.reduce((x, c) => x + Number(c.amount), 0);
  return (
    <>
      <div className="row wrap-row toolbar"><StatusTabs value={filter} onChange={setFilter} counts={counts} />
        <input id="chq-search" className="search" placeholder="Search name, bank, cheque no., amount…" value={search} onChange={e => setSearch(e.target.value)} /></div>
      <p className="small muted">Returned = sent back before banking; it goes back to “in office” to be posted again. Bounced = unpaid after banking; a minus cheque is added on the day it was received.</p>
      {list.loading ? <Loading /> : list.error ? <ErrorBox error={list.error} /> : !rows.length ? <Empty>No cheques here.</Empty> : (
        <section className="card flush"><div className="table-wrap"><table>
          <thead><tr><th>Received</th><th>Name</th><th>Bank</th><th>Cheque no.</th><th>From</th><th className="r">Amount</th><th>Status</th><th>Posted</th><th>Banked</th><th /></tr></thead>
          <tbody>{rows.map(c => (
            <tr key={c.id}><td className="nowrap">{fmtShort(c.received_date)} <AdjustedMark row={c} onClick={() => setHist(c)} /></td>
              <td>{c.payer}</td><td>{c.bank}</td><td>{c.cheque_no}</td>
              <td className="small muted">{c.opening ? 'Opening balance' : c.count_id ? 'Weekly count' : c.entry_id ? 'Entry' : ''}{!c.against_pos && !c.opening ? ' · separate' : ''}</td>
              <td className="r num">{money(c.amount)}</td><td>{chip(c.status)}</td>
              <td className="nowrap small">{c.postings ? `#${c.postings.ref} · ${fmtShort(c.postings.posting_date!)}` : ''}</td>
              <td className="nowrap small">{c.bankings ? `#${c.bankings.ref} · ${fmtShort(c.bankings.banking_date!)}` : ''}</td>
              <td className="nowrap">
                {c.status === 'posted' && <button className="ghost small" onClick={() => setAct({ c, kind: 'return' })}>Returned</button>}
                {c.status === 'banked' && <button className="ghost small" onClick={() => setAct({ c, kind: 'bounce' })}>Bounced</button>}
                {c.status !== 'minus' && <button className="ghost small" onClick={() => setEdit(c)}>Adjust</button>}
              </td></tr>
          ))}</tbody>
          <tfoot><tr><th colSpan={5}>{rows.length} cheque{rows.length === 1 ? '' : 's'}</th><td className="r num">{money(total)}</td><td colSpan={4} /></tr></tfoot>
        </table></div></section>
      )}
      {act && <ReasonDialog title={act.kind === 'return' ? 'Cheque returned before banking' : 'Cheque bounced'} danger={act.kind === 'bounce'}
        confirm={act.kind === 'return' ? 'Mark returned' : 'Mark bounced'} onCancel={() => setAct(null)}
        prompt={act.kind === 'return'
          ? <>{money(act.c.amount)} from {act.c.payer || 'this customer'} comes off its posting and goes back to “in office”, ready to post again.</>
          : <>{money(act.c.amount)} from {act.c.payer || 'this customer'} is marked bounced and a minus cheque of {money(-act.c.amount)} is added on {fmtShort(act.c.received_date)}. That day will stop matching Semtek until you enter the minus cheque in Semtek too.</>}
        onConfirm={async reason => { await rpc(act.kind === 'return' ? 'return_cheque' : 'bounce_cheque', { p_id: act.c.id, p_reason: reason }); setAct(null); list.reload(); toast(act.kind === 'return' ? 'Cheque back in the office.' : 'Cheque marked bounced.'); }} />}
      {edit && <EditDialog table="cheques" row={edit} title="Adjust cheque" onClose={() => setEdit(null)} onSaved={() => { setEdit(null); list.reload(); }}
        fields={[{ key: 'received_date', label: 'Received', type: 'date' }, { key: 'payer', label: 'Name', type: 'text' }, { key: 'bank', label: 'Bank', type: 'text' }, { key: 'cheque_no', label: 'Cheque no.', type: 'text' }, { key: 'amount', label: 'Amount £', type: 'number' }, { key: 'against_pos', label: 'Should be in Semtek', type: 'bool' }]} />}
      {hist && <HistoryDialog table="cheques" id={hist.id} title="Cheque history" onClose={() => setHist(null)} />}
    </>
  );
}

export function VoucherRegister() {
  const [filter, setFilter] = useState<Status>('office');
  const list = useLoad(() => q(supabase.from('voucher_lots').select('*, postings(ref,posting_date,fee_fixed,fee_pct,bankings(ref,banking_date)), counts(ref), entries(ref)').eq('voided', false).order('received_date', { ascending: false }).limit(2000)) as Promise<LotRow[]>, []);
  const [hist, setHist] = useState<LotRow | null>(null);
  const all = list.data ?? [];
  const group = (v: LotRow): Status => (!v.postings ? 'office' : v.postings.bankings ? 'banked' : 'posted');
  const counts = { office: all.filter(v => group(v) === 'office').length, posted: all.filter(v => group(v) === 'posted').length, banked: all.filter(v => group(v) === 'banked').length, all: all.length };
  const rows = all.filter(v => filter === 'all' || group(v) === filter);
  const total = rows.reduce((x, v) => x + Number(v.amount), 0);
  return (
    <>
      <div className="row wrap-row toolbar"><StatusTabs value={filter} onChange={setFilter} counts={counts} /></div>
      <p className="small muted">Vouchers are kept as one amount per count or entry. To change an amount, adjust the count or entry it came from.</p>
      {list.loading ? <Loading /> : list.error ? <ErrorBox error={list.error} /> : !rows.length ? <Empty>No vouchers here.</Empty> : (
        <section className="card flush"><div className="table-wrap"><table>
          <thead><tr><th>Received</th><th>From</th><th className="r">Amount</th><th>Status</th><th>Posted</th><th className="r">Fee</th><th>Banked</th></tr></thead>
          <tbody>{rows.map(v => {
            const p = v.postings; const fee = p ? Number(p.fee_fixed) + Number(v.amount) * Number(p.fee_pct) / 100 : null;
            return (
              <tr key={v.id}><td className="nowrap">{fmtShort(v.received_date)} <AdjustedMark row={v} onClick={() => setHist(v)} /></td>
                <td className="small">{v.opening ? 'Opening balance' : v.counts ? `Weekly count #${v.counts.ref}` : v.entries ? `Entry #${v.entries.ref}` : ''}</td>
                <td className="r num">{money(v.amount)}</td><td>{chip(group(v))}</td>
                <td className="nowrap small">{p ? `#${p.ref} · ${fmtShort(p.posting_date)}` : ''}</td>
                <td className="r num small">{fee ? money(fee) : ''}</td>
                <td className="nowrap small">{p?.bankings ? `#${p.bankings.ref} · ${fmtShort(p.bankings.banking_date!)}` : ''}</td></tr>);
          })}</tbody>
          <tfoot><tr><th colSpan={2}>{rows.length} item{rows.length === 1 ? '' : 's'}</th><td className="r num">{money(total)}</td><td colSpan={4} /></tr></tfoot>
        </table></div></section>
      )}
      {hist && <HistoryDialog table="voucher_lots" id={hist.id} title="Voucher history" onClose={() => setHist(null)} />}
    </>
  );
}
