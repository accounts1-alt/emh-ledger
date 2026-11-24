import { useState } from 'react';
import { supabase, q, rpc } from '../lib/supabase';
import { PageHead, useLoad, useToast, Loading, ErrorBox, Empty, Modal, ReasonDialog } from '../components/ui';
import { DataGrid } from '../components/DataGrid';

// The control tower. One place that owns the Semtek connection: see whether the
// till is reachable, turn the robot's access on / pause / stop, keep the register
// of apps that may use the gateway, and watch the command queue they feed it.

type Conn = { status: string; zerotier_member: string; zerotier_network: string; semtek_host: string; last_ok_at: string | null; last_checked_at: string | null; last_message: string | null };
type Control = { semtek_access: string; note: string | null; updated_at: string | null; updated_by: string | null };
type App = { id: string; name: string; api_key: string; enabled: boolean; notes: string | null; created_at: string; last_used_at: string | null };
type Cmd = { id: number; kind: string; status: string; params: unknown; result: unknown; requested_by: string | null; requested_at: string; processed_at: string | null; gateway_apps: { name: string } | null };

const when = (s: string | null | undefined) => s ? new Date(s).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const myEmail = async () => (await supabase.auth.getSession()).data.session?.user.email ?? 'portal';

const CONN_LOOK: Record<string, { dot: string; word: string }> = {
  ok: { dot: '#1a8f3c', word: 'Connected' }, error: { dot: '#c0392b', word: 'Can’t reach the till' },
  paused: { dot: '#c77800', word: 'Paused' }, stopped: { dot: '#c0392b', word: 'Stopped' }, unknown: { dot: '#999', word: 'Not checked yet' },
};
const ACCESS_LOOK: Record<string, string> = { on: 'Robot has access', paused: 'Paused — nothing read or written', stopped: 'Stopped — nothing read or written' };

