import { useState } from 'react';
import { q, rpc, supabase } from '../lib/supabase';
import { fmtShort, money } from '../lib/format';
import { loadCategories, inCategoryOptions, categoryName } from '../lib/data';
import { DataGrid } from '../components/DataGrid';
import { Tabs, useLoad, useToast, Loading, ErrorBox, Empty, ReasonDialog, EditDialog, HistoryDialog, AdjustedMark } from '../components/ui';

type Status = 'office' | 'posted' | 'banked' | 'all';
type Ref = { ref: number; posting_date?: string; banking_date?: string } | null;
type ChequeRow = {
  id: string; received_date: string; bank: string | null; cheque_no: string | null; payer: string | null; amount: number; status: string; bounced: boolean;
  against_pos: boolean; opening: boolean; count_id: string | null; entry_id: string | null; posting_id: string | null; banking_id: string | null; category_id: string;
  postings: Ref; bankings: Ref; created_at: string; updated_at: string;
};
type LotRow = {
  id: string; received_date: string; amount: number; opening: boolean; count_id: string | null; entry_id: string | null; posting_id: string | null; against_pos: boolean; category_id: string;
  postings: { ref: number; posting_date: string; fee_fixed: number; fee_pct: number; bankings: Ref } | null;
  counts: ({ ref: number; id: string } & Record<string, unknown>) | null; entries: ({ ref: number; id: string } & Record<string, unknown>) | null; created_at: string; updated_at: string;
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
  const cats = useLoad(loadCategories, []);
  const [act, setAct] = useState<{ c: ChequeRow; kind: 'return' | 'bounce' } | null>(null);
  const [edit, setEdit] = useState<ChequeRow | null>(null); const [hist, setHist] = useState<ChequeRow | null>(null);
  const all = list.data ?? [];
  const group = (c: ChequeRow): Status => (c.status === 'office' ? 'office' : c.status === 'posted' ? 'posted' : 'banked');
  const counts = { office: all.filter(c => group(c) === 'office').length, posted: all.filter(c => group(c) === 'posted').length, banked: all.filter(c => group(c) === 'banked').length, all: all.length };
  const s = search.trim().toLowerCase();
  const rows = all.filter(c => (filter === 'all' || group(c) === filter) && (!s || [c.payer, c.bank, c.cheque_no, String(c.amount)].some(v => String(v ?? '').toLowerCase().includes(s))));
  return (
    <>
      <div className="row wrap-row toolbar"><StatusTabs value={filter} onChange={setFilter} counts={counts} />
        <input id="chq-search" className="search" placeholder="Search name, bank, cheque no., amount…" value={search} onChange={e => setSearch(e.target.value)} /></div>
      <p className="small muted">Returned = sent back before banking; it goes back to “in office” to be posted again. Bounced = unpaid after banking; a minus cheque is added on the day it was received.</p>
      {list.loading ? <Loading /> : list.error ? <ErrorBox error={list.error} /> : !rows.length ? <Empty>No cheques here.</Empty> : (
        <section className="card flush">
          <DataGrid rows={rows} rowKey={c => c.id} initialSort={{ key: 'received', dir: 'desc' }} footerLabel={n => `${n} cheque${n === 1 ? '' : 's'}`}
            cols={[
              { key: 'received', label: 'Received', kind: 'date', value: c => c.received_date, text: c => fmtShort(c.received_date),
                render: c => <span className="nowrap">{fmtShort(c.received_date)} <AdjustedMark row={c} onClick={() => setHist(c)} /></span> },
              { key: 'payer', label: 'Name', value: c => c.payer ?? '' },
              { key: 'bank', label: 'Bank', value: c => c.bank ?? '' },
              { key: 'cheque_no', label: 'Cheque no.', value: c => c.cheque_no ?? '' },
              { key: 'category', label: 'Category', value: c => categoryName(cats.data, c.category_id) },
              { key: 'from', label: 'From', value: c => (c.opening ? 'Opening balance' : c.count_id ? 'Weekly count' : c.entry_id ? 'Entry' : '') + (!c.against_pos && !c.opening ? ' · separate' : '') },
              { key: 'amount', label: 'Amount', kind: 'money', value: c => Number(c.amount), total: true },
              { key: 'status', label: 'Status', value: c => (c.status === 'office' ? 'in office' : c.status === 'minus' ? 'minus line for bounce' : c.status), render: c => chip(c.status) },
              { key: 'posted', label: 'Posted', value: c => (c.postings ? `#${c.postings.ref} · ${fmtShort(c.postings.posting_date!)}` : '') },
              { key: 'banked', label: 'Banked', value: c => (c.bankings ? `#${c.bankings.ref} · ${fmtShort(c.bankings.banking_date!)}` : '') },
            ]}
            actions={c => <>
              {c.status === 'posted' && <button className="ghost small" onClick={() => setAct({ c, kind: 'return' })}>Returned</button>}
              {c.status === 'banked' && <button className="ghost small" onClick={() => setAct({ c, kind: 'bounce' })}>Bounced</button>}
              {c.status !== 'minus' && <button className="ghost small" onClick={() => setEdit(c)}>Adjust</button>}
            </>} />
        </section>
      )}
      {act && <ReasonDialog title={act.kind === 'return' ? 'Cheque returned before banking' : 'Cheque bounced'} danger={act.kind === 'bounce'}
        confirm={act.kind === 'return' ? 'Mark returned' : 'Mark bounced'} onCancel={() => setAct(null)}
        prompt={act.kind === 'return'
          ? <>{money(act.c.amount)} from {act.c.payer || 'this customer'} comes off its posting and goes back to “in office”, ready to post again.</>
          : <>{money(act.c.amount)} from {act.c.payer || 'this customer'} is marked bounced and a minus cheque of {money(-act.c.amount)} is added on {fmtShort(act.c.received_date)}. That day will stop matching Semtek until you enter the minus cheque in Semtek too.</>}
        onConfirm={async reason => { await rpc(act.kind === 'return' ? 'return_cheque' : 'bounce_cheque', { p_id: act.c.id, p_reason: reason }); setAct(null); list.reload(); toast(act.kind === 'return' ? 'Cheque back in the office.' : 'Cheque marked bounced.'); }} />}
      {edit && <EditDialog table="cheques" row={edit} title="Adjust cheque" onClose={() => setEdit(null)} onSaved={() => { setEdit(null); list.reload(); }}
        fields={[{ key: 'received_date', label: 'Received', type: 'date' }, { key: 'payer', label: 'Name', type: 'text' }, { key: 'bank', label: 'Bank', type: 'text' }, { key: 'cheque_no', label: 'Cheque no.', type: 'text' }, { key: 'amount', label: 'Amount £', type: 'number' }, { key: 'category_id', label: 'Category', type: 'select', options: inCategoryOptions(cats.data, edit.category_id) }, { key: 'against_pos', label: 'Should be in Semtek', type: 'bool' }]} />}
      {hist && <HistoryDialog table="cheques" id={hist.id} title="Cheque history" onClose={() => setHist(null)} />}
    </>
  );
}

