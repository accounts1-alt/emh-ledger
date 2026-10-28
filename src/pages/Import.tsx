import { useState } from 'react';
import { all, q, supabase } from '../lib/supabase';
import { parseFile, sniffSource, dateRange, guessPeriod, SOURCE_LABEL, detectStripeAccount, type Source, type ParseResult } from '../lib/parsers';
import { loadSettings } from '../lib/data';
import { fmtRange, fmtStamp } from '../lib/format';
import { PageHead, useLoad, useToast, Loading, ErrorBox, Empty } from '../components/ui';

type Item = {
  key: string; file: File; buf: ArrayBuffer; source: Source | ''; sniffed: Source | null;
  parsed: ParseResult | null; error: string | null; stripeConflict: string | null; confirmConflict: boolean;
  status: 'ready' | 'importing' | 'done' | 'failed'; result?: string;
  periodFrom: string; periodTo: string; periodFromFile: boolean;
};
const SOURCES: Source[] = ['semtek', 'paymentsense', 'stripe_shop', 'stripe_office', 'bacs'];
const CONFLICT: Record<Source, string> = { semtek: 'sale_id', paymentsense: 'merchant,ext_id', stripe_shop: 'merchant,ext_id', stripe_office: 'merchant,ext_id', bacs: 'txn_date,description,amount,occurrence' };
const TABLE: Record<Source, string> = { semtek: 'semtek_lines', paymentsense: 'card_txns', stripe_shop: 'card_txns', stripe_office: 'card_txns', bacs: 'bacs_lines' };

type ImportRow = { id: string; source: string; filename: string; rows_in_file: number; rows_added: number; rows_duplicate: number; date_from: string | null; date_to: string | null; created_at: string };