export default function PortalPage() {
  const toast = useToast();
  const conn = useLoad(() => q<Conn>(supabase.from('gateway_connection').select('*').eq('id', 1).single()), []);
  const ctrl = useLoad(() => q<Control>(supabase.from('gateway_control').select('*').eq('id', 1).single()), []);
  const apps = useLoad(() => q<App[]>(supabase.from('gateway_apps').select('*').order('created_at')), []);
  const cmds = useLoad(async () => {
    const rows = await q<(Omit<Cmd, 'gateway_apps'> & { gateway_apps: { name: string } | { name: string }[] | null })[]>(supabase.from('gateway_commands').select('id, kind, status, params, result, requested_by, requested_at, processed_at, gateway_apps(name)').order('requested_at', { ascending: false }).limit(50));
    return rows.map(r => ({ ...r, gateway_apps: Array.isArray(r.gateway_apps) ? (r.gateway_apps[0] ?? null) : r.gateway_apps })) as Cmd[];
  }, []);

  const [adding, setAdding] = useState(false);
  const [revoking, setRevoking] = useState<App | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);

  const reloadAll = () => { conn.reload(); ctrl.reload(); apps.reload(); cmds.reload(); };

  const setAccess = async (access: string, note?: string) => {
    setBusy(true);
    try {
      await q(supabase.from('gateway_control').update({ semtek_access: access, ...(note !== undefined ? { note } : {}), updated_at: new Date().toISOString(), updated_by: await myEmail() }).eq('id', 1));
      toast(access === 'on' ? 'Access turned on.' : access === 'paused' ? 'Access paused.' : 'Access stopped.');
      ctrl.reload();
    } catch (e) { toast(String((e as Error).message)); } finally { setBusy(false); }
  };

  const runNow = async () => {
    setRunning(true);
    try { await rpc('gateway_run', { p_what: 'gateway' }); toast('Asked the gateway to run. Give it a minute, then refresh.'); }
    catch (e) { toast(String((e as Error).message)); } finally { setRunning(false); }
  };

  const toggleApp = async (a: App) => { try { await q(supabase.from('gateway_apps').update({ enabled: !a.enabled }).eq('id', a.id)); apps.reload(); } catch (e) { toast(String((e as Error).message)); } };

  const c = conn.data; const look = CONN_LOOK[c?.status ?? 'unknown'] ?? CONN_LOOK.unknown;
  const access = ctrl.data?.semtek_access ?? 'on';

  return (
    <>
      <PageHead title="Portal" sub="The control tower for everything that talks to Semtek. Only this gateway touches the till; every app asks it, and you decide here whether it may." />

      {/* Connection */}
      <section className="card">
        {conn.loading ? <Loading /> : conn.error ? <ErrorBox error={conn.error} /> : c && (
          <div className="stack">
            <div className="row wrap-row" style={{ alignItems: 'center', gap: 12 }}>
              <span style={{ width: 12, height: 12, borderRadius: '50%', background: look.dot, display: 'inline-block' }} aria-hidden="true" />
              <strong style={{ fontSize: '1.1rem' }}>{look.word}</strong>
              <span style={{ flex: 1 }} />
              <button className="ghost" disabled={running} onClick={runNow}>{running ? 'Starting…' : 'Run the gateway now'}</button>
              <button className="ghost" onClick={reloadAll}>Refresh</button>
            </div>
            <div className="grid2">
              <div><span className="muted small">Till</span><div>{c.semtek_host || '—'}</div></div>
              <div><span className="muted small">ZeroTier network</span><div>{c.zerotier_network || '—'}</div></div>
              <div><span className="muted small">Robot member</span><div><code>{c.zerotier_member || '—'}</code></div></div>
              <div><span className="muted small">Last connected</span><div>{when(c.last_ok_at)}</div></div>
              <div><span className="muted small">Last checked</span><div>{when(c.last_checked_at)}</div></div>
            </div>
            {c.last_message && <p className="small muted" style={{ margin: 0 }}>{c.last_message}</p>}
          </div>
        )}
      </section>

      {/* Control switch */}
      <section className="card">
        <h2>Robot’s access to the till</h2>
        {ctrl.loading ? <Loading /> : ctrl.error ? <ErrorBox error={ctrl.error} /> : ctrl.data && (
          <div className="stack">
            <p className="small muted" style={{ margin: 0 }}>{ACCESS_LOOK[access]}{ctrl.data.note ? ` — ${ctrl.data.note}` : ''}</p>
            <div className="row wrap-row">
              <button className={access === 'on' ? 'primary' : 'ghost'} disabled={busy || access === 'on'} onClick={() => setAccess('on', '')}>On</button>
              <button className={access === 'paused' ? 'primary' : 'ghost'} disabled={busy || access === 'paused'} onClick={() => setNoteOpen(true)}>Pause…</button>
              <button className={access === 'stopped' ? 'primary' : 'ghost'} disabled={busy || access === 'stopped'} onClick={() => setAccess('stopped')}>Stop</button>
            </div>
            <p className="small muted" style={{ margin: 0 }}>Last changed {when(ctrl.data.updated_at)}{ctrl.data.updated_by ? ` by ${ctrl.data.updated_by}` : ''}. Paused and Stopped both keep the robot off the till; use Pause when you mean to turn it back on.</p>
          </div>
        )}
      </section>

      {/* Apps registry */}
      <section className="card">
        <div className="row wrap-row" style={{ alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>Apps that may use the gateway</h2>
          <span style={{ flex: 1 }} />
          <button className="ghost" onClick={() => setAdding(true)}>+ Add an app</button>
        </div>
        {apps.loading ? <Loading /> : apps.error ? <ErrorBox error={apps.error} /> : !apps.data?.length ? <Empty>No apps yet. Add one to give it a key.</Empty> : (
          <div className="stack" style={{ marginTop: 10 }}>
            {apps.data.map(a => (
              <div key={a.id} className="row wrap-row" style={{ alignItems: 'center', borderTop: '1px solid var(--line, #eee)', paddingTop: 10 }}>
                <div style={{ minWidth: 180 }}>
                  <strong>{a.name}</strong>{!a.enabled && <span className="small" style={{ color: '#c0392b' }}> · off</span>}
                  {a.notes && <div className="small muted">{a.notes}</div>}
                  <div className="small muted">Last used {when(a.last_used_at)}</div>
                </div>
                <ApiKey value={a.api_key} />
                <span style={{ flex: 1 }} />
                <button className="ghost small" onClick={() => toggleApp(a)}>{a.enabled ? 'Switch off' : 'Switch on'}</button>
                <button className="ghost small" onClick={() => setRevoking(a)}>Revoke</button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Command queue */}
      <section className="card flush">
        <h2 style={{ padding: '0 14px' }}>Recent commands</h2>
        {cmds.loading ? <Loading /> : cmds.error ? <ErrorBox error={cmds.error} /> : !cmds.data?.length ? <Empty>No commands yet.</Empty> : (
          <DataGrid rows={cmds.data} rowKey={r => String(r.id)}
            cols={[
              { key: 'status', label: 'Status', value: (r: Cmd) => r.status, render: (r: Cmd) => <StatusPill s={r.status} /> },
              { key: 'kind', label: 'Command', value: (r: Cmd) => r.kind, render: (r: Cmd) => <code>{r.kind}</code> },
              { key: 'app', label: 'From app', value: (r: Cmd) => r.gateway_apps?.name ?? '—' },
              { key: 'requested_by', label: 'Asked by', value: (r: Cmd) => r.requested_by ?? '—' },
              { key: 'requested_at', label: 'Asked', kind: 'date', value: (r: Cmd) => r.requested_at, render: (r: Cmd) => <span className="small">{when(r.requested_at)}</span> },
              { key: 'processed_at', label: 'Done', kind: 'date', value: (r: Cmd) => r.processed_at, render: (r: Cmd) => <span className="small">{when(r.processed_at)}</span> },
              { key: 'result', label: 'Result', noFilter: true, value: () => '', render: (r: Cmd) => <ResultCell r={r} /> },
            ]} />
        )}
      </section>

      {adding && <AddApp onClose={() => setAdding(false)} onSaved={() => { setAdding(false); apps.reload(); }} />}
      {revoking && <ReasonDialog title={`Revoke “${revoking.name}”`} danger confirm="Revoke app" prompt="This deletes the app and its key. Anything still using the key will stop working. Its past commands stay in the log."
        onCancel={() => setRevoking(null)} onConfirm={async () => { try { await q(supabase.from('gateway_apps').delete().eq('id', revoking.id)); toast('App revoked.'); } catch (e) { toast(String((e as Error).message)); } setRevoking(null); apps.reload(); }} />}
      {noteOpen && <ReasonDialog title="Pause the robot’s access" confirm="Pause" prompt="The robot won’t read or write Semtek until you turn it back on. Say why (shown on the portal):"
        onCancel={() => setNoteOpen(false)} onConfirm={async reason => { setNoteOpen(false); await setAccess('paused', reason); }} />}
    </>
  );
}

function StatusPill({ s }: { s: string }) {
  const look: Record<string, string> = { done: '#1a8f3c', pending: '#c77800', failed: '#c0392b', blocked: '#c0392b' };
  return <span className="small" style={{ color: look[s] ?? '#666', fontWeight: 600 }}>{s}</span>;
}

function ResultCell({ r }: { r: Cmd }) {
  const res = r.result as Record<string, unknown> | null;
  if (!res) return <span className="muted small">—</span>;
  if (typeof res.message === 'string') return <span className="small">{res.message}</span>;
  if (res.payment_id) return <span className="small">Paid in £{Number(res.amount).toFixed(2)} → balance £{Number(res.after_balance).toFixed(2)}</span>;
  if (res.skipped) return <span className="small">Skipped: {String(res.reason)}</span>;
  return <span className="small muted">{JSON.stringify(res).slice(0, 80)}</span>;
}

function ApiKey({ value }: { value: string }) {
  const [show, setShow] = useState(false);
  const toast = useToast();
  return (
    <div className="small" style={{ minWidth: 220 }}>
      <span className="muted">Key </span>
      <code>{show ? value : '••••••••••••' + value.slice(-4)}</code>{' '}
      <button className="linkish" onClick={() => setShow(s => !s)}>{show ? 'hide' : 'show'}</button>{' '}
      <button className="linkish" onClick={async () => { try { await navigator.clipboard.writeText(value); toast('Key copied.'); } catch { toast('Couldn’t copy — show it and copy by hand.'); } }}>copy</button>
    </div>
  );
}

function AddApp({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(''); const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      if (!name.trim()) throw new Error('Give the app a name.');
      const api_key = 'gw_' + (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '');
      await q(supabase.from('gateway_apps').insert({ name: name.trim(), notes: notes.trim() || null, api_key, enabled: true }));
      toast('App added.'); onSaved();
    } catch (e) { setErr(String((e as Error).message)); setBusy(false); }
  };
  return (
    <Modal title="Add an app" onClose={onClose}>
      <div className="stack">
        <p className="small muted">The app gets its own key. It sends the key with every command, so you can switch off or revoke just that app without touching the others.</p>
        <label className="field"><span>Name</span><input id="ga-name" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Account payments app" /></label>
        <label className="field"><span>Notes</span><input id="ga-notes" value={notes} onChange={e => setNotes(e.target.value)} placeholder="What it’s for (optional)" /></label>
        {err && <ErrorBox error={err} />}
        <div className="row end"><button className="ghost" onClick={onClose}>Cancel</button><button className="primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Add app'}</button></div>
      </div>
    </Modal>
  );
}
