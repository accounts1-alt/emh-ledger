import { Fragment, useState } from 'react';
import { all, q, supabase } from '../lib/supabase';
import { loadCategories, loadCompare, loadMovements } from '../lib/data';
import { addDays } from '../lib/recon';
import { ACCOUNTS, ACCOUNT_LABEL, ENTRY_ACCOUNT_LABEL, MERCHANT_LABEL, fmtDate, fmtShort, money, r2 } from '../lib/format';
import { PageHead, Tabs, DateRange, useLoad, Loading, ErrorBox, Empty, Diff } from '../components/ui';
import { exportSheet } from '../lib/exporter';
import { CompareTable, BacsTable, useDefaultRange } from './Compare';
import { loadBankings } from './Banking';
import { FEE_PROVIDER } from './Fees';

type Tab = 'semtek' | 'bank' | 'balances' | 'inout' | 'out' | 'fees';

export default function ReportsPage() {
  const [from, to, setRange, ready] = useDefaultRange(28);
  const [tab, setTab] = useState<Tab>('semtek');
  return (
    <>
      <PageHead title="Reports" sub="Pick a period and a report. Every report can be saved to Excel.">
        {ready && <DateRange from={from} to={to} onChange={setRange} />}
      </PageHead>
      <Tabs value={tab} onChange={setTab} items={[['semtek', 'Against Semtek'], ['bank', 'Against bank'], ['balances', 'Balances'], ['inout', 'Received & spent'], ['out', 'Expenses'], ['fees', 'Fees']]} />
      {!ready ? <Loading /> : tab === 'semtek' ? <SemtekReport from={from} to={to} /> : tab === 'bank' ? <BankReport from={from} to={to} />
        : tab === 'balances' ? <BalancesReport from={from} to={to} /> : tab === 'inout' ? <InOutReport from={from} to={to} /> : tab === 'out' ? <ExpensesReport from={from} to={to} /> : <FeesReport from={from} to={to} />}
    </>
  );
}

const ExportBtn = ({ onClick }: { onClick: () => void }) => <div className="row end"><button className="ghost" onClick={onClick}>Export to Excel</button></div>;

function SemtekReport({ from, to }: { from: string; to: string }) {
  const { data, error, loading } = useLoad(() => loadCompare(from, to), [from, to]);
  if (loading) return <Loading />; if (error || !data) return <ErrorBox error={error ?? ''} />;
  const K = ['cash', 'cheque', 'vouchers', 'cards', 'bacs'] as const;
  return (
    <>
      <ExportBtn onClick={() => exportSheet(`Against Semtek ${from} to ${to}`, [
        ['From', 'To', ...K.flatMap(k => [`${k} Semtek`, `${k} actual`, `${k} difference`]), 'Missing data'],
        ...data.groups.map(g => [g.from, g.to, ...K.flatMap(k => [g[k].semtek, g[k].actual ?? '', g[k].diff ?? '']), g.missing.join(', ')])])} />
      <section className="card flush"><CompareTable groups={data.groups} /></section>
      <h3>BACS line by line</h3>
      <BacsTable data={data.bacs} />
    </>
  );
}

