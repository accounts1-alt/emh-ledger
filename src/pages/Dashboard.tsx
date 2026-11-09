import { q, supabase } from '../lib/supabase';
import { loadCompare, loadCoverage, loadMovements, latestSemtekDate } from '../lib/data';
import { addDays, daysBetween } from '../lib/recon';
import { ACCOUNTS, ACCOUNT_LABEL, MERCHANT_LABEL, fmtDate, fmtShort, money, r2, today } from '../lib/format';
import { SOURCE_LABEL, type Source } from '../lib/parsers';
import { PageHead, useLoad, Loading, ErrorBox } from '../components/ui';
import { SemtekChanges } from '../components/SemtekChanges';

type Expected = { kind: string; since: string; merchant: string | null; gross: number; fee: number; net: number; items: number; ref: number | null };

export default function Dashboard() {
  const { data, error, loading } = useLoad(async () => {
    const end = (await latestSemtekDate()) ?? today();
    const [moves, expected, cmp, coverage, floats] = await Promise.all([
      loadMovements(today()),
      q(supabase.from('v_expected').select('*')) as Promise<Expected[]>,
      loadCompare(addDays(end, -27), end),
      loadCoverage(),
      q(supabase.from('v_float_status').select('ref,amount,date_from,date_to,status,dates_mismatch').eq('status', 'out')) as Promise<{ ref: number; amount: number; date_from: string; date_to: string; status: string; dates_mismatch: boolean }[]>,
    ]);
    const bal: Record<string, number> = Object.fromEntries(ACCOUNTS.map(a => [a, 0]));
    for (const m of moves) bal[m.account] = r2((bal[m.account] ?? 0) + m.amount);
    return { end, bal, expected, cmp, coverage, floats };
  }, []);
  if (loading) return <><PageHead title="Dashboard" /><Loading /></>;
  if (error || !data) return <><PageHead title="Dashboard" /><ErrorBox error={error ?? 'Could not load'} /></>;

  const { bal, expected, cmp, coverage, floats } = data;
  const exp = (k: string) => expected.filter(e => e.kind === k);
  const cardMerchants = [...new Set(exp('cards').map(e => e.merchant!))];
  const comingTotal = r2(expected.reduce((s, e) => s + Number(e.net), 0));
  const issues: { text: string; href: string }[] = [];
  for (const d of cmp.days) {
    const figs = ([['cash', d.cash], ['cheques', d.cheque], ['vouchers', d.vouchers], ['cards', d.cards], ['BACS', d.bacs]] as const).filter(([, f]) => f && f.status === 'diff');
    if (figs.length) issues.push({ text: `${d.cash && d.cash.span > 1 && figs.some(([k]) => k === 'cash') ? `${fmtShort(d.cashFrom)}–${fmtShort(d.cashTo)}` : fmtShort(d.date)}: ${figs.map(([k, f]) => `${k} ${money(f!.diff, { sign: true })}`).join(', ')}`, href: '#compare' });
  }
  const pendingCounts = cmp.days.filter(d => d.cash?.note === 'No count entered yet').length;
  if (pendingCounts) issues.push({ text: `${pendingCounts} day${pendingCounts > 1 ? 's' : ''} with Semtek cash but no count entered`, href: '#count' });
  const cardOpen = cmp.cards.filter(m => !m.bank || !m.semtek).length;
  if (cardOpen) issues.push({ text: `${cardOpen} card payment${cardOpen > 1 ? 's' : ''} that don't pair up with Semtek`, href: '#compare' });
  const unmatched = cmp.bacs.filter(m => !m.bank || !m.semtek).length;
  if (unmatched) issues.push({ text: `${unmatched} BACS line${unmatched > 1 ? 's' : ''} without a match`, href: '#compare' });
  for (const f of floats) if (f.date_to < addDays(today(), -7)) issues.push({ text: `Float #${f.ref} (${money(f.amount)}, ${fmtShort(f.date_from)}) not counted back`, href: '#floats' });
  for (const f of floats) if (f.dates_mismatch) issues.push({ text: `Float #${f.ref}: count dates don't line up with the float`, href: '#floats' });
  for (const e of expected) if (e.kind !== 'cards' && daysBetween(e.since, today()) > 14) issues.push({ text: `Posting #${e.ref} (${e.kind}, ${money(e.gross)}) posted ${fmtShort(e.since)} and still not banked`, href: '#banking' });
  const oldCards = exp('cards').filter(e => daysBetween(e.since, today()) > 10);
  if (oldCards.length) issues.push({ text: `${oldCards.length} card day${oldCards.length > 1 ? 's' : ''} older than 10 days not yet banked`, href: '#banking' });

  const last: Record<string, string | null> = {};
  for (const s of ['semtek', 'paymentsense', 'stripe_shop', 'stripe_office', 'bacs']) last[s] = coverage.filter(c => c.source === s).reduce<string | null>((m, c) => (!m || c.date_to > m ? c.date_to : m), null);

  return (
    <>
      <PageHead title="Dashboard" sub={`Balances as of ${fmtDate(today())}. Checks cover the 4 weeks to ${fmtDate(data.end)}.`} />
      <div className="dash">
        <section className="card">
          <h2>Where the money is</h2>
          <table className="ledger">
            {([['In the office', ['cash', 'cheques_office', 'vouchers_office']], ['At the shop', ['float']], ['On its way to the bank', ['cheques_posted', 'vouchers_posted', 'paymentsense', 'amex', 'stripe_shop', 'stripe_office']]] as [string, string[]][]).map(([grp, accts]) => (
              <tbody key={grp}>
                <tr className="grp"><th colSpan={2}>{grp}</th></tr>
                {accts.map(a => <tr key={a}><td>{ACCOUNT_LABEL[a]}</td><td className={`r num ${bal[a] < 0 ? 'bad' : ''}`}>{money(bal[a])}</td></tr>)}
              </tbody>
            ))}
            <tfoot><tr className="total"><th>Total outside the bank</th><td className="r num">{money(Object.values(bal).reduce((s, v) => s + v, 0))}</td></tr></tfoot>
          </table>
        </section>

        <section className="card">
          <h2>Coming into the bank <span className="muted">· {money(comingTotal)} after fees</span></h2>
          <table className="ledger"><tbody>
            {cardMerchants.map(m => { const rows = exp('cards').filter(e => e.merchant === m); return (
              <tr key={m}><td>{MERCHANT_LABEL[m]}<div className="muted small">{rows.length} day{rows.length > 1 ? 's' : ''} since {fmtShort(rows.reduce((a, r) => (r.since < a ? r.since : a), rows[0].since))}</div></td>
                <td className="r num">{money(rows.reduce((s, r) => s + Number(r.net), 0))}</td></tr>); })}
            {(['cheques', 'vouchers'] as const).map(k => { const rows = exp(k); return rows.length ? (
              <tr key={k}><td>{k === 'cheques' ? 'Cheques posted' : 'Vouchers posted'}<div className="muted small">{rows.length} posting{rows.length > 1 ? 's' : ''}{rows.some(r => Number(r.fee)) ? `, ${money(rows.reduce((s, r) => s + Number(r.fee), 0))} fees` : ''}</div></td>
                <td className="r num">{money(rows.reduce((s, r) => s + Number(r.net), 0))}</td></tr>) : null; })}
            {!expected.length && <tr><td className="muted" colSpan={2}>Nothing waiting. Everything posted or taken by card has been banked.</td></tr>}
          </tbody></table>
        </section>

        <SemtekChanges />

        <section className="card span2">
          <h2>Needs attention {issues.length ? <span className="chip short">{issues.length}</span> : <span className="chip ok">all clear</span>}</h2>
          {issues.length ? <ul className="issues">{issues.slice(0, 20).map((i, k) => <li key={k}><a href={i.href}>{i.text}</a></li>)}</ul>
            : <p className="muted">No differences against Semtek in the last 4 weeks, no unmatched BACS and nothing overdue.</p>}
          {issues.length > 20 && <p className="small muted">and {issues.length - 20} more on the Against Semtek page.</p>}
        </section>

        <section className="card span2">
          <h2>Data loaded up to</h2>
          <div className="coverage">
            {(Object.keys(last) as Source[]).map(s => {
              const stale = !last[s] || daysBetween(last[s]!, today()) > 8;
              return <a key={s} href="#import" className={`cov ${stale ? 'stale' : ''}`}><span>{SOURCE_LABEL[s].replace(' (incl. Amex)', '')}</span><strong>{last[s] ? fmtShort(last[s]!) : 'nothing yet'}</strong></a>;
            })}
          </div>
        </section>
      </div>
    </>
  );
}
