import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, q, rpc, SUPABASE_URL, SUPABASE_KEY } from './lib/supabase';
import { useLoad, useToast, ToastHost, Loading, ErrorBox, Empty, Modal, when } from './lib/ui';

type Business = { id: string; name: string; slug: string; enabled: boolean };
type Conn = {
  id: string; business_id: string; label: string; zerotier_member: string | null; zerotier_network: string | null;
  semtek_host: string | null; semtek_db: string | null; creds_source: string; access: string; access_note: string | null;
  access_updated_at: string | null; access_updated_by: string | null; status: string; last_ok_at: string | null; last_checked_at: string | null; last_message: string | null;
};
type GwApp = { id: string; name: string; api_key: string; enabled: boolean; notes: string | null; created_at: string; last_used_at: string | null };
type Cmd = { id: number; kind: string; status: string; params: unknown; result: unknown; requested_by: string | null; requested_at: string; processed_at: string | null; gateway_apps: { name: string } | null };

const CONN_LOOK: Record<string, { dot: string; word: string }> = {
  ok: { dot: 'var(--ok)', word: 'Connected' }, error: { dot: 'var(--bad)', word: 'Can’t reach the till' },
  paused: { dot: 'var(--warn)', word: 'Paused' }, stopped: { dot: 'var(--bad)', word: 'Stopped' }, unknown: { dot: 'var(--muted)', word: 'Not checked yet' },
};
const myEmail = async () => (await supabase.auth.getSession()).data.session?.user.email ?? 'portal';

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [allowed, setAllowed] = useState<boolean | null>(null);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);
  useEffect(() => {
    if (!session) { setAllowed(null); return; }
    rpc<boolean>('is_allowed', {}).then(v => setAllowed(!!v)).catch(() => setAllowed(false));
  }, [session]);

  if (session === undefined) return <div className="boot">Loading…</div>;
  if (!session) return <ToastHost><Login /></ToastHost>;
  if (allowed === null) return <div className="boot">Loading…</div>;
  if (!allowed) return (
    <div className="login"><div className="login-card stack">
      <Brand />
      <h1>No access</h1>
      <p>You’re signed in as <strong>{session.user.email}</strong>, but that email hasn’t been given portal access.</p>
      <button className="ghost" onClick={() => supabase.auth.signOut()}>Sign out</button>
    </div></div>
  );
  return <ToastHost><Portal /></ToastHost>;
}

function Brand() {
  return <div className="brand"><span className="mark" aria-hidden="true">S</span><div><strong>Semtek Portal</strong><span>Gateway control tower</span></div></div>;
}

function Login() {
  const [email, setEmail] = useState(''); const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password: pw });
    if (error) { setErr(error.message); setBusy(false); }
  };
  return (
    <div className="login"><form className="login-card stack" onSubmit={submit}>
      <Brand />
      <h1>Sign in</h1>
      <label className="field"><span>Email</span><input type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" /></label>
      <label className="field"><span>Password</span><input type="password" value={pw} onChange={e => setPw(e.target.value)} autoComplete="current-password" /></label>
      {err && <ErrorBox error={err} />}
      <button className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
    </form></div>
  );
}