function BankReport({ from, to }: { from: string; to: string }) {
  const { data, error, loading } = useLoad(() => loadBankings(from, to), [from, to]);
  if (loading) return <Loading />; if (error) return <ErrorBox error={error} />;
  if (!data?.length) return <Empty>No bankings recorded in this period.</Empty>;
  const what = (b: (typeof data)[number]) => b.kind === 'card' ? `Cards – ${MERCHANT_LABEL[b.merchant!]}` : b.kind === 'cheque' ? 'Cheques' : b.kind === 'voucher' ? 'Vouchers' : 'Cash';
  const sum = (k: 'gross' | 'fee' | 'expected') => r2(data.reduce((s, b) => s + b[k], 0));
  const rec = r2(data.reduce((s, b) => s + (b.received ?? 0), 0));
  return (
    <>
      <ExportBtn onClick={() => exportSheet(`Against bank ${from} to ${to}`, [['Banking #', 'Date in bank', 'What', 'Items', 'Gross', 'Fees', 'Expected', 'Received', 'Difference'],
        ...data.map(b => [b.ref, b.banking_date, what(b), b.items, b.gross, b.fee, b.expected, b.received ?? '', b.diff ?? ''])])} />
      <section className="card flush"><div className="table-wrap"><table>
        <thead><tr><th>#</th><th>In bank</th><th>What</th><th className="r">Items</th><th className="r">Gross</th><th className="r">Fees</th><th className="r">Expected</th><th className="r">Received</th><th className="r">Difference</th></tr></thead>
        <tbody>{[...data].reverse().map(b => (
          <tr key={b.id}><td className="muted">{b.ref}</td><td className="nowrap">{fmtDate(b.banking_date)}</td><td>{what(b)}</td><td className="r num">{b.items}</td>
            <td className="r num">{money(b.gross)}</td><td className="r num">{money(b.fee, { blankZero: true })}</td><td className="r num">{money(b.expected)}</td><td className="r num">{money(b.received)}</td><td className="r"><Diff v={b.diff} /></td></tr>))}</tbody>
        <tfoot><tr><th colSpan={4}>Total</th><td className="r num">{money(sum('gross'))}</td><td className="r num">{money(sum('fee'))}</td><td className="r num">{money(sum('expected'))}</td><td className="r num">{money(rec)}</td><td className="r"><Diff v={r2(rec - sum('expected'))} /></td></tr></tfoot>
      </table></div></section>
    </>
  );
}

function BalancesReport({ from, to }: { from: string; to: string }) {
  const { data, error, loading } = useLoad(() => loadMovements(to), [to]);
  const [open, setOpen] = useState<string | null>(null);
  if (loading) return <Loading />; if (error || !data) return <ErrorBox error={error ?? ''} />;
  const rows = ACCOUNTS.map(a => {
    const m = data.filter(x => x.account === a);
    const opening = r2(m.filter(x => x.mdate < from).reduce((s, x) => s + x.amount, 0));
    const inRange = m.filter(x => x.mdate >= from);
    const ins = r2(inRange.filter(x => x.amount > 0).reduce((s, x) => s + x.amount, 0));
    const outs = r2(inRange.filter(x => x.amount < 0).reduce((s, x) => s + x.amount, 0));
    return { a, opening, ins, outs, closing: r2(opening + ins + outs), lines: inRange };
  });
  return (
    <>
      <ExportBtn onClick={() => exportSheet(`Balances ${from} to ${to}`, [['Account', `Balance before ${from}`, 'In', 'Out', `Balance at ${to}`], ...rows.map(r => [ACCOUNT_LABEL[r.a], r.opening, r.ins, r.outs, r.closing]),
        [], ['Account', 'Date', 'Detail', 'Amount'], ...rows.flatMap(r => r.lines.map(l => [ACCOUNT_LABEL[r.a], l.mdate, l.detail, l.amount]))])} />
      <section className="card flush"><div className="table-wrap"><table>
        <thead><tr><th>Account</th><th className="r">Before {fmtShort(from)}</th><th className="r">In</th><th className="r">Out</th><th className="r">At {fmtShort(to)}</th></tr></thead>
        <tbody>{rows.map(r => (<Fragment key={r.a}>
          <tr className="click" onClick={() => setOpen(open === r.a ? null : r.a)}><td><span className="caret">{open === r.a ? '▾' : '▸'}</span> {ACCOUNT_LABEL[r.a]}</td>
            <td className="r num">{money(r.opening)}</td><td className="r num">{money(r.ins, { blankZero: true })}</td><td className="r num">{money(r.outs, { blankZero: true })}</td><td className={`r num ${r.closing < 0 ? 'bad' : ''}`}><strong>{money(r.closing)}</strong></td></tr>
          {open === r.a && (r.lines.length ? r.lines.map((l, i) => (
            <tr key={r.a + i} className="sub-row"><td className="small">{fmtShort(l.mdate)} · {l.detail}</td><td /><td className="r num small">{l.amount > 0 ? money(l.amount) : ''}</td><td className="r num small">{l.amount < 0 ? money(l.amount) : ''}</td><td /></tr>))
            : <tr key={r.a + 'none'} className="sub-row"><td colSpan={5} className="small muted">No movements in this period.</td></tr>)}
        </Fragment>))}</tbody>
        <tfoot><tr><th>Total</th>{(['opening', 'ins', 'outs', 'closing'] as const).map(k => <td key={k} className="r num">{money(rows.reduce((s, r) => s + r[k], 0))}</td>)}</tr></tfoot>
      </table></div></section>
      <p className="small muted">Floats moving to the shop and money moving between accounts show as out of one account and into another. Click an account for its lines.</p>
    </>
  );
}

