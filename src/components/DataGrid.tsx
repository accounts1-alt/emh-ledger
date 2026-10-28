import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { money } from '../lib/format';

export type Col<T> = {
  key: string;
  label: string;
  /** the value used for sorting and filtering */
  value: (r: T) => string | number | null | undefined;
  /** how the value appears in the filter list (defaults to the value) */
  text?: (r: T) => string;
  /** how the cell is drawn (defaults to text) */
  render?: (r: T) => ReactNode;
  kind?: 'text' | 'number' | 'money' | 'date';
  /** add a total under this column (money columns) */
  total?: boolean;
  className?: string;
  noFilter?: boolean;
};

type Sort = { key: string; dir: 'asc' | 'desc' } | null;
const BLANK = '(Blanks)';

const display = <T,>(c: Col<T>, r: T): string => {
  if (c.text) return c.text(r) || BLANK;
  const v = c.value(r);
  if (v === null || v === undefined || v === '') return BLANK;
  if (c.kind === 'money') return money(Number(v));
  return String(v);
};

/**
 * A table where every column has an Excel-style filter: sort, search, and a tick-list of values.
 */
export function DataGrid<T>({ rows, cols, rowKey, actions, rowClass, empty, footerLabel, initialSort }: {
  rows: T[]; cols: Col<T>[]; rowKey: (r: T) => string;
  actions?: (r: T) => ReactNode; rowClass?: (r: T) => string;
  empty?: ReactNode; footerLabel?: (n: number) => ReactNode; initialSort?: Sort;
}) {
  const [filters, setFilters] = useState<Record<string, Set<string>>>({});
  const [sort, setSort] = useState<Sort>(initialSort ?? null);
  const [open, setOpen] = useState<{ key: string; anchor: HTMLElement } | null>(null);

  const filtered = useMemo(() => rows.filter(r => cols.every(c => { const f = filters[c.key]; return !f || f.has(display(c, r)); })), [rows, cols, filters]);
  const shown = useMemo(() => {
    if (!sort) return filtered;
    const c = cols.find(x => x.key === sort.key); if (!c) return filtered;
    const numeric = c.kind === 'number' || c.kind === 'money';
    return [...filtered].sort((a, b) => {
      const va = c.value(a), vb = c.value(b);
      const ea = va === null || va === undefined || va === '', eb = vb === null || vb === undefined || vb === '';
      if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1; // blanks last
      const cmp = numeric ? Number(va) - Number(vb) : String(va).localeCompare(String(vb), 'en-GB', { numeric: true, sensitivity: 'base' });
      return sort.dir === 'asc' ? cmp : -cmp;
    });
  }, [filtered, sort, cols]);

  const active = Object.keys(filters).length;
  const hasTotals = cols.some(c => c.total);
  const openCol = open ? cols.find(c => c.key === open.key) : null;

  return (
    <>
      {active > 0 && (
        <div className="grid-bar">
          <span className="small">Filtered: {shown.length} of {rows.length} lines</span>
          <button className="ghost small" onClick={() => setFilters({})}>Clear all filters</button>
        </div>
      )}
      <div className="table-wrap"><table className="grid">
        <thead><tr>
          {cols.map(c => {
            const isNum = c.kind === 'number' || c.kind === 'money';
            const filteredHere = !!filters[c.key];
            const sortedHere = sort?.key === c.key;
            return (
              <th key={c.key} className={`${isNum ? 'r' : ''} ${c.className ?? ''}`}>
                <div className={`th-in ${isNum ? 'num-head' : ''}`}>
                  <span>{c.label}</span>
                  {!c.noFilter && (
                    <button className={`fbtn ${filteredHere || sortedHere ? 'on' : ''}`} aria-label={`Filter and sort ${c.label}`} title="Filter and sort"
                      onClick={e => setOpen(open?.key === c.key ? null : { key: c.key, anchor: e.currentTarget })}>
                      {filteredHere ? '⏷' : sortedHere ? (sort!.dir === 'asc' ? '↑' : '↓') : '▾'}
                    </button>
                  )}
                </div>
              </th>
            );
          })}
          {actions && <th />}
        </tr></thead>
        <tbody>
          {shown.length ? shown.map(r => (
            <tr key={rowKey(r)} className={rowClass?.(r)}>
              {cols.map(c => {
                const isNum = c.kind === 'number' || c.kind === 'money';
                return <td key={c.key} className={`${isNum ? 'r num' : ''} ${c.className ?? ''}`}>{c.render ? c.render(r) : c.kind === 'money' ? money(Number(c.value(r) ?? 0), { blankZero: true }) : (c.text ? c.text(r) : String(c.value(r) ?? ''))}</td>;
              })}
              {actions && <td className="nowrap">{actions(r)}</td>}
            </tr>
          )) : <tr><td colSpan={cols.length + (actions ? 1 : 0)} className="muted pad">{rows.length ? 'No lines match the filters.' : (empty ?? 'Nothing here.')}</td></tr>}
        </tbody>
        {(hasTotals || footerLabel) && shown.length > 0 && (
          <tfoot><tr>
            {cols.map((c, i) => (
              <td key={c.key} className={c.total ? 'r num' : ''}>
                {c.total ? money(shown.reduce((s, r) => s + Number(c.value(r) ?? 0), 0)) : i === 0 ? (footerLabel ? footerLabel(shown.length) : `${shown.length} line${shown.length === 1 ? '' : 's'}`) : null}
              </td>
            ))}
            {actions && <td />}
          </tr></tfoot>
        )}
      </table></div>
      {open && openCol && (
        <FilterMenu col={openCol} cols={cols} rows={rows} otherFilters={filters} anchor={open.anchor} sort={sort}
          onSort={dir => { setSort({ key: openCol.key, dir }); setOpen(null); }}
          onApply={sel => { setFilters(f => { const n = { ...f }; if (sel) n[openCol.key] = sel; else delete n[openCol.key]; return n; }); setOpen(null); }}
          onClose={() => setOpen(null)} />
      )}
    </>
  );
}

