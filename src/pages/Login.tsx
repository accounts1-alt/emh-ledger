import { useState } from 'react';
import { supabase } from '../lib/supabase';

export default function Login() {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState(''); const [pw, setPw] = useState('');
  const [msg, setMsg] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null); setMsg(null);
    if (mode === 'in') {
      const { error } = await supabase.auth.signInWithPassword({ email, password: pw });
      if (error) setErr(/confirm/i.test(error.message) ? 'Confirm your email first: open the link Supabase sent you, then sign in.' : 'Email or password not recognised.');
    } else {
      const { data, error } = await supabase.auth.signUp({ email, password: pw, options: { emailRedirectTo: location.origin } });
      if (error) setErr(error.message);
      else if (!data.session) setMsg('Login created. Open the confirmation email from Supabase, click the link, then come back and sign in.');
    }
    setBusy(false);
  };
  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="brand big"><span className="mark" aria-hidden="true">EH</span><div><strong>Em H Butchers</strong><span>Money ledger</span></div></div>
        <h1>{mode === 'in' ? 'Sign in' : 'Create your login'}</h1>
        <label className="field"><span>Email</span><input id="login-email" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required /></label>
        <label className="field"><span>Password</span><input id="login-pw" type="password" autoComplete={mode === 'in' ? 'current-password' : 'new-password'} minLength={8} value={pw} onChange={e => setPw(e.target.value)} required /></label>
        {err && <div className="errbox">{err}</div>}
        {msg && <div className="okbox">{msg}</div>}
        <button className="primary" disabled={busy}>{busy ? 'Please wait…' : mode === 'in' ? 'Sign in' : 'Create login'}</button>
        <button type="button" className="linkish" onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setErr(null); setMsg(null); }}>
          {mode === 'in' ? 'First time here? Create your login' : 'Already have a login? Sign in'}
        </button>
        <p className="small muted">Only the business account can see or change the data.</p>
      </form>
    </div>
  );
}