type EntryLine = { ref: number; entry_date: string; direction: 'in' | 'out'; account: string; category_id: string; against_pos: boolean; amount: number; reference: string | null; note: string | null };
async function loadEntries(from: string, to: string) {
  const [entries, cats] = await Promise.all([
    all((a, b) => supabase.from('entries').select('ref,entry_date,direction,account,category_id,against_pos,amount,reference,note').eq('voided', false).gte('entry_date', from).lte('entry_date', to).order('entry_date').range(a, b)) as Promise<EntryLine[]>,
    loadCategories(),
  ]);
  return { entries: entries.map(e => ({ ...e, amount: Number(e.amount), cat: cats.find(c => c.id === e.category_id)?.name ?? '?' })), cats };
}

function InOutReport({ from, to }: { from: string; to: string }) {
  const { data, error, loading } = useLoad(async () => {
    const [{ entries, cats }, sem, cards, counts, cheques, lots] = await Promise.all([
      loadEntries(from, to),
      q(supabase.from('v_semtek_daily').select('*').gte('txn_date', from).lte('txn_date', to)) as Promise<Record<string, number>[]>,
      // money in other categories, kept out of Semtek (entries are counted separately, so items from entries are skipped)
      all((a, b) => supabase.from('card_txns').select('amount,category_id').eq('voided', false).eq('against_pos', false).gte('txn_date', from).lte('txn_date', to).range(a, b)) as Promise<{ amount: number; category_id: string }[]>,
      q(supabase.from('counts').select('cash_total,category_id').eq('voided', false).eq('against_pos', false).gte('date_from', from).lte('date_from', to)) as Promise<{ cash_total: number; category_id: string }[]>,
      q(supabase.from('cheques').select('amount,category_id').eq('voided', false).eq('against_pos', false).eq('opening', false).is('entry_id', null).is('bounce_of', null).gte('received_date', from).lte('received_date', to)) as Promise<{ amount: number; category_id: string }[]>,
      q(supabase.from('voucher_lots').select('amount,category_id').eq('voided', false).eq('against_pos', false).eq('opening', false).is('entry_id', null).gte('received_date', from).lte('received_date', to)) as Promise<{ amount: number; category_id: string }[]>,
    ]);
    const name = (id: string) => cats.find(c => c.id === id)?.name ?? '?';
    const items = [
      ...cards.map(x => ({ cat: name(x.category_id), col: 'card', amount: Number(x.amount) })),
      ...counts.map(x => ({ cat: name(x.category_id), col: 'cash', amount: Number(x.cash_total) })),
      ...cheques.map(x => ({ cat: name(x.category_id), col: 'cheque', amount: Number(x.amount) })),
      ...lots.map(x => ({ cat: name(x.category_id), col: 'voucher', amount: Number(x.amount) })),
    ];
    return { entries, sem, items };
  }, [from, to]);
  if (loading) return <Loading />; if (error || !data) return <ErrorBox error={error ?? ''} />;
  const semSum = (k: string) => r2(data.sem.reduce((s, d) => s + Number(d[k] ?? 0), 0));
  const COLS = ['cash', 'cheque', 'voucher', 'card', 'bacs'];
  const colOf = (acct: string) => (['cash', 'cheque', 'voucher'].includes(acct) ? acct : 'card');
  const build = (dir: 'in' | 'out') => {
    const map = new Map<string, Record<string, number>>();
    if (dir === 'in') map.set('Semtek (POS) – from the till', { cash: semSum('cash'), cheque: semSum('cheque'), voucher: semSum('vouchers'), card: semSum('credit_card'), bacs: semSum('bacs') });
    for (const e of data.entries.filter(x => x.direction === dir && !(dir === 'in' && x.against_pos))) {
      const r = map.get(e.cat) ?? {}; r[colOf(e.account)] = r2((r[colOf(e.account)] ?? 0) + e.amount); map.set(e.cat, r);
    }
    if (dir === 'in') for (const it of data.items) { const r = map.get(it.cat) ?? {}; r[it.col] = r2((r[it.col] ?? 0) + it.amount); map.set(it.cat, r); }
    return [...map.entries()];
  };
  const tbl = (title: string, rows: [string, Record<string, number>][]) => (
    <section className="card flush"><h2 className="pad">{title}</h2><div className="table-wrap"><table>
      <thead><tr><th>Category</th>{COLS.map(c => <th key={c} className="r">{c === 'bacs' ? 'BACS' : c[0].toUpperCase() + c.slice(1) + (c === 'card' ? 's' : c === 'cash' ? '' : 's')}</th>)}<th className="r">Total</th></tr></thead>
      <tbody>{rows.length ? rows.map(([cat, r]) => <tr key={cat}><td>{cat}</td>{COLS.map(c => <td key={c} className="r num">{money(r[c] ?? 0, { blankZero: true })}</td>)}<td className="r num"><strong>{money(COLS.reduce((s, c) => s + (r[c] ?? 0), 0))}</strong></td></tr>)
        : <tr><td colSpan={7} className="muted">Nothing in this period.</td></tr>}</tbody>
      <tfoot><tr><th>Total</th>{COLS.map(c => <td key={c} className="r num">{money(rows.reduce((s, [, r]) => s + (r[c] ?? 0), 0), { blankZero: true })}</td>)}<td className="r num">{money(rows.reduce((s, [, r]) => s + COLS.reduce((x, c) => x + (r[c] ?? 0), 0), 0))}</td></tr></tfoot>
    </table></div></section>
  );
  const ins = build('in'), outs = build('out');
  const posIn = data.entries.filter(e => e.direction === 'in' && e.against_pos);
  return (
    <>
      <ExportBtn onClick={() => exportSheet(`Received and spent ${from} to ${to}`, [['Money received', ...COLS, 'Total'], ...ins.map(([c, r]) => [c, ...COLS.map(k => r[k] ?? 0), COLS.reduce((s, k) => s + (r[k] ?? 0), 0)]), [],
        ['Money spent', ...COLS, 'Total'], ...outs.map(([c, r]) => [c, ...COLS.map(k => r[k] ?? 0), COLS.reduce((s, k) => s + (r[k] ?? 0), 0)])])} />
      {tbl('Money received', ins)}
      {posIn.length > 0 && <p className="small muted">{posIn.length} entr{posIn.length > 1 ? 'ies' : 'y'} marked “should be in Semtek” ({money(posIn.reduce((s, e) => s + e.amount, 0))}) are already inside the Semtek figures, so they are not added again.</p>}
      {tbl('Money spent', outs)}
    </>
  );
}