function Portal() {
  const toast = useToast();
  const businesses = useLoad(() => q<Business[]>(supabase.from('businesses').select('*').order('created_at')), []);
  const [bizId, setBizId] = useState<string | null>(null);
  const [addingBiz, setAddingBiz] = useState(false);
  useEffect(() => { if (!bizId && businesses.data?.length) setBizId(businesses.data[0].id); }, [businesses.data, bizId]);
  const biz = businesses.data?.find(b => b.id === bizId) ?? null;

  return (
    <>
      <header className="bar">
        <Brand />
        <span className="grow" />
        {businesses.data && businesses.data.length > 0 && (
          <select value={bizId ?? ''} onChange={e => setBizId(e.target.value)} style={{ width: 'auto' }}>
            {businesses.data.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        )}
        <button className="ghost small" onClick={() => setAddingBiz(true)}>+ Business</button>
        <button className="linkish small" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </header>
      <div className="wrap">
        {businesses.loading ? <Loading /> : businesses.error ? <ErrorBox error={businesses.error} /> :
          !businesses.data?.length ? <Empty>No businesses yet. Add one to connect its Semtek.</Empty> :
          biz ? <BusinessView key={biz.id} biz={biz} /> : <Loading />}
      </div>
      {addingBiz && <AddBusiness onClose={() => setAddingBiz(false)} onSaved={id => { setAddingBiz(false); businesses.reload(); setBizId(id); toast('Business added.'); }} />}
    </>
  );
}

function BusinessView({ biz }: { biz: Business }) {
  const toast = useToast();
  const conn = useLoad(() => q<Conn | null>(supabase.from('gateway_connections').select('*').eq('business_id', biz.id).order('created_at').limit(1).maybeSingle()), [biz.id]);
  const apps = useLoad(() => q<GwApp[]>(supabase.from('gateway_apps').select('*').eq('business_id', biz.id).order('created_at')), [biz.id]);
  const cmds = useLoad(async () => {
    const rows = await q<(Omit<Cmd, 'gateway_apps'> & { gateway_apps: { name: string } | { name: string }[] | null })[]>(supabase.from('gateway_commands').select('id, kind, status, params, result, requested_by, requested_at, processed_at, gateway_apps(name)').eq('business_id', biz.id).order('requested_at', { ascending: false }).limit(30));
    return rows.map(r => ({ ...r, gateway_apps: Array.isArray(r.gateway_apps) ? (r.gateway_apps[0] ?? null) : r.gateway_apps })) as Cmd[];
  }, [biz.id]);

  const [addApp, setAddApp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [minting, setMinting] = useState(false);

  const c = conn.data; const look = CONN_LOOK[c?.status ?? 'unknown'] ?? CONN_LOOK.unknown;
  const access = c?.access ?? 'on';

  const setAccess = async (next: string, note?: string) => {
    if (!c) return; setBusy(true);
    try {
      await q(supabase.from('gateway_connections').update({ access: next, ...(note !== undefined ? { access_note: note } : {}), access_updated_at: new Date().toISOString(), access_updated_by: await myEmail() }).eq('id', c.id));
      toast(next === 'on' ? 'Access on.' : next === 'paused' ? 'Paused.' : 'Stopped.'); conn.reload();
    } catch (e) { toast(String((e as Error).message)); } finally { setBusy(false); }
  };
  const runNow = async () => { setRunning(true); try { await rpc('gateway_run', { p_what: 'gateway' }); toast('Gateway asked to run — give it a minute, then Refresh.'); } catch (e) { toast(String((e as Error).message)); } finally { setRunning(false); } };
  const mint = async () => { if (!c) return; setMinting(true); try { await rpc('gateway_mint', { p_connection: c.id }); toast('Minting a robot ID — refresh in a minute to see it.'); } catch (e) { toast(String((e as Error).message)); } finally { setMinting(false); } };
  const toggleApp = async (a: GwApp) => { try { await q(supabase.from('gateway_apps').update({ enabled: !a.enabled }).eq('id', a.id)); apps.reload(); } catch (e) { toast(String((e as Error).message)); } };
  const revokeApp = async (a: GwApp) => { if (!confirm(`Revoke “${a.name}”? Its key stops working. Past commands stay in the log.`)) return; try { await q(supabase.from('gateway_apps').delete().eq('id', a.id)); apps.reload(); toast('App revoked.'); } catch (e) { toast(String((e as Error).message)); } };

  return (
    <>
      {/* Connection */}
      <section className="card">
        {conn.loading ? <Loading /> : conn.error ? <ErrorBox error={conn.error} /> : !c ? <Empty>No Semtek connection set up for {biz.name} yet.</Empty> : (
          <div className="stack">
            <div className="row wrap-row">
              <span className="dot" style={{ background: look.dot }} aria-hidden="true" />
              <strong style={{ fontSize: '1.1rem' }}>{look.word}</strong>
              <span className="grow" />
              <button className="ghost small" disabled={running} onClick={runNow}>{running ? 'Starting…' : 'Run gateway now'}</button>
              <button className="ghost small" onClick={() => { conn.reload(); apps.reload(); cmds.reload(); }}>Refresh</button>
            </div>
            <div className="grid2">
              <div><div className="small muted">Till</div><div>{c.semtek_host || '—'}{c.semtek_db ? ` · ${c.semtek_db}` : ''}</div></div>
              <div><div className="small muted">ZeroTier network</div><div><code>{c.zerotier_network || '—'}</code></div></div>
              <div><div className="small muted">Robot ID (ZeroTier member)</div><div>{c.zerotier_member ? <code>{c.zerotier_member}</code> : <button className="ghost small" disabled={minting} onClick={mint}>{minting ? 'Minting…' : 'Mint robot ID'}</button>}</div></div>
              <div><div className="small muted">Credentials</div><div>{c.creds_source === 'env' ? 'From the robot’s own secrets' : 'Stored in the hub vault'}</div></div>
              <div><div className="small muted">Last connected</div><div>{when(c.last_ok_at)}</div></div>
              <div><div className="small muted">Last checked</div><div>{when(c.last_checked_at)}</div></div>
            </div>
            {c.zerotier_member && <p className="small muted" style={{ margin: 0 }}>Hand this Robot ID to {biz.name}’s ZeroTier admin to authorise on network <code>{c.zerotier_network}</code>.</p>}
            {c.last_message && <p className="small muted" style={{ margin: 0 }}>{c.last_message}</p>}
          </div>
        )}
      </section>

      {/* Access switch */}
      {c && (
        <section className="card stack">
          <h2>Robot’s access to the till</h2>
          <div className="row wrap-row">
            <button className={access === 'on' ? 'primary' : 'ghost'} disabled={busy || access === 'on'} onClick={() => setAccess('on', '')}>On</button>
            <button className={access === 'paused' ? 'primary' : 'ghost'} disabled={busy || access === 'paused'} onClick={() => { const r = prompt('Why pause? (shown on the portal)') ?? ''; setAccess('paused', r); }}>Pause</button>
            <button className={access === 'stopped' ? 'primary' : 'ghost'} disabled={busy || access === 'stopped'} onClick={() => setAccess('stopped')}>Stop</button>
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            {access === 'on' ? 'The robot may read and write this till.' : `Nothing read or written${c.access_note ? ` — ${c.access_note}` : ''}.`}
            {c.access_updated_at ? ` Last changed ${when(c.access_updated_at)}${c.access_updated_by ? ` by ${c.access_updated_by}` : ''}.` : ''}
          </p>
        </section>
      )}

      {/* Apps */}
      <section className="card">
        <div className="row wrap-row"><h2 style={{ margin: 0 }}>Apps that may use the gateway</h2><span className="grow" /><button className="ghost small" onClick={() => setAddApp(true)}>+ Add an app</button></div>
        {apps.loading ? <Loading /> : apps.error ? <ErrorBox error={apps.error} /> : !apps.data?.length ? <Empty>No apps yet.</Empty> : (
          <div>{apps.data.map(a => (
            <div key={a.id} className="appline">
              <div style={{ minWidth: 160 }}><strong>{a.name}</strong>{!a.enabled && <span className="small tag-off"> · off</span>}{a.notes && <div className="small muted">{a.notes}</div>}<div className="small muted">Last used {when(a.last_used_at)}</div></div>
              <ApiKey value={a.api_key} />
              <span className="grow" />
              <button className="ghost small" onClick={() => toggleApp(a)}>{a.enabled ? 'Switch off' : 'Switch on'}</button>
              <button className="ghost small" onClick={() => revokeApp(a)}>Revoke</button>
            </div>
          ))}</div>
        )}
      </section>

      {/* Connect a new app */}
      {apps.data && apps.data.length > 0 && <ConnectSnippet biz={biz} app={apps.data[0]} />}

      {/* Command rail */}
      <section className="card">
        <h2>Recent commands</h2>
        {cmds.loading ? <Loading /> : cmds.error ? <ErrorBox error={cmds.error} /> : !cmds.data?.length ? <Empty>No commands yet.</Empty> : (
          <table className="grid"><thead><tr><th>Status</th><th>Command</th><th>App</th><th>Asked</th><th>Result</th></tr></thead>
            <tbody>{cmds.data.map(r => (
              <tr key={r.id}>
                <td><StatusPill s={r.status} /></td>
                <td><code>{r.kind}</code></td>
                <td className="small">{r.gateway_apps?.name ?? '—'}</td>
                <td className="small">{when(r.requested_at)}<div className="muted">{r.requested_by ?? ''}</div></td>
                <td className="small"><ResultCell r={r} /></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>

      {addApp && <AddApp bizId={biz.id} onClose={() => setAddApp(false)} onSaved={() => { setAddApp(false); apps.reload(); toast('App added.'); }} />}
    </>
  );
}

function StatusPill({ s }: { s: string }) {
  const col: Record<string, string> = { done: 'var(--ok)', pending: 'var(--warn)', failed: 'var(--bad)', blocked: 'var(--bad)' };
  return <span style={{ color: col[s] ?? 'var(--muted)', fontWeight: 600 }}>{s}</span>;
}
function ResultCell({ r }: { r: Cmd }) {
  const res = r.result as Record<string, unknown> | null;
  if (!res) return <span className="muted">—</span>;
  if (typeof res.message === 'string') return <>{res.message}</>;
  if (res.payment_id) return <>Paid in £{Number(res.amount).toFixed(2)} → balance £{Number(res.after_balance).toFixed(2)}</>;
  if (res.skipped) return <>Skipped: {String(res.reason)}</>;
  return <span className="muted">{JSON.stringify(res).slice(0, 80)}</span>;
}

function ApiKey({ value }: { value: string }) {
  const [show, setShow] = useState(false); const toast = useToast();
  return (
    <div className="small" style={{ minWidth: 210 }}>
      <span className="muted">Key </span><code>{show ? value : '••••••••' + value.slice(-4)}</code>{' '}
      <button className="linkish" onClick={() => setShow(s => !s)}>{show ? 'hide' : 'show'}</button>{' '}
      <button className="linkish" onClick={async () => { try { await navigator.clipboard.writeText(value); toast('Key copied.'); } catch { toast('Show it and copy by hand.'); } }}>copy</button>
    </div>
  );
}

function AddBusiness({ onClose, onSaved }: { onClose: () => void; onSaved: (id: string) => void }) {
  const [f, setF] = useState({ name: '', network: '', host: '', db: '', user: '', pass: '' });
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      if (!f.name.trim()) throw new Error('Give the business a name.');
      const id = await rpc<string>('gateway_add_business', {
        p_name: f.name.trim(), p_network: f.network.trim() || null, p_host: f.host.trim() || null,
        p_db: f.db.trim() || null, p_sql_user: f.user.trim() || null, p_sql_pass: f.pass || null,
      });
      onSaved(id);
    } catch (e) { setErr(String((e as Error).message)); setBusy(false); }
  };
  return (
    <Modal title="Add a business" onClose={onClose}>
      <div className="stack">
        <p className="small muted">Its Semtek login is stored encrypted in the hub vault — never shown again and never emailed. After adding, mint a robot ID and send it to their ZeroTier admin.</p>
        <label className="field"><span>Business name</span><input value={f.name} onChange={set('name')} placeholder="e.g. North Shop Butchers" /></label>
        <label className="field"><span>ZeroTier network ID</span><input value={f.network} onChange={set('network')} placeholder="their ZeroTier network" /></label>
        <div className="grid2">
          <label className="field"><span>Semtek host</span><input value={f.host} onChange={set('host')} placeholder="e.g. DATA-PC\SQLEXPRESS" /></label>
          <label className="field"><span>Database</span><input value={f.db} onChange={set('db')} placeholder="e.g. EMH_Butchers_POS" /></label>
          <label className="field"><span>SQL login</span><input value={f.user} onChange={set('user')} autoComplete="off" /></label>
          <label className="field"><span>SQL password</span><input type="password" value={f.pass} onChange={set('pass')} autoComplete="new-password" /></label>
        </div>
        {err && <ErrorBox error={err} />}
        <div className="row end"><button className="ghost" onClick={onClose}>Cancel</button><button className="primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Add business'}</button></div>
      </div>
    </Modal>
  );
}

function AddApp({ bizId, onClose, onSaved }: { bizId: string; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(''); const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      if (!name.trim()) throw new Error('Give the app a name.');
      const api_key = 'gw_' + (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '');
      await q(supabase.from('gateway_apps').insert({ business_id: bizId, name: name.trim(), notes: notes.trim() || null, api_key, enabled: true }));
      onSaved();
    } catch (e) { setErr(String((e as Error).message)); setBusy(false); }
  };
  return (
    <Modal title="Add an app" onClose={onClose}>
      <div className="stack">
        <p className="small muted">The app gets its own key. Switch it off or revoke it without touching the others.</p>
        <label className="field"><span>Name</span><input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Account payments app" /></label>
        <label className="field"><span>Notes</span><input value={notes} onChange={e => setNotes(e.target.value)} placeholder="What it’s for (optional)" /></label>
        {err && <ErrorBox error={err} />}
        <div className="row end"><button className="ghost" onClick={onClose}>Cancel</button><button className="primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Add app'}</button></div>
      </div>
    </Modal>
  );
}

function ConnectSnippet({ biz, app }: { biz: Business; app: GwApp }) {
  const toast = useToast();
  const fnUrl = `${SUPABASE_URL}/functions/v1/gw`;
  const code = `// Ask the gateway to post a payment into Semtek — no till or ZeroTier details needed.
const res = await fetch("${fnUrl}", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    api_key: "${app.api_key}",        // this app's key (keep it secret)
    kind: "write_payment",
    params: { customer_id: 511, cash: 1000, note: "On account" }
  })
});
const { command_id } = await res.json();   // watch this id for the result

// To read your own app's tables directly (read-only, your tables only):
// supabase = createClient("${SUPABASE_URL}", "${SUPABASE_KEY}")`;
  return (
    <section className="card stack">
      <div className="row wrap-row"><h2 style={{ margin: 0 }}>Connect a new app</h2><span className="grow" /><button className="linkish small" onClick={async () => { try { await navigator.clipboard.writeText(code); toast('Code copied.'); } catch { toast('Select and copy by hand.'); } }}>copy</button></div>
      <p className="small muted" style={{ margin: 0 }}>Any app you build for {biz.name} clips a ticket onto the gateway with its key. It never holds the Semtek login or the ZeroTier ID. Example (using the “{app.name}” key):</p>
      <pre className="snippet">{code}</pre>
    </section>
  );
}