function FilterMenu<T>({ col, cols, rows, otherFilters, anchor, sort, onSort, onApply, onClose }: {
  col: Col<T>; cols: Col<T>[]; rows: T[]; otherFilters: Record<string, Set<string>>; anchor: HTMLElement; sort: Sort;
  onSort: (dir: 'asc' | 'desc') => void; onApply: (sel: Set<string> | null) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [search, setSearch] = useState('');
  // values available given the OTHER columns' filters, like Excel
  const values = useMemo(() => {
    const counts = new Map<string, { n: number; v: string | number | null | undefined }>();
    for (const r of rows) {
      const okOthers = Object.entries(otherFilters).every(([k, set]) => { if (k === col.key) return true; const oc = cols.find(c => c.key === k); return !oc || set.has(display(oc, r)); });
      if (!okOthers) continue;
      const d = display(col, r);
      const cur = counts.get(d); counts.set(d, { n: (cur?.n ?? 0) + 1, v: col.value(r) });
    }
    const numeric = col.kind === 'number' || col.kind === 'money';
    return [...counts.entries()].sort((a, b) => {
      if (a[0] === BLANK) return 1; if (b[0] === BLANK) return -1;
      return numeric ? Number(a[1].v) - Number(b[1].v) : String(a[1].v ?? a[0]).localeCompare(String(b[1].v ?? b[0]), 'en-GB', { numeric: true });
    });
  }, [rows, col, cols, otherFilters]);
  const [sel, setSel] = useState<Set<string>>(() => new Set(otherFilters[col.key] ?? values.map(([d]) => d)));
  const s = search.trim().toLowerCase();
  const visible = values.filter(([d]) => !s || d.toLowerCase().includes(s));
  const allVisibleOn = visible.every(([d]) => sel.has(d));

  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect(); const w = 260;
    const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
    setPos({ top: r.bottom + 4, left });
  }, [anchor]);
  useEffect(() => {
    const away = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node) && e.target !== anchor) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const scroll = () => onClose();
    document.addEventListener('mousedown', away); window.addEventListener('keydown', key); window.addEventListener('resize', scroll);
    ref.current?.querySelector<HTMLInputElement>('input[type=search]')?.focus();
    return () => { document.removeEventListener('mousedown', away); window.removeEventListener('keydown', key); window.removeEventListener('resize', scroll); };
  }, [anchor, onClose]);

  const numeric = col.kind === 'number' || col.kind === 'money' || col.kind === 'date';
  const apply = () => {
    // when searching, Excel keeps only the ticked values that match the search
    const chosen = s ? new Set(visible.filter(([d]) => sel.has(d)).map(([d]) => d)) : sel;
    onApply(chosen.size === values.length ? null : chosen);
  };
  return createPortal(
    <div className="fmenu" ref={ref} style={{ top: pos.top, left: pos.left }} role="dialog" aria-label={`Filter ${col.label}`}>
      <button className={`fm-item ${sort?.key === col.key && sort.dir === 'asc' ? 'on' : ''}`} onClick={() => onSort('asc')}>{numeric ? 'Sort smallest to largest' : 'Sort A to Z'}</button>
      <button className={`fm-item ${sort?.key === col.key && sort.dir === 'desc' ? 'on' : ''}`} onClick={() => onSort('desc')}>{numeric ? 'Sort largest to smallest' : 'Sort Z to A'}</button>
      <button className="fm-item" disabled={!otherFilters[col.key]} onClick={() => onApply(null)}>Clear filter from “{col.label}”</button>
      <div className="fm-sep" />
      <input type="search" className="fm-search" placeholder="Search" value={search} onChange={e => setSearch(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') apply(); }} />
      <div className="fm-list">
        <label className="fm-row"><input type="checkbox" checked={allVisibleOn} onChange={() => setSel(cur => { const n = new Set(cur); for (const [d] of visible) { if (allVisibleOn) n.delete(d); else n.add(d); } return n; })} />
          <strong>{s ? '(Select all search results)' : '(Select all)'}</strong></label>
        {visible.map(([d, { n }]) => (
          <label key={d} className="fm-row"><input type="checkbox" checked={sel.has(d)} onChange={() => setSel(cur => { const x = new Set(cur); if (x.has(d)) x.delete(d); else x.add(d); return x; })} />
            <span className={col.kind === 'money' || col.kind === 'number' ? 'num' : ''}>{d}</span><span className="fm-n">{n}</span></label>
        ))}
        {!visible.length && <div className="small muted pad">No values match.</div>}
      </div>
      <div className="fm-foot"><button className="primary small" onClick={apply} disabled={s ? !visible.some(([d]) => sel.has(d)) : sel.size === 0}>OK</button><button className="ghost small" onClick={onClose}>Cancel</button></div>
    </div>,
    document.body,
  );
}
