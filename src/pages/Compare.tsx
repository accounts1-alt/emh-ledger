import { useEffect, useState } from 'react';
import { loadCompare, latestSemtekDate } from '../lib/data';
import { addDays, type CompareGroup, type Figure } from '../lib/recon';
import { fmtRange, fmtShort, money, today, MERCHANT_LABEL } from '../lib/format';
import { PageHead, DateRange, useLoad, Loading, ErrorBox, Diff, Modal, Empty, Tabs } from '../components/ui';
import { exportSheet } from '../lib/exporter';

const COLS: [keyof Pick<CompareGroup, 'cash' | 'cheque' | 'vouchers' | 'cards' | 'bacs'>, string][] = [
  ['cash', 'Cash (after float)'], ['cheque', 'Cheques'], ['vouchers', 'Vouchers'], ['cards', 'Cards'], ['bacs', 'BACS'],
];

export function useDefaultRange(days = 14): [string, string, (f: string, t: string) => void, boolean] {
  const [range, setRange] = useState<[string, string] | null>(null);
  useEffect(() => { latestSemtekDate().then(d => { const end = d ?? today(); setRange([addDays(end, -(days - 1)), end]); }).catch(() => setRange([addDays(today(), -(days - 1)), today()])); }, [days]);
  return [range?.[0] ?? '', range?.[1] ?? '', (f, t) => setRange([f, t]), !!range];
}

export function CompareTable({ groups, onPick }: { groups: CompareGroup[]; onPick?: (g: CompareGroup) => void }) {
  const tot = (k: typeof COLS[number][0]) => {
    const s = groups.reduce((a, g) => a + g[k].semtek, 0);
    const known = groups.filter(g => g[k].actual !== null);
    const a = known.reduce((x, g) => x + (g[k].actual ?? 0), 0);
    const sk = known.reduce((x, g) => x + g[k].semtek, 0);
    const waiting = groups.some(g => g[k].actual === null && g[k].semtek !== 0);
    return { s, a, d: known.length && !waiting ? a - sk : null, waiting };
  };
  return (
    <div className="table-wrap"><table className="cmp">
      <thead><tr><th>Date</th>{COLS.map(([k, l]) => <th key={k} className="r">{l}</th>)}<th>Missing</th></tr></thead>
      <tbody>
        {groups.map(g => {
          const quiet = COLS.every(([k]) => g[k].semtek === 0 && !g[k].actual) && !g.counts.length;
          return (
            <tr key={g.from} className={`${onPick ? 'click' : ''} ${quiet ? 'quiet' : ''}`} onClick={() => onPick?.(g)} tabIndex={onPick ? 0 : undefined}
              onKeyDown={e => { if (e.key === 'Enter') onPick?.(g); }}>
              <td className="nowrap"><strong>{g.from === g.to ? fmtShort(g.from) : `${fmtShort(g.from)} – ${fmtShort(g.to)}`}</strong>
                <div className="muted small">{new Date(g.from + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })}{g.from !== g.to ? ' (counted together)' : ''}</div></td>
              {COLS.map(([k]) => <Cell key={k} f={g[k]} />)}
              <td className="small wrap">{g.missing.length >= 5 ? <span className="muted">Nothing loaded</span> : g.missing.length ? <span className="warn">{g.missing.join(', ')}</span> : <span className="muted">–</span>}</td>
            </tr>
          );
        })}
      </tbody>
      <tfoot><tr><th>Total</th>{COLS.map(([k]) => { const t = tot(k); return <td key={k} className="r"><Diff v={t.d} pending={t.waiting ? 'Some days are still waiting for data' : undefined} /><div className="pair"><span>S {money(t.s)}</span><span>A {t.waiting ? `${money(t.a)} so far` : money(t.a)}</span></div></td>; })}<td /></tr></tfoot>
    </table></div>
  );
}

function Cell({ f }: { f: Figure }) {
  if (f.semtek === 0 && (f.actual === null || f.actual === 0)) return <td className="r muted">–</td>;
  return (
    <td className="r" title={f.note}>
      <Diff v={f.diff} pending={f.note} />
      <div className="pair"><span>S {money(f.semtek)}</span><span>A {f.actual === null ? '–' : money(f.actual)}</span></div>
    </td>
  );
}

