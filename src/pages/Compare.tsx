import { useEffect, useState } from 'react';
import { all, supabase } from '../lib/supabase';
import { loadCompare, latestSemtekDate, loadCategories, inCategoryOptions, type CompareData } from '../lib/data';
import { addDays, type DayRow, type Figure, type BacsMatch } from '../lib/recon';
import { fmtDate, fmtRange, fmtShort, money, today, MERCHANT_LABEL } from '../lib/format';
import { PageHead, DateRange, useLoad, Loading, ErrorBox, Modal, Empty, Tabs, EditDialog, type FieldDef } from '../components/ui';
import { exportSheet } from '../lib/exporter';
import { DataGrid } from '../components/DataGrid';
import { semtekCols, cardCols } from '../components/columns';
import { CONF } from './Records';
import { COINS, NOTES, VOUCH } from '../lib/denoms';

type Kind = 'cash' | 'cheque' | 'vouchers' | 'cards' | 'bacs';
const COLS: [Kind, string][] = [['cash', 'Cash (after float)'], ['cheque', 'Cheques'], ['vouchers', 'Vouchers'], ['cards', 'Cards'], ['bacs', 'BACS']];

export function useDefaultRange(days = 14): [string, string, (f: string, t: string) => void, boolean] {
  const [range, setRange] = useState<[string, string] | null>(null);
  useEffect(() => { latestSemtekDate().then(d => { const end = d ?? today(); setRange([addDays(end, -(days - 1)), end]); }).catch(() => setRange([addDays(today(), -(days - 1)), today()])); }, [days]);
  return [range?.[0] ?? '', range?.[1] ?? '', (f, t) => setRange([f, t]), !!range];
}

/** The status chip for one comparison figure. */
export function StatusChip({ f }: { f: Figure }) {
  switch (f.status) {
    case 'match': return <span className="chip ok">matches</span>;
    case 'ok': return <span className="chip ok" title={`Within the cash OK figure (${money(f.diff, { sign: true })})`}>OK {money(f.diff, { sign: true })}</span>;
    case 'diff': return <span className={`chip ${f.diff! > 0 ? 'over' : 'short'}`}>{money(f.diff, { sign: true })}</span>;
    case 'waiting': return <span className="chip pending" title={f.note}>waiting</span>;
    default: return null;
  }
}

function Cell({ f, rowSpan }: { f: Figure; rowSpan?: number }) {
  if (f.status === 'none') return <td className="r muted" rowSpan={rowSpan}>–</td>;
  return (
    <td className={`r ${rowSpan && rowSpan > 1 ? 'span-cell' : ''}`} rowSpan={rowSpan} title={f.note}>
      <StatusChip f={f} />
      <div className="pair"><span>S {money(f.semtek)}</span><span>A {f.actual === null ? '–' : money(f.actual)}</span></div>
      {f.status === 'waiting' && f.note && <div className="small muted wait-note">{f.note}</div>}
    </td>
  );
}

const fig = (d: DayRow, k: Kind): Figure | null => (k === 'cash' ? d.cash : d[k]);