export function VoucherRegister() {
  const [filter, setFilter] = useState<Status>('office');
  const list = useLoad(() => q(supabase.from('voucher_lots').select('*, postings(ref,posting_date,fee_fixed,fee_pct,bankings(ref,banking_date)), counts(*), entries(*)').eq('voided', false).order('received_date', { ascending: false }).limit(2000)) as Promise<LotRow[]>, []);
  const cats = useLoad(loadCategories, []);
  const [hist, setHist] = useState<LotRow | null>(null);
  const [adj, setAdj] = useState<LotRow | null>(null);
  const all = list.data ?? [];
  const group = (v: LotRow): Status => (!v.postings ? 'office' : v.postings.bankings ? 'banked' : 'posted');
  const counts = { office: all.filter(v => group(v) === 'office').length, posted: all.filter(v => group(v) === 'posted').length, banked: all.filter(v => group(v) === 'banked').length, all: all.length };
  const rows = all.filter(v => filter === 'all' || group(v) === filter);
  return (
    <>
      <div className="row wrap-row toolbar"><StatusTabs value={filter} onChange={setFilter} counts={counts} /></div>
      <p className="small muted">Vouchers are kept as one amount per count or entry. Adjust changes the date and amount of a line directly; the change is kept in its history.</p>
      {list.loading ? <Loading /> : list.error ? <ErrorBox error={list.error} /> : !rows.length ? <Empty>No vouchers here.</Empty> : (
        <section className="card flush">
          <DataGrid rows={rows} rowKey={v => v.id} initialSort={{ key: 'received', dir: 'desc' }} footerLabel={n => `${n} item${n === 1 ? '' : 's'}`}
            cols={[
              { key: 'received', label: 'Received', kind: 'date', value: v => v.received_date, text: v => fmtShort(v.received_date),
                render: v => <span className="nowrap">{fmtShort(v.received_date)} <AdjustedMark row={v} onClick={() => setHist(v)} /></span> },
              { key: 'from', label: 'From', value: v => (v.opening ? 'Opening balance' : v.counts ? `Weekly count #${v.counts.ref}` : v.entries ? `Entry #${v.entries.ref}` : '') },
              { key: 'category', label: 'Category', value: v => categoryName(cats.data, v.category_id) },
              { key: 'amount', label: 'Amount', kind: 'money', value: v => Number(v.amount), total: true },
              { key: 'status', label: 'Status', value: v => (group(v) === 'office' ? 'in office' : group(v)), render: v => chip(group(v)) },
              { key: 'posted', label: 'Posted', value: v => (v.postings ? `#${v.postings.ref} · ${fmtShort(v.postings.posting_date)}` : '') },
              { key: 'fee', label: 'Fee', kind: 'money', total: true, value: v => (v.postings ? Number(v.postings.fee_fixed) + Number(v.amount) * Number(v.postings.fee_pct) / 100 : 0) },
              { key: 'banked', label: 'Banked', value: v => (v.postings?.bankings ? `#${v.postings.bankings.ref} · ${fmtShort(v.postings.bankings.banking_date!)}` : '') },
            ]}
            actions={v => <button className="ghost small" onClick={() => setAdj(v)}>Adjust</button>} />
        </section>
      )}
      {adj && <EditDialog table="voucher_lots" row={adj as unknown as Record<string, unknown>} title="Adjust vouchers" onClose={() => setAdj(null)} onSaved={() => { setAdj(null); list.reload(); }}
        fields={[{ key: 'received_date', label: 'Received on', type: 'date' }, { key: 'amount', label: 'Amount £', type: 'number' }, { key: 'category_id', label: 'Category', type: 'select', options: inCategoryOptions(cats.data, adj.category_id) }, { key: 'against_pos', label: 'Should be in Semtek', type: 'bool' }]} />}
      {hist && <HistoryDialog table="voucher_lots" id={hist.id} title="Voucher history" onClose={() => setHist(null)} />}
    </>
  );
}
