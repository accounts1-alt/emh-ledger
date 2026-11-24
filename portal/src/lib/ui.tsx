import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

// A tiny data loader: runs fn, tracks loading/error, and gives a reload().
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  const fnRef = useRef(fn); fnRef.current = fn;
  useEffect(() => {
    let live = true; setLoading(true); setError(null);
    fnRef.current().then(d => { if (live) setData(d); }).catch(e => { if (live) setError(String((e as Error).message)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  const reload = useCallback(() => setN(x => x + 1), []);
  return { data, error, loading, reload };
}

const ToastCtx = createContext<(m: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastHost({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const show = useCallback((m: string) => { setMsg(m); window.setTimeout(() => setMsg(null), 2600); }, []);
  return <ToastCtx.Provider value={show}>{children}{msg && <div className="toast">{msg}</div>}</ToastCtx.Provider>;
}

export const Loading = () => <div className="empty">Loading…</div>;
export const ErrorBox = ({ error }: { error: string }) => <div className="errbox">{error}</div>;
export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="modal" onMouseDown={e => e.stopPropagation()}>
        <div className="row" style={{ marginBottom: 12 }}><h2 style={{ margin: 0 }}>{title}</h2><span className="grow" /><button className="linkish" onClick={onClose}>close</button></div>
        {children}
      </div>
    </div>
  );
}

export const when = (s: string | null | undefined) => s ? new Date(s).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