export function CompareTable({ days, onPick }: { days: DayRow[]; onPick?: (d: DayRow) => void }) {
  const total = (k: Kind) => {
    const figs = days.map(d => fig(d, k)).filter((f): f is Figure => !!f);
    const s = figs.reduce((a, f) => a + f.semtek, 0);
    const waiting = figs.some(f => f.status === 'waiting');
    const a = figs.reduce((x, f) => x + (f.actual ?? 0), 0);
    return { s, a, waiting, diff: waiting ? null : a - s };
  };
  return (
    <div className="table-wrap"><table className="cmp">
      <thead><tr><th>Date</th>{COLS.map(([k, l]) => <th key={k} className="r">{l}</th>)}</tr></thead>
      <tbody>
        {days.map(d => {
          const quiet = COLS.every(([k]) => { const f = fig(d, k); return !f || f.status === 'none'; });
          return (
            <tr key={d.date} className={`${onPick ? 'click' : ''} ${quiet ? 'quiet' : ''}`} onClick={() => onPick?.(d)} tabIndex={onPick ? 0 : undefined}
              onKeyDown={e => { if (e.key === 'Enter') onPick?.(d); }}>
              <td className="nowrap"><strong>{fmtShort(d.date)}</strong>
                <div className="muted small">{new Date(d.date + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })}{!d.semtekLoaded ? ' · Semtek not loaded' : ''}</div></td>
              {d.cash && <Cell f={d.cash} rowSpan={d.cash.span} />}
              {COLS.slice(1).map(([k]) => <Cell key={k} f={d[k as Exclude<Kind, 'cash'>]} />)}
            </tr>
          );
        })}
      </tbody>
      <tfoot><tr><th>Total</th>{COLS.map(([k]) => {
        const t = total(k);
        return <td key={k} className="r">{t.diff === null ? <span className="chip pending">some waiting</span> : Math.abs(t.diff) < 0.005 ? <span className="chip ok">matches</span> : <span className={`chip ${t.diff > 0 ? 'over' : 'short'}`}>{money(t.diff, { sign: true })}</span>}
          <div className="pair"><span>S {money(t.s)}</span><span>A {money(t.a)}</span></div></td>;
      })}</tr></tfoot>
    </table></div>
  );
}

/** Pairs from line-by-line matching; by default only what does not pair up. */
export function MatchTable({ data, left, showMatched, onLeft, onRight, emptyText }: {
  data: BacsMatch[]; left: string; showMatched?: boolean; emptyText?: string;
  onLeft?: (id: string) => void; onRight?: (id: string) => void;
}) {
  const rows = showMatched ? data : data.filter(m => !m.bank || !m.semtek);
  if (!rows.length) return <Empty>{emptyText ?? 'Everything pairs up.'}</Empty>;
  return (
    <section className="card flush"><div className="table-wrap"><table>
      <thead><tr><th>{left}</th><th className="r">Amount</th><th /><th>Semtek</th><th className="r">Amount</th><th>Result</th></tr></thead>
      <tbody>{rows.map((m, i) => (
        <tr key={i}>
          <td className="wrap">{m.bank ? <><strong>{fmtShort(m.bank.txn_date)}</strong> {m.bank.label}{onLeft && <button className="ghost small" onClick={() => onLeft(m.bank!.id)}>Adjust</button>}</> : <span className="muted">–</span>}</td>
          <td className="r num">{m.bank ? money(m.bank.amount) : ''}</td>
          <td className="muted">↔</td>
          <td className="wrap">{m.semtek ? <><strong>{fmtShort(m.semtek.txn_date)}</strong> {m.semtek.label}{onRight && <button className="ghost small" onClick={() => onRight(m.semtek!.id)}>Adjust</button>}</> : <span className="muted">–</span>}</td>
          <td className="r num">{m.semtek ? money(m.semtek.amount) : ''}</td>
          <td>{m.bank && m.semtek ? <span className="chip ok">{m.dayGap ? `matched, ${Math.abs(m.dayGap)} day${Math.abs(m.dayGap) > 1 ? 's' : ''} apart` : 'matched'}</span>
            : m.bank ? <span className="chip short">not in Semtek</span> : <span className="chip over">not in {left}</span>}</td>
        </tr>
      ))}</tbody>
    </table></div></section>
  );
}
/** kept for the Reports page */
export const BacsTable = ({ data }: { data: BacsMatch[] }) => <MatchTable data={data} left="BACS report" showMatched />;

/** Edit a card transaction or a Semtek line from anywhere on this page. */
export function useLineEditor(onSaved: () => void) {
  const cats = useLoad(loadCategories, []);
  const [target, setTarget] = useState<{ table: 'card_txns' | 'semtek_lines'; row: Record<string, unknown> } | null>(null);
  const open = async (table: 'card_txns' | 'semtek_lines', id: string) => {
    const r = await all((a, b) => supabase.from(table).select('*').eq('id', id).range(a, b)) as Record<string, unknown>[];
    if (r[0]) setTarget({ table, row: r[0] });
  };
  const fields: FieldDef[] = !target ? [] : target.table === 'semtek_lines' ? CONF.semtek.fields
    : [...CONF.cards.fields, { key: 'category_id', label: 'Category', type: 'select', options: inCategoryOptions(cats.data, target.row.category_id) }, { key: 'against_pos', label: 'Should be in Semtek', type: 'bool' }];
  const dialog = target && <EditDialog table={target.table} row={target.row} fields={fields} title={target.table === 'semtek_lines' ? 'Adjust Semtek line' : 'Adjust card transaction'}
    onClose={() => setTarget(null)} onSaved={() => { setTarget(null); onSaved(); }} />;
  return { open, dialog };
}