export default function ComparePage() {
  const [from, to, setRange, ready] = useDefaultRange(14);
  const [tab, setTab] = useState<'days' | 'bacs'>('days');
  const [pick, setPick] = useState<CompareGroup | null>(null);
  const { data, error, loading } = useLoad(async () => (ready ? loadCompare(from, to) : null), [from, to, ready]);
  const unmatched = data?.bacs.filter(m => !m.bank || !m.semtek).length ?? 0;

  const doExport = () => {
    if (!data) return;
    exportSheet(`Against Semtek ${from} to ${to}`, [
      ['From', 'To', ...COLS.flatMap(([, l]) => [`${l} Semtek`, `${l} actual`, `${l} difference`]), 'Missing'],
      ...data.groups.map(g => [g.from, g.to, ...COLS.flatMap(([k]) => [g[k].semtek, g[k].actual ?? '', g[k].diff ?? '']), g.missing.join(', ')]),
    ]);
  };

  return (
    <>
      <PageHead title="Against Semtek" sub="S = Semtek, A = actually received. Cash is the count less that day's float. Click a day for the detail.">
        {ready && <DateRange from={from} to={to} onChange={setRange} />}
        <button className="ghost" onClick={doExport} disabled={!data}>Export to Excel</button>
      </PageHead>
      <Tabs value={tab} onChange={setTab} items={[['days', 'By day'], ['bacs', `BACS line by line${unmatched ? ` (${unmatched} unmatched)` : ''}`]]} />
      {loading || !data ? (error ? <ErrorBox error={error} /> : <Loading />) : tab === 'days'
        ? <section className="card flush"><CompareTable groups={data.groups} onPick={setPick} /></section>
        : <BacsTable data={data.bacs} />}
      {pick && data && <DayDetail g={pick} cards={data.cardsByDay} bacs={data.bacs} onClose={() => setPick(null)} />}
    </>
  );
}

export function BacsTable({ data }: { data: Awaited<ReturnType<typeof loadCompare>>['bacs'] }) {
  if (!data.length) return <Empty>No BACS lines in this period.</Empty>;
  return (
    <section className="card flush"><div className="table-wrap"><table>
      <thead><tr><th>Bank report</th><th className="r">Amount</th><th /><th>Semtek</th><th className="r">Amount</th><th>Result</th></tr></thead>
      <tbody>{data.map((m, i) => (
        <tr key={i}>
          <td>{m.bank ? <><strong>{fmtShort(m.bank.txn_date)}</strong> {m.bank.label}</> : <span className="muted">–</span>}</td>
          <td className="r num">{m.bank ? money(m.bank.amount) : ''}</td>
          <td className="muted">↔</td>
          <td>{m.semtek ? <><strong>{fmtShort(m.semtek.txn_date)}</strong> {m.semtek.label}</> : <span className="muted">–</span>}</td>
          <td className="r num">{m.semtek ? money(m.semtek.amount) : ''}</td>
          <td>{m.bank && m.semtek ? <span className="chip ok">{m.dayGap ? `matched, ${Math.abs(m.dayGap)} day${Math.abs(m.dayGap) > 1 ? 's' : ''} apart` : 'matched'}</span>
            : m.bank ? <span className="chip short">not in Semtek</span> : <span className="chip over">not in BACS report</span>}</td>
        </tr>
      ))}</tbody>
    </table></div></section>
  );
}

function DayDetail({ g, cards, bacs, onClose }: { g: CompareGroup; cards: Map<string, Record<string, number>>; bacs: Awaited<ReturnType<typeof loadCompare>>['bacs']; onClose: () => void }) {
  const merch: Record<string, number> = {};
  for (const d of g.days) for (const [m, v] of Object.entries(cards.get(d) ?? {})) merch[m] = (merch[m] ?? 0) + v;
  const dayBacs = bacs.filter(m => { const d = (m.bank ?? m.semtek)!.txn_date; return d >= g.from && d <= g.to; });
  return (
    <Modal title={fmtRange(g.from, g.to)} onClose={onClose} wide>
      <div className="stack">
        <table className="mini wide">
          <thead><tr><th /><th className="r">Semtek</th><th className="r">Actual</th><th className="r">Difference</th><th>Note</th></tr></thead>
          <tbody>{COLS.map(([k, l]) => (
            <tr key={k}><th>{l}</th><td className="r num">{money(g[k].semtek)}</td><td className="r num">{g[k].actual === null ? '–' : money(g[k].actual)}</td><td className="r"><Diff v={g[k].diff} pending={g[k].note} /></td><td className="small muted">{g[k].note}</td></tr>
          ))}</tbody>
        </table>
        <div className="grid2">
          <div><h3>Cash</h3>
            <p className="small">Counted {money(g.countTotal)}{g.counts.length ? ` (count #${g.counts.join(', #')})` : ' – no count yet'}<br />
              Float {money(g.floatTotal)}{g.floats.length ? ` (float #${g.floats.join(', #')})` : ' – none recorded'}</p></div>
          <div><h3>Cards by provider</h3>
            {Object.keys(merch).length ? <table className="mini"><tbody>{Object.entries(merch).map(([m, v]) => <tr key={m}><th>{MERCHANT_LABEL[m]}</th><td className="r num">{money(v)}</td></tr>)}</tbody></table> : <p className="small muted">No card transactions.</p>}</div>
        </div>
        {g.missing.length > 0 && <p className="warn small">Not loaded yet for these dates: {g.missing.join(', ')}.</p>}
        {dayBacs.length > 0 && <><h3>BACS</h3><BacsTable data={dayBacs} /></>}
        <p className="small"><a href={`#records`} onClick={() => sessionStorage.setItem('records-range', JSON.stringify([g.from, g.to]))}>Open the Semtek lines for {g.from === g.to ? 'this day' : 'these days'} →</a></p>
      </div>
    </Modal>
  );
}
