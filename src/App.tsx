import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, rpc } from './lib/supabase';
import { ToastHost } from './components/ui';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import ImportPage from './pages/Import';
import ComparePage from './pages/Compare';
import CountPage from './pages/Count';
import EntryPage from './pages/Entry';
import FloatsPage from './pages/Floats';
import PostingPage from './pages/Posting';
import BankingPage from './pages/Banking';
import FeesPage from './pages/Fees';
import ReportsPage from './pages/Reports';
import RecordsPage from './pages/Records';
import ChangesPage from './pages/Changes';
import SettingsPage from './pages/Settings';

const NAV: { group: string; items: [string, string][] }[] = [
  { group: '', items: [['dashboard', 'Dashboard']] },
  { group: 'Bring in', items: [['import', 'Import files'], ['count', 'Weekly count'], ['entry', 'Add entry'], ['floats', 'Floats']] },
  { group: 'Move money', items: [['posting', 'Posting'], ['banking', 'Banking'], ['fees', 'Fees']] },
  { group: 'Check', items: [['compare', 'Against Semtek'], ['reports', 'Reports'], ['records', 'Records'], ['changes', 'Change history']] },
  { group: '', items: [['settings', 'Settings']] },
];
const PAGES: Record<string, () => JSX.Element> = {
  dashboard: Dashboard, import: ImportPage, compare: ComparePage, count: CountPage, entry: EntryPage, floats: FloatsPage,
  posting: PostingPage, banking: BankingPage, fees: FeesPage, reports: ReportsPage, records: RecordsPage, changes: ChangesPage, settings: SettingsPage,
};
const route = () => { const h = location.hash.replace('#', ''); return PAGES[h] ? h : 'dashboard'; };

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [page, setPage] = useState(route());
  const [menuOpen, setMenuOpen] = useState(false);
  const [allowed, setAllowed] = useState<boolean | null>(null);
  useEffect(() => {
    if (!session) { setAllowed(null); return; }
    rpc<boolean>('is_allowed', {}).then(v => setAllowed(!!v)).catch(() => setAllowed(true));
  }, [session]);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    const onHash = () => { setPage(route()); setMenuOpen(false); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', onHash);
    return () => { data.subscription.unsubscribe(); window.removeEventListener('hashchange', onHash); };
  }, []);
  if (session === undefined) return <div className="boot">Loading…</div>;
  if (!session) return <ToastHost><Login /></ToastHost>;
  if (allowed === null) return <div className="boot">Loading…</div>;
  if (!allowed) return (
    <div className="login"><div className="login-card">
      <div className="brand big"><span className="mark" aria-hidden="true">EH</span><div><strong>Em H Butchers</strong><span>Money ledger</span></div></div>
      <h1>No access yet</h1>
      <p>You're signed in as <strong>{session.user.email}</strong>, but this email hasn't been given access to the ledger.</p>
      <p className="small muted">Ask someone who already uses the app to add you in Settings → Users, then sign in again.</p>
      <button className="ghost" onClick={() => supabase.auth.signOut()}>Sign out</button>
    </div></div>
  );
  const Page = PAGES[page];
  return (
    <ToastHost>
      <div className="shell">
        <aside className={`side ${menuOpen ? 'open' : ''}`}>
          <div className="brand">
            <span className="mark" aria-hidden="true">EH</span>
            <div><strong>Em H Butchers</strong><span>Money ledger</span></div>
            <button className="ghost menu-btn" onClick={() => setMenuOpen(o => !o)} aria-expanded={menuOpen} aria-label="Menu">☰</button>
          </div>
          <nav>
            {NAV.map((g, i) => (
              <div key={i} className="nav-group">
                {g.group && <div className="nav-label">{g.group}</div>}
                {g.items.map(([k, label]) => <a key={k} href={`#${k}`} className={page === k ? 'on' : ''}>{label}</a>)}
              </div>
            ))}
          </nav>
          <div className="side-foot">
            <span className="small muted">{session.user.email}</span>
            <button className="ghost small" onClick={() => supabase.auth.signOut()}>Sign out</button>
          </div>
        </aside>
        <main className="main"><Page key={page} /></main>
      </div>
    </ToastHost>
  );
}