export default function ComparePage() {
  const [from, to, setRange, ready] = useDefaultRange(14);
  const [tab, setTab] = useState<'days' | 'cards' | 'cheques' | 'bacs'>('days');
  const [showMatched, setShowMatched] = useState(false);
  const [pick, setPick] = useState<DayRow | null>(null);
  const { data, error, loading, reload } = useLoad(async () => (ready ? loadCompare(from, to) : null), [from, to, ready]);
  const editor = useLineEditor(reload);
  const open = (m: BacsMatch[]) => m.filter(x => !x.bank || !x.semtek).length;

  const doExport = () => {
    if (!data) return;
    exportSheet(`Against Semtek ${from} to ${to}`, [
      ['Date', ...COLS.flatMap(([, l]) => [`${l} Semtek`, `${l} actual`, `${l} difference`, `${l} status`])],
      ...data.days.map(d => [d.date, ...COLS.flatMap(([k]) => { const f = fig(d, k); return f ? [f.semtek, f.actual ?? '', f.diff ?? '', f.status] : ['(with ' + fmtShort(d.cashFrom) + ')', '', '', '']; })]),
    ]);
  };

  return (
    <>
      <PageHead title="Against Semtek" sub="S = Semtek, A = actually received. Cash is the count less the float, checked over the days each count covers. Click a day for the detail.">
        {ready && <DateRange from={from} to={to} onChange={setRange} />}
        <button className="ghost" onClick={reload} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
        <button className="ghost" onClick={doExport} disabled={!data}>Export to Excel</button>
      </PageHead>
      <Tabs value={tab} onChange={setTab} items={[['days', 'By day'],
        ['cards', `Cards line by line${data && open(data.cards) ? ` (${open(data.cards)})` : ''}`],
        ['cheques', `Cheques line by line${data && open(data.cheques) ? ` (${open(data.cheques)})` : ''}`],
        ['bacs', `BACS line by line${data && open(data.bacs) ? ` (${open(data.bacs)})` : ''}`]]} />
      {tab !== 'days' && <label className="check small"><input type="checkbox" checked={showMatched} onChange={e => setShowMatched(e.target.checked)} /> Show matched lines too</label>}
      {!data ? (error ? <ErrorBox error={error} /> : <Loading />)
        : tab === 'days' ? <section className="card flush"><CompareTable days={data.days} onPick={setPick} /></section>
        : tab === 'cards' ? <MatchTable data={data.cards} left="card files" showMatched={showMatched} emptyText="Every card payment pairs up with Semtek." onLeft={id => editor.open('card_txns', id)} onRight={id => editor.open('semtek_lines', id)} />
        : tab === 'cheques' ? <MatchTable data={data.cheques} left="cheques received" showMatched={showMatched} emptyText="Every cheque pairs up with Semtek." onRight={id => editor.open('semtek_lines', id)} />
        : <MatchTable data={data.bacs} left="BACS report" showMatched={showMatched} emptyText="Every BACS line pairs up with Semtek." onRight={id => editor.open('semtek_lines', id)} />}
      {pick && data && <DayDetail day={data.days.find(d => d.date === pick.date) ?? pick} data={data} onClose={() => setPick(null)} onChanged={reload} />}
      {editor.dialog}
    </>
  );
}

type SemLine = { id: string; txn_date: string; txn_at: string | null; type: string; last_name: string | null; account_no: string | null; cash: number; cheque: number; credit_card: number; vouchers: number; bacs: number; on_account: number; manual: boolean };