export default function ImportPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [drag, setDrag] = useState(false);
  const toast = useToast();
  const hist = useLoad(() => q(supabase.from('import_files').select('*').order('created_at', { ascending: false }).limit(40)) as Promise<ImportRow[]>, []);
  const settings = useLoad(loadSettings, []);

  const parse = (it: Item, source: Source | ''): Item => {
    if (!source) return { ...it, source, parsed: null, error: null, stripeConflict: null };
    try {
      const parsed = parseFile(source, it.buf, it.file.name, settings.data?.amex_fee_pct ?? 1.9);
      let stripeConflict: string | null = null;
      if (source === 'stripe_shop' || source === 'stripe_office') {
        const acct = detectStripeAccount(it.buf);
        if (acct && acct !== source) stripeConflict = `This file's transaction IDs belong to ${SOURCE_LABEL[acct]}, not ${SOURCE_LABEL[source]}.`;
      }
      const guess = guessPeriod(source, it.buf, it.file.name);
      const [lo, hi] = dateRange(parsed.rows as { txn_date: string }[]);
      const periodFrom = guess?.[0] ?? lo ?? '', periodTo = guess?.[1] ?? hi ?? '';
      return { ...it, source, parsed, error: parsed.rows.length ? null : 'No usable lines found in this file.', stripeConflict, confirmConflict: false, periodFrom, periodTo, periodFromFile: !!guess };
    } catch (e) { return { ...it, source, parsed: null, error: String((e as Error).message), stripeConflict: null }; }
  };

  const addFiles = async (files: FileList | File[]) => {
    const list: Item[] = [];
    for (const file of Array.from(files)) {
      const buf = await file.arrayBuffer();
      const sniffed = sniffSource(buf, file.name);
      list.push(parse({ key: file.name + file.size + Math.random(), file, buf, source: '', sniffed, parsed: null, error: null, stripeConflict: null, confirmConflict: false, status: 'ready', periodFrom: '', periodTo: '', periodFromFile: false }, sniffed ?? ''));
    }
    setItems(i => [...i, ...list]);
  };
  const update = (key: string, fn: (it: Item) => Item) => setItems(i => i.map(x => (x.key === key ? fn(x) : x)));

  const run = async (it: Item) => {
    if (!it.parsed || !it.source) return;
    update(it.key, x => ({ ...x, status: 'importing' }));
    try {
      const src = it.source; const rows = it.parsed.rows as unknown as Record<string, unknown>[];
      const [lo, hi] = dateRange(rows as { txn_date: string }[]);
      // which lines are already in the app?
      let existing = new Set<string>();
      let keyOf: (r: Record<string, unknown>) => string;
      if (src === 'semtek') {
        keyOf = r => String(r.sale_id);
        const ex = await all((a, b) => supabase.from('semtek_lines').select('sale_id').gte('txn_date', lo!).lte('txn_date', hi!).range(a, b)) as { sale_id: string }[];
        existing = new Set(ex.map(e => e.sale_id));
      } else if (src === 'bacs') {
        keyOf = r => `${r.txn_date}|${r.description}|${Number(r.amount).toFixed(2)}|${r.occurrence}`;
        const ex = await all((a, b) => supabase.from('bacs_lines').select('txn_date,description,amount,occurrence').gte('txn_date', lo!).lte('txn_date', hi!).range(a, b)) as Record<string, unknown>[];
        existing = new Set(ex.map(keyOf));
      } else {
        keyOf = r => `${r.merchant}|${r.ext_id}`;
        const merchants = [...new Set(rows.map(r => String(r.merchant)))];
        const ex = await all((a, b) => supabase.from('card_txns').select('merchant,ext_id').in('merchant', merchants).gte('txn_date', lo!).lte('txn_date', hi!).range(a, b)) as Record<string, unknown>[];
        existing = new Set(ex.map(keyOf));
      }
      const fresh = rows.filter(r => !existing.has(keyOf(r)));
      const imp = await q(supabase.from('import_files').insert({
        source: src, filename: it.file.name, rows_in_file: rows.length, rows_added: fresh.length,
        rows_duplicate: rows.length - fresh.length,
        // the period the file covers (so days with no sales from a provider still count as loaded)
        date_from: it.periodFrom && it.periodFrom < lo! ? it.periodFrom : lo, date_to: it.periodTo && it.periodTo > hi! ? it.periodTo : hi,
      }).select('id').single()) as { id: string };
      for (let i = 0; i < fresh.length; i += 500) {
        const chunk = fresh.slice(i, i + 500).map(r => ({ ...r, import_id: imp.id }));
        await q(supabase.from(TABLE[src]).upsert(chunk, { onConflict: CONFLICT[src], ignoreDuplicates: true }));
      }
      const msg = `${fresh.length} new line${fresh.length === 1 ? '' : 's'} added${rows.length - fresh.length ? `, ${rows.length - fresh.length} already in the app` : ''}.`;
      update(it.key, x => ({ ...x, status: 'done', result: msg }));
      toast(`${SOURCE_LABEL[src]}: ${msg}`);
      hist.reload();
    } catch (e) {
      update(it.key, x => ({ ...x, status: 'failed', result: String((e as Error).message) }));
    }
  };
  const ready = items.filter(i => i.status === 'ready' && i.parsed && !i.error && (!i.stripeConflict || i.confirmConflict));

  return (
    <>
      <PageHead title="Import files" sub="Drop in Semtek, Paymentsense, Stripe and BACS files. Lines already in the app are skipped, so overlapping files are safe." />
      <label className={`drop ${drag ? 'over' : ''}`}
        onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files); }}>
        <input id="import-files" type="file" multiple accept=".xls,.xlsx,.csv" onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
        <strong>Drop files here</strong><span className="muted">or click to choose · .xls, .xlsx, .csv · several at once is fine</span>
      </label>

      {items.length > 0 && (
        <section className="card">
          <div className="table-wrap"><table>
            <thead><tr><th>File</th><th>Source</th><th>Lines</th><th>Covers the period</th><th>Result</th><th /></tr></thead>
            <tbody>
              {items.map(it => (
                <tr key={it.key}>
                  <td className="wrap">{it.file.name}</td>
                  <td>
                    <select id={`src-${it.key}`} value={it.source} disabled={it.status !== 'ready'} onChange={e => update(it.key, x => parse(x, e.target.value as Source))}>
                      <option value="">Choose…</option>
                      {SOURCES.map(s => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
                    </select>
                    {it.sniffed && it.source && it.sniffed !== it.source && <div className="warn small">Looks like {SOURCE_LABEL[it.sniffed]}</div>}
                  </td>
                  <td className="num">{it.parsed ? it.parsed.rows.length : '–'}{it.parsed?.skipped ? <span className="muted small"> ({it.parsed.skipped} skipped)</span> : null}</td>
                  <td>{it.parsed && it.parsed.rows.length ? (
                    <div className="period">
                      <input id={`pf-${it.key}`} type="date" value={it.periodFrom} disabled={it.status !== 'ready'} onChange={e => update(it.key, x => ({ ...x, periodFrom: e.target.value }))} aria-label="Covers from" />
                      <span>to</span>
                      <input id={`pt-${it.key}`} type="date" value={it.periodTo} disabled={it.status !== 'ready'} onChange={e => update(it.key, x => ({ ...x, periodTo: e.target.value }))} aria-label="Covers to" />
                      <div className="small muted">{it.periodFromFile ? 'Read from the file.' : 'First to last transaction. Change it if the file covers more days.'} Transactions: {fmtRange(...(dateRange(it.parsed.rows as { txn_date: string }[]) as [string, string]))}</div>
                    </div>) : '–'}</td>
                  <td className="wrap">
                    {it.error && <span className="bad">{it.error}</span>}
                    {it.stripeConflict && it.status === 'ready' && (
                      <label className="warn small check"><input type="checkbox" checked={it.confirmConflict} onChange={e => update(it.key, x => ({ ...x, confirmConflict: e.target.checked }))} /> {it.stripeConflict} Import anyway</label>
                    )}
                    {it.status === 'importing' && 'Importing…'}
                    {it.status === 'done' && <span className="good">{it.result}</span>}
                    {it.status === 'failed' && <span className="bad">{it.result}</span>}
                  </td>
                  <td className="nowrap">
                    {it.status === 'ready' && <button className="ghost small" onClick={() => setItems(i => i.filter(x => x.key !== it.key))}>Remove</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
          <div className="row end pad">
            {items.some(i => i.status !== 'ready') && <button className="ghost" onClick={() => setItems(i => i.filter(x => x.status === 'ready'))}>Clear finished</button>}
            <button className="primary" disabled={!ready.length} onClick={async () => { for (const it of ready) await run(it); }}>
              Import {ready.length || ''} file{ready.length === 1 ? '' : 's'}
            </button>
          </div>
        </section>
      )}

      <section className="card">
        <h2>Imported so far</h2>
        {hist.loading ? <Loading /> : hist.error ? <ErrorBox error={hist.error} /> : !hist.data?.length ? <Empty>Nothing imported yet. Start with a week of Semtek and the matching card files.</Empty> : (
          <div className="table-wrap"><table>
            <thead><tr><th>When</th><th>Source</th><th>File</th><th>Dates covered</th><th className="r">Added</th><th className="r">Already there</th></tr></thead>
            <tbody>{hist.data.map(h => (
              <tr key={h.id}><td className="nowrap">{fmtStamp(h.created_at)}</td><td>{SOURCE_LABEL[h.source as Source]}</td><td className="wrap">{h.filename}</td>
                <td>{h.date_from ? fmtRange(h.date_from, h.date_to!) : '–'}</td><td className="r num">{h.rows_added}</td><td className="r num">{h.rows_duplicate}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
    </>
  );
}
