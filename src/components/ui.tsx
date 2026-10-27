import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { q, supabase } from '../lib/supabase';
import { fmtStamp, money } from '../lib/format';

// ---------- data loading ----------
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true; setLoading(true); setError(null);
    fn().then(d => { if (live) { setData(d); setLoading(false); } })
      .catch(e => { if (live) { setError(String(e.message ?? e)); setLoading(false); } });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, loading, reload: useCallback(() => setTick(t => t + 1), []) };
}

// ---------- toasts ----------
type Toast = { id: number; text: string; kind: 'ok' | 'err' };
const ToastCtx = createContext<(text: string, kind?: 'ok' | 'err') => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastHost({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: 'ok' | 'err' = 'ok') => {
    const id = Date.now() + Math.random();
    setItems(i => [...i, { id, text, kind }]);
    setTimeout(() => setItems(i => i.filter(t => t.id !== id)), kind === 'err' ? 8000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map(t => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------- layout bits ----------
export function PageHead({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-head">
      <div><h1>{title}</h1>{sub && <p className="sub">{sub}</p>}</div>
      {children && <div className="head-actions">{children}</div>}
    </header>
  );
}
export const Loading = () => <div className="muted pad">Loading…</div>;
export const ErrorBox = ({ error }: { error: string }) => <div className="errbox">{error}</div>;
export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;

export function Diff({ v, pending }: { v: number | null; pending?: string }) {
  if (v === null) return <span className="chip pending" title={pending}>{pending ? 'waiting' : '–'}</span>;
  const z = Math.abs(v) < 0.005;
  return <span className={`chip ${z ? 'ok' : v > 0 ? 'over' : 'short'}`}>{z ? 'matches' : money(v, { sign: true })}</span>;
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: [T, string][] }) {
  return (
    <div className="tabs" role="tablist">
      {items.map(([k, label]) => (
        <button key={k} role="tab" aria-selected={value === k} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>{label}</button>
      ))}
    </div>
  );
}

export function DateRange({ from, to, onChange }: { from: string; to: string; onChange: (f: string, t: string) => void }) {
  return (
    <div className="daterange">
      <label>From <input id="range-from" type="date" value={from} onChange={e => onChange(e.target.value, to < e.target.value ? e.target.value : to)} /></label>
      <label>To <input id="range-to" type="date" value={to} onChange={e => onChange(from > e.target.value ? e.target.value : from, e.target.value)} /></label>
    </div>
  );
}

// ---------- dialogs ----------
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    ref.current?.querySelector<HTMLElement>('input,select,textarea,button')?.focus();
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="modal-head"><h2>{title}</h2><button className="ghost" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/** Ask for a reason, then run the action with it. */
export function ReasonDialog({ title, prompt, confirm, danger, onCancel, onConfirm, extra }: {
  title: string; prompt: ReactNode; confirm: string; danger?: boolean; onCancel: () => void;
  onConfirm: (reason: string) => Promise<void>; extra?: ReactNode;
}) {
  const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  return (
    <Modal title={title} onClose={onCancel}>
      <div className="stack">
        <div>{prompt}</div>
        {extra}
        <label className="field"><span>Reason</span>
          <input id="reason-input" value={reason} onChange={e => setReason(e.target.value)} placeholder="Kept in the change history" />
        </label>
        {err && <ErrorBox error={err} />}
        <div className="row end">
          <button className="ghost" onClick={onCancel}>Cancel</button>
          <button className={danger ? 'danger' : 'primary'} disabled={!reason.trim() || busy}
            onClick={async () => { setBusy(true); setErr(null); try { await onConfirm(reason.trim()); } catch (e) { setErr(String((e as Error).message)); setBusy(false); } }}>
            {busy ? 'Saving…' : confirm}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export type FieldDef = { key: string; label: string; type: 'text' | 'number' | 'date' | 'int' | 'bool' | 'select'; options?: [string, string][] };

/** Edit any record: changed fields are saved with a reason; the old values go to the change history. */
export function EditDialog({ table, row, fields, title, onClose, onSaved }: {
  table: string; row: Record<string, unknown>; fields: FieldDef[]; title: string; onClose: () => void; onSaved: () => void;
}) {
  const [vals, setVals] = useState<Record<string, unknown>>(() => Object.fromEntries(fields.map(f => [f.key, row[f.key]])));
  const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const toast = useToast();
  const changed = fields.filter(f => String(vals[f.key] ?? '') !== String(row[f.key] ?? ''));
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const patch: Record<string, unknown> = { change_reason: reason.trim() };
      for (const f of changed) {
        const v = vals[f.key];
        patch[f.key] = f.type === 'number' ? (v === '' || v === null ? 0 : Number(v)) : f.type === 'int' ? Math.round(Number(v) || 0) : (v === '' ? null : v);
      }
      await q(supabase.from(table).update(patch).eq('id', row.id as string));
      toast('Saved. The old figures are kept in the change history.');
      onSaved();
    } catch (e) { setErr(String((e as Error).message)); setBusy(false); }
  };
  return (
    <Modal title={title} onClose={onClose}>
      <div className="stack">
        <div className="grid2">
          {fields.map(f => (
            <label key={f.key} className="field"><span>{f.label}</span>
              {f.type === 'bool'
                ? <select id={`edit-${f.key}`} value={vals[f.key] ? '1' : '0'} onChange={e => setVals(v => ({ ...v, [f.key]: e.target.value === '1' }))}><option value="1">Yes</option><option value="0">No</option></select>
                : f.type === 'select'
                  ? <select id={`edit-${f.key}`} value={String(vals[f.key] ?? '')} onChange={e => setVals(v => ({ ...v, [f.key]: e.target.value }))}>{f.options!.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                  : <input id={`edit-${f.key}`} type={f.type === 'date' ? 'date' : f.type === 'text' ? 'text' : 'number'} step={f.type === 'number' ? '0.01' : f.type === 'int' ? '1' : undefined}
                      value={String(vals[f.key] ?? '')} onChange={e => setVals(v => ({ ...v, [f.key]: e.target.value }))} />}
            </label>
          ))}
        </div>
        <label className="field"><span>Reason for the change</span>
          <input id="edit-reason" value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Semtek keyed £10 instead of £100" />
        </label>
        {err && <ErrorBox error={err} />}
        <div className="row end">
          <span className="muted small">{changed.length ? `${changed.length} field${changed.length > 1 ? 's' : ''} changed` : 'Nothing changed yet'}</span>
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!changed.length || !reason.trim() || busy} onClick={save}>{busy ? 'Saving…' : 'Save change'}</button>
        </div>
      </div>
    </Modal>
  );
}

type Audit = { id: number; action: string; reason: string; old_row: Record<string, unknown>; new_row: Record<string, unknown>; at: string };
const HIDE = new Set(['updated_at', 'created_at', 'change_reason', 'net', 'status', 'coins_total', 'notes_total', 'cash_total', 'vouchers_total']);
export function changedKeys(a: Record<string, unknown>, b: Record<string, unknown>) {
  return Object.keys(b).filter(k => !HIDE.has(k) && JSON.stringify(a?.[k]) !== JSON.stringify(b[k]));
}
export const showVal = (v: unknown) => v === null || v === undefined || v === '' ? '(blank)' : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v);

export function HistoryDialog({ table, id, title, onClose }: { table: string; id: string; title: string; onClose: () => void }) {
  const { data, error, loading } = useLoad(() => q(supabase.from('audit_log').select('*').eq('table_name', table).eq('row_id', id).order('at')) as Promise<Audit[]>, [table, id]);
  return (
    <Modal title={title} onClose={onClose} wide>
      {loading ? <Loading /> : error ? <ErrorBox error={error} /> : !data?.length ? <Empty>No changes. This record is as it was first saved.</Empty> : (
        <ol className="history">
          {data.map(a => (
            <li key={a.id}>
              <div className="h-meta"><strong>{a.action === 'void' ? 'Voided' : 'Changed'}</strong> · {fmtStamp(a.at)}</div>
              <div className="h-reason">“{a.reason}”</div>
              <table className="mini"><tbody>
                {changedKeys(a.old_row, a.new_row).map(k => (
                  <tr key={k}><th>{k.replace(/_/g, ' ')}</th><td className="old">{showVal(a.old_row[k])}</td><td>→</td><td>{showVal(a.new_row[k])}</td></tr>
                ))}
              </tbody></table>
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
}

/** Small marker shown on any record that has been changed since it was first saved. */
export function AdjustedMark({ row, onClick }: { row: { created_at?: string; updated_at?: string }; onClick: () => void }) {
  if (!row.updated_at || !row.created_at || Date.parse(row.updated_at) - Date.parse(row.created_at) < 2000) return null;
  return <button className="adj" onClick={onClick} title="Changed since first saved – see history">adjusted</button>;
}

export function Num({ v, blank }: { v: number | null | undefined; blank?: boolean }) {
  return <span className="num">{money(v ?? null, { blankZero: blank })}</span>;
}