function DayDetail({ day, data, onClose, onChanged }: { day: DayRow; data: CompareData; onClose: () => void; onChanged: () => void }) {
  const cash = data.days.find(d => d.date === day.cashFrom)?.cash ?? null;
  const lines = useLoad(() => all((a, b) => supabase.from('semtek_lines').select('id,txn_date,txn_at,type,station,operator,last_name,account_no,cash,cheque,credit_card,vouchers,bacs,on_account,manual,created_at,updated_at')
    .eq('voided', false).gte('txn_date', day.cashFrom < day.date ? day.cashFrom : day.date).lte('txn_date', day.cashTo > day.date ? day.cashTo : day.date).order('txn_at').range(a, b)) as Promise<SemLine[]>, [day.date, day.cashFrom, day.cashTo]);
  const editor = useLineEditor(() => { onChanged(); lines.reload(); });
  const merch: Record<string, number> = data.cardsByDay.get(day.date) ?? {};
  const onDay = (m: BacsMatch) => (m.bank ?? m.semtek)!.txn_date === day.date;
  const cardOpen = data.cards.filter(m => onDay(m) && (!m.bank || !m.semtek));
  const chqOpen = data.cheques.filter(m => onDay(m) && (!m.bank || !m.semtek));
  const bacsOpen = data.bacs.filter(m => onDay(m) && (!m.bank || !m.semtek));
  const dayLines = (lines.data ?? []).filter(l => l.txn_date === day.date);
  const dayCards = [...data.cardRows.values()].filter(c => c.txn_date === day.date) as unknown as (Record<string, unknown> & { id: string })[];
  const cats = useLoad(loadCategories, []);
  const cashLines = (lines.data ?? []).filter(l => l.txn_date >= day.cashFrom && l.txn_date <= day.cashTo);
  // Semtek lines of exactly the difference: the likely cause of a cash or voucher difference
  const suspects = (f: Figure | null, key: 'cash' | 'vouchers', pool: SemLine[]) =>
    f && f.diff !== null && Math.abs(f.diff) >= 0.01 ? pool.filter(l => Math.abs(Math.abs(Number(l[key])) - Math.abs(f.diff!)) < 0.005) : [];
  const cashSus = suspects(cash, 'cash', cashLines);
  const vchSus = suspects(day.vouchers, 'vouchers', dayLines);
  const lineLabel = (l: SemLine) => `${String(l.txn_at ?? '').slice(11, 16)} ${l.type} · ${[l.last_name, l.account_no].filter(Boolean).join(', ') || 'no name'}`;

  return (
    <Modal title={fmtDate(day.date)} onClose={onClose} wide>
      <div className="stack">
        <table className="mini wide">
          <thead><tr><th /><th className="r">Semtek</th><th className="r">Actual</th><th className="r">Difference</th><th>Note</th></tr></thead>
          <tbody>{COLS.map(([k, l]) => {
            const f = k === 'cash' ? cash : day[k];
            if (!f) return null;
            return <tr key={k}><th>{l}{k === 'cash' && day.cashFrom !== day.cashTo ? <div className="small muted">{fmtRange(day.cashFrom, day.cashTo)}</div> : null}</th>
              <td className="r num">{money(f.semtek)}</td><td className="r num">{f.actual === null ? '–' : money(f.actual)}</td><td className="r"><StatusChip f={f} />{f.status === 'none' ? '–' : null}</td><td className="small muted">{f.note}</td></tr>;
          })}</tbody>
        </table>

        <div className="grid2">
          <div><h3>Cash{day.cashFrom !== day.cashTo ? ` (${fmtRange(day.cashFrom, day.cashTo)})` : ''}</h3>
            {cash ? <p className="small">Counted {money(cash.countTotal)}{cash.counts.length ? ` (count #${cash.counts.join(', #')})` : ' – no count yet'}<br />
              Float {money(cash.floatTotal)}{cash.floats.length ? ` (float #${cash.floats.join(', #')})` : ' – none recorded'}
              {cash.entries ? <><br />Cash entries {money(cash.entries)}</> : null}</p> : null}
            {cashSus.length > 0 && <Suspects title={`Semtek cash lines of exactly ${money(Math.abs(cash!.diff!))}`} lines={cashSus} label={lineLabel} field="cash" onEdit={id => editor.open('semtek_lines', id)} />}
          </div>
          <div><h3>Cards by provider</h3>
            {Object.keys(merch).length ? <table className="mini"><tbody>{Object.entries(merch).map(([m, v]) => <tr key={m}><th>{MERCHANT_LABEL[m]}</th><td className="r num">{money(v)}</td></tr>)}</tbody></table> : <p className="small muted">No card transactions.</p>}
          </div>
        </div>

        {vchSus.length > 0 && <Suspects title={`Semtek voucher lines of exactly ${money(Math.abs(day.vouchers.diff!))}`} lines={vchSus} label={lineLabel} field="vouchers" onEdit={id => editor.open('semtek_lines', id)} />}

        {cardOpen.length > 0 && <><h3>Card payments that don't pair up</h3>
          <MatchTable data={cardOpen} left="card files" onLeft={id => editor.open('card_txns', id)} onRight={id => editor.open('semtek_lines', id)} /></>}
        {chqOpen.length > 0 && <><h3>Cheques that don't pair up</h3><MatchTable data={chqOpen} left="cheques received" onRight={id => editor.open('semtek_lines', id)} /></>}
        {bacsOpen.length > 0 && <><h3>BACS that doesn't pair up</h3><MatchTable data={bacsOpen} left="BACS report" onRight={id => editor.open('semtek_lines', id)} /></>}

        <DayActuals day={day} onChanged={onChanged} />

        <h3>All Semtek transactions on {fmtShort(day.date)}</h3>
        {lines.loading ? <Loading /> : lines.error ? <ErrorBox error={lines.error} /> : (
          <DataGrid rows={dayLines as unknown as Record<string, unknown>[] as (Record<string, unknown> & { id: string })[]} rowKey={r => r.id}
            cols={semtekCols({ withDate: false })} empty="No Semtek lines on this day."
            actions={r => <button className="ghost small" onClick={() => editor.open('semtek_lines', r.id)}>Adjust</button>} />
        )}
        <h3>All card transactions on {fmtShort(day.date)}</h3>
        <DataGrid rows={dayCards} rowKey={r => r.id} cols={cardCols(cats.data, { withDate: false })} empty="No card transactions on this day."
          actions={r => <button className="ghost small" onClick={() => editor.open('card_txns', r.id)}>Adjust</button>} />
        {editor.dialog}
      </div>
    </Modal>
  );
}

function Suspects({ title, lines, label, field, onEdit }: { title: string; lines: SemLine[]; label: (l: SemLine) => string; field: 'cash' | 'vouchers'; onEdit: (id: string) => void }) {
  return (
    <div className="suspects">
      <div className="small"><strong>Possible cause:</strong> {title}</div>
      <ul>{lines.map(l => <li key={l.id} className="small">{fmtShort(l.txn_date)} {label(l)} · <span className="num">{money(Number(l[field]))}</span> <button className="ghost small" onClick={() => onEdit(l.id)}>Adjust</button></li>)}</ul>
    </div>
  );
}

type Row = Record<string, unknown> & { id: string };
type EditTarget = { table: string; row: Row; title: string; fields: FieldDef[] };

/** What was actually received: the cash count(s), floats and cash entries for the cash period, and the vouchers and cheques of the day. */
function DayActuals({ day, onChanged }: { day: DayRow; onChanged: () => void }) {
  const cats = useLoad(loadCategories, []);
  const data = useLoad(async () => {
    const [counts, floats, entries, lots, cheques] = await Promise.all([
      all((a, b) => supabase.from('counts').select('*').eq('voided', false).lte('date_from', day.cashTo).gte('date_to', day.cashFrom).order('date_from').range(a, b)),
      all((a, b) => supabase.from('floats').select('*').eq('voided', false).lte('date_from', day.cashTo).gte('date_to', day.cashFrom).order('date_from').range(a, b)),
      all((a, b) => supabase.from('entries').select('*').eq('voided', false).eq('direction', 'in').in('account', ['cash', 'voucher', 'cheque']).gte('entry_date', day.cashFrom).lte('entry_date', day.cashTo).range(a, b)),
      all((a, b) => supabase.from('voucher_lots').select('*, counts(ref), entries(ref)').eq('voided', false).eq('received_date', day.date).range(a, b)),
      all((a, b) => supabase.from('cheques').select('*').eq('voided', false).eq('received_date', day.date).is('bounce_of', null).range(a, b)),
    ]);
    return { counts, floats, entries, lots, cheques } as unknown as Record<'counts' | 'floats' | 'entries' | 'lots' | 'cheques', Row[]>;
  }, [day.date, day.cashFrom, day.cashTo]);
  const [edit, setEdit] = useState<EditTarget | null>(null);
  const catOpt = (r: Row) => ({ key: 'category_id', label: 'Category', type: 'select' as const, options: inCategoryOptions(cats.data, r.category_id) });
  const cat = (r: Row) => (cats.data ?? []).find(c => c.id === r.category_id)?.name ?? '';
  const period = day.cashFrom === day.cashTo ? fmtShort(day.cashFrom) : `${fmtShort(day.cashFrom)} – ${fmtShort(day.cashTo)}`;
  if (data.loading) return <Loading />;
  if (data.error || !data.data) return <ErrorBox error={data.error ?? ''} />;
  const d = data.data;
  const cashEntries = d.entries.filter(e => e.account === 'cash');
  const adjust = (t: EditTarget) => <button className="ghost small" onClick={() => setEdit(t)}>Adjust</button>;

  return (
    <>
      <h3>Cash counted for {period}</h3>
      <DataGrid rows={d.counts} rowKey={r => r.id} empty="No count entered for these days yet."
        cols={[
          { key: 'ref', label: 'Count', value: r => Number(r.ref), text: r => `#${r.ref}` },
          { key: 'days', label: 'Days', value: r => String(r.date_from), text: r => fmtRange(String(r.date_from), String(r.date_to)) },
          { key: 'coins', label: 'Coins', kind: 'money', value: r => Number(r.coins_total), total: true },
          { key: 'notes', label: 'Notes', kind: 'money', value: r => Number(r.notes_total), total: true },
          { key: 'cash', label: 'Cash', kind: 'money', value: r => Number(r.cash_total), total: true },
          { key: 'cat', label: 'Category', value: r => cat(r) + (r.against_pos === false ? ' (not in Semtek)' : '') },
          { key: 'note', label: 'Note', value: r => String(r.note ?? '') },
        ]}
        actions={r => adjust({ table: 'counts', row: r, title: `Adjust count #${r.ref}`, fields: [
          { key: 'date_from', label: 'Day', type: 'date' }, { key: 'date_to', label: 'To', type: 'date' },
          ...[...COINS, ...NOTES, ...VOUCH].map(([k, l]) => ({ key: k, label: `${k.startsWith('v') ? 'Voucher ' : ''}${l} (count)`, type: 'int' } as FieldDef)),
          catOpt(r), { key: 'against_pos', label: 'Cash should be in Semtek', type: 'bool' }, { key: 'note', label: 'Note', type: 'text' }] })} />

      <h3>Floats for {period}</h3>
      <DataGrid rows={d.floats} rowKey={r => r.id} empty="No float recorded for these days."
        cols={[
          { key: 'ref', label: 'Float', value: r => Number(r.ref), text: r => `#${r.ref}` },
          { key: 'covers', label: 'Covers', value: r => String(r.date_from), text: r => fmtRange(String(r.date_from), String(r.date_to)) },
          { key: 'prepared', label: 'Prepared', value: r => String(r.prepared_date), text: r => fmtShort(String(r.prepared_date)) },
          { key: 'amount', label: 'Amount', kind: 'money', value: r => Number(r.amount), total: true },
          { key: 'status', label: 'Status', value: r => (r.unused ? 'not used' : 'used') },
        ]}
        actions={r => adjust({ table: 'floats', row: r, title: `Adjust float #${r.ref}`, fields: [
          { key: 'date_from', label: 'For day', type: 'date' }, { key: 'date_to', label: 'Until', type: 'date' }, { key: 'amount', label: 'Amount £', type: 'number' },
          { key: 'prepared_date', label: 'Prepared on', type: 'date' }, { key: 'unused', label: 'Not used', type: 'bool' }, { key: 'note', label: 'Note', type: 'text' }] })} />

      {cashEntries.length > 0 && <>
        <h3>Cash entries for {period}</h3>
        <DataGrid rows={cashEntries} rowKey={r => r.id}
          cols={[
            { key: 'ref', label: 'Entry', value: r => Number(r.ref), text: r => `#${r.ref}` },
            { key: 'date', label: 'Date', kind: 'date', value: r => String(r.entry_date), text: r => fmtShort(String(r.entry_date)) },
            { key: 'cat', label: 'Category', value: r => cat(r) },
            { key: 'pos', label: 'In Semtek?', value: r => (r.against_pos ? 'yes' : 'separate') },
            { key: 'ref2', label: 'Reference', value: r => String(r.reference ?? '') },
            { key: 'amount', label: 'Amount', kind: 'money', value: r => Number(r.amount), total: true },
          ]}
          actions={r => adjust({ table: 'entries', row: r, title: `Adjust entry #${r.ref}`, fields: [
            { key: 'entry_date', label: 'Date', type: 'date' }, { key: 'amount', label: 'Amount £', type: 'number' },
            { key: 'category_id', label: 'Category', type: 'select', options: inCategoryOptions(cats.data, r.category_id) },
            { key: 'against_pos', label: 'Should be in Semtek', type: 'bool' }, { key: 'reference', label: 'Reference', type: 'text' }, { key: 'note', label: 'Note', type: 'text' }] })} />
      </>}

      <h3>Vouchers received on {fmtShort(day.date)}</h3>
      <DataGrid rows={d.lots} rowKey={r => r.id} empty="No vouchers received on this day."
        cols={[
          { key: 'from', label: 'From', value: r => (r.opening ? 'Opening balance' : (r.counts as { ref: number } | null) ? `Weekly count #${(r.counts as { ref: number }).ref}` : (r.entries as { ref: number } | null) ? `Entry #${(r.entries as { ref: number }).ref}` : '') },
          { key: 'cat', label: 'Category', value: r => cat(r) + (r.against_pos === false ? ' (not in Semtek)' : '') },
          { key: 'status', label: 'Status', value: r => (r.posting_id ? 'posted' : 'in office') },
          { key: 'amount', label: 'Amount', kind: 'money', value: r => Number(r.amount), total: true },
        ]}
        actions={r => adjust({ table: 'voucher_lots', row: r, title: 'Adjust vouchers', fields: [
          { key: 'received_date', label: 'Received on', type: 'date' }, { key: 'amount', label: 'Amount £', type: 'number' }, catOpt(r), { key: 'against_pos', label: 'Should be in Semtek', type: 'bool' }] })} />

      <h3>Cheques received on {fmtShort(day.date)}</h3>
      <DataGrid rows={d.cheques} rowKey={r => r.id} empty="No cheques received on this day."
        cols={[
          { key: 'payer', label: 'Name', value: r => String(r.payer ?? '') },
          { key: 'bank', label: 'Bank', value: r => String(r.bank ?? '') },
          { key: 'no', label: 'Cheque no.', value: r => String(r.cheque_no ?? '') },
          { key: 'cat', label: 'Category', value: r => cat(r) + (r.against_pos === false ? ' (not in Semtek)' : '') },
          { key: 'status', label: 'Status', value: r => (r.status === 'office' ? 'in office' : String(r.status)) },
          { key: 'amount', label: 'Amount', kind: 'money', value: r => Number(r.amount), total: true },
        ]}
        actions={r => adjust({ table: 'cheques', row: r, title: 'Adjust cheque', fields: [
          { key: 'received_date', label: 'Received', type: 'date' }, { key: 'payer', label: 'Name', type: 'text' }, { key: 'bank', label: 'Bank', type: 'text' },
          { key: 'cheque_no', label: 'Cheque no.', type: 'text' }, { key: 'amount', label: 'Amount £', type: 'number' }, catOpt(r), { key: 'against_pos', label: 'Should be in Semtek', type: 'bool' }] })} />

      {edit && <EditDialog table={edit.table} row={edit.row} title={edit.title} fields={edit.fields} onClose={() => setEdit(null)}
        onSaved={() => { setEdit(null); data.reload(); onChanged(); }} />}
    </>
  );
}