function ExpensesReport({ from, to }: { from: string; to: string }) {
  const { data, error, loading } = useLoad(() => loadEntries(from, to), [from, to]);
  if (loading) return <Loading />; if (error || !data) return <ErrorBox error={error ?? ''} />;
  const outs = data.entries.filter(e => e.direction === 'out');
  if (!outs.length) return <Empty>No money spent recorded in this period.</Empty>;
  const cats = [...new Set(outs.map(e => e.cat))].sort();
  return (
    <>
      <ExportBtn onClick={() => exportSheet(`Expenses ${from} to ${to}`, [['Entry #', 'Date', 'Category', 'Paid by', 'Reference', 'Note', 'Amount'], ...outs.map(e => [e.ref, e.entry_date, e.cat, ENTRY_ACCOUNT_LABEL[e.account], e.reference ?? '', e.note ?? '', e.amount])])} />
      <section className="card flush"><div className="table-wrap"><table>
        <thead><tr><th>Date</th><th>Paid by</th><th>Reference</th><th className="r">Amount</th></tr></thead>
        {cats.map(c => { const rows = outs.filter(e => e.cat === c); return (
          <tbody key={c}>
            <tr className="grp"><th colSpan={3}>{c}</th><th className="r num">{money(rows.reduce((s, e) => s + e.amount, 0))}</th></tr>
            {rows.map(e => <tr key={e.ref}><td className="nowrap">{fmtShort(e.entry_date)} <span className="muted small">#{e.ref}</span></td><td>{ENTRY_ACCOUNT_LABEL[e.account]}</td><td className="wrap">{e.reference}{e.note ? <span className="muted"> · {e.note}</span> : null}</td><td className="r num">{money(e.amount)}</td></tr>)}
          </tbody>); })}
        <tfoot><tr><th colSpan={3}>Total spent</th><td className="r num"><strong>{money(outs.reduce((s, e) => s + e.amount, 0))}</strong></td></tr></tfoot>
      </table></div></section>
    </>
  );
}

function FeesReport({ from, to }: { from: string; to: string }) {
  const { data, error, loading } = useLoad(async () => {
    const [cardFees, postings, fees] = await Promise.all([
      q(supabase.from('v_card_daily').select('merchant,fee,gross').gte('txn_date', from).lte('txn_date', to)) as Promise<{ merchant: string; fee: number; gross: number }[]>,
      q(supabase.from('postings').select('id,kind,fee_fixed,fee_pct,posting_date').eq('voided', false).gte('posting_date', from).lte('posting_date', to)) as Promise<{ id: string; kind: string; fee_fixed: number; fee_pct: number }[]>,
      q(supabase.from('fees').select('provider,amount').eq('voided', false).gte('fee_date', from).lte('fee_date', addDays(to, 0))) as Promise<{ provider: string; amount: number }[]>,
    ]);
    const ids = postings.map(p => p.id);
    const [chq, vch] = ids.length ? await Promise.all([
      q(supabase.from('cheques').select('posting_id,amount').in('posting_id', ids).eq('voided', false)) as Promise<{ posting_id: string; amount: number }[]>,
      q(supabase.from('voucher_lots').select('posting_id,amount').in('posting_id', ids).eq('voided', false)) as Promise<{ posting_id: string; amount: number }[]>,
    ]) : [[], []];
    const rows: Record<string, { taken: number; fee: number; separate: number }> = {};
    const add = (k: string, taken: number, fee: number, sep = 0) => { const r = rows[k] ?? { taken: 0, fee: 0, separate: 0 }; r.taken += taken; r.fee += fee; r.separate += sep; rows[k] = r; };
    for (const c of cardFees) add(c.merchant, Number(c.gross), Number(c.fee));
    for (const p of postings) { const g = [...chq, ...vch].filter(i => i.posting_id === p.id).reduce((s, i) => s + Number(i.amount), 0); add(p.kind === 'cheque' ? 'cheques' : 'vouchers', g, Number(p.fee_fixed) + g * Number(p.fee_pct) / 100); }
    for (const f of fees) add(f.provider, 0, 0, Number(f.amount));
    return Object.entries(rows);
  }, [from, to]);
  if (loading) return <Loading />; if (error || !data) return <ErrorBox error={error ?? ''} />;
  if (!data.length) return <Empty>No fees in this period.</Empty>;
  return (
    <>
      <ExportBtn onClick={() => exportSheet(`Fees ${from} to ${to}`, [['Provider', 'Money taken / posted', 'Fees per transaction or posting', 'Separate fees (e.g. direct debit)', 'Total fees'], ...data.map(([k, r]) => [FEE_PROVIDER[k], r2(r.taken), r2(r.fee), r2(r.separate), r2(r.fee + r.separate)])])} />
      <section className="card flush"><div className="table-wrap"><table>
        <thead><tr><th>Provider</th><th className="r">Taken / posted</th><th className="r">Per transaction / posting</th><th className="r">Separate fees</th><th className="r">Total fees</th><th className="r">% of takings</th></tr></thead>
        <tbody>{data.map(([k, r]) => <tr key={k}><td>{FEE_PROVIDER[k]}</td><td className="r num">{money(r.taken, { blankZero: true })}</td><td className="r num">{money(r.fee, { blankZero: true })}</td><td className="r num">{money(r.separate, { blankZero: true })}</td>
          <td className="r num"><strong>{money(r.fee + r.separate)}</strong></td><td className="r num">{r.taken ? ((r.fee + r.separate) / r.taken * 100).toFixed(2) + '%' : '–'}</td></tr>)}</tbody>
        <tfoot><tr><th>Total</th><td className="r num">{money(data.reduce((s, [, r]) => s + r.taken, 0))}</td><td className="r num">{money(data.reduce((s, [, r]) => s + r.fee, 0))}</td><td className="r num">{money(data.reduce((s, [, r]) => s + r.separate, 0))}</td><td className="r num">{money(data.reduce((s, [, r]) => s + r.fee + r.separate, 0))}</td><td /></tr></tfoot>
      </table></div></section>
      <p className="small muted">Paymentsense card fees are charged by monthly direct debit, so they appear under “separate fees” once you enter them on the Fees page.</p>
    </>
  );
}
