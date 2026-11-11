// The nightly robot. Run by GitHub Actions (.github/workflows/nightly.yml):
//   npx tsx automation/run.ts [both|pull|report|semtek-discover|semtek-compare|paymentsense-test]
// Secrets (GitHub → Settings → Secrets and variables → Actions):
//   SUPABASE_SECRET_KEY   required – lets the robot write to the app
//   STRIPE_SHOP_KEY       Stripe Shop restricted key (read: charges, customers, balance)
//   STRIPE_OFFICE_KEY     Stripe Office restricted key
//   SMTP_USER, SMTP_PASS  the robot mailbox (IONOS) address and password (sends the email); SMTP_HOST to use another provider
//   REPORT_TO             where the morning report goes (several: separate with commas)
//   ZEROTIER_NETWORK_ID, ZEROTIER_IDENTITY    lets the run join the shop's ZeroTier network as the robot's own member (used by the workflow)
//   PAYMENTSENSE_EMAIL    the email you log in to myaccount.paymentsense.com with (its login emails are forwarded to SMTP_USER)
//   SEMTEK_SQL_HOST, SEMTEK_SQL_DB, SEMTEK_SQL_USER, SEMTEK_SQL_PASS   the Semtek SQL Server (read-only login)
import nodemailer from 'nodemailer';
import { supabase } from '../src/lib/supabase';
import { addDays } from '../src/lib/recon';
import { pullStripe, STRIPE_LABEL, type PullResult } from './stripe';
import { gatherReport, renderReport } from './report';
import { pullPaymentsense, paymentsenseConfigured } from './paymentsense';
import { discoverSemtek, compareSemtek, semtekConfigured, networkCheck, pullSemtek } from './semtek';

const env = process.env;
const what = (process.argv[2] || 'both').toLowerCase();
const londonToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
const yesterday = env.REPORT_DAY || addDays(londonToday(), -1);
const PULL_DAYS = 7; // re-read a week each night: catches a missed night and late refunds

async function main() {
  if (!env.SUPABASE_SECRET_KEY) throw new Error('The SUPABASE_SECRET_KEY secret is missing, so the robot can’t reach the app.');
  // a scheduled start when this morning's report has already gone out: nothing to do
  if (env.GITHUB_EVENT_NAME === 'schedule') {
    const done = await supabase.from('robot_runs').select('id').eq('what', 'both').eq('report_for', yesterday).not('emailed_to', 'is', null).limit(1);
    if (done.data?.length) { console.log(`Report for ${yesterday} already sent (run ${(done.data[0] as { id: number }).id}); nothing to do.`); return; }
  }
  const run = await supabase.from('robot_runs').insert({ what, report_for: yesterday }).select('id').single();
  if (run.error) throw new Error(`Can’t reach the app: ${run.error.message}`);
  const runId = (run.data as { id: number }).id;
  const steps: Record<string, unknown>[] = [];
  const log = async (s: Record<string, unknown>) => { steps.push(s); console.log(JSON.stringify(s)); await supabase.from('robot_runs').update({ steps }).eq('id', runId); };

  if (what === 'paymentsense-test') {
    let ok = true;
    if (!paymentsenseConfigured()) { await log({ step: 'paymentsense-test', ok: false, message: 'PAYMENTSENSE_EMAIL (or the robot mailbox SMTP_USER / SMTP_PASS) secret is missing.' }); ok = false; }
    else {
      try { await log({ step: 'paymentsense-test', ...(await pullPaymentsense(yesterday, true, log)) }); }
      catch (e) {
        ok = false;
        const err = e as { message?: string; stack?: string; cause?: unknown; name?: string };
        await log({ step: 'paymentsense-test', ok: false, message: err.message || String(e), name: err.name, stack: String(err.stack || '').slice(0, 2500), cause: err.cause ? String(err.cause).slice(0, 800) : undefined });
      }
    }
    await supabase.from('robot_runs').update({ finished_at: new Date().toISOString(), ok }).eq('id', runId);
    if (!ok) process.exitCode = 1;
    return;
  }

  if (what === 'semtek-discover' || what === 'semtek-compare') {
    if (!semtekConfigured()) throw new Error('The SEMTEK_SQL_HOST / SEMTEK_SQL_USER / SEMTEK_SQL_PASS secrets are missing.');
    if (env.ZEROTIER_OK !== 'true') {
      await log({ step: what, ok: false, message: 'Could not join the shop ZeroTier network. The network admin needs to approve the robot member (see the "Join ZeroTier" step in GitHub for its address).' });
      await supabase.from('robot_runs').update({ finished_at: new Date().toISOString(), ok: false }).eq('id', runId);
      process.exitCode = 1; return;
    }
    try {
      if (what === 'semtek-compare') {
        const c = await compareSemtek(env.COMPARE_FROM || '2026-10-01', env.REPORT_DAY || yesterday);
        await log({ step: 'semtek-compare', ok: true, ...c });
      } else {
        const d = await discoverSemtek();
        await log({ step: 'semtek-discover', ok: true, version: d.version, database: d.database, databases: d.databases, likely: d.likely, views: d.views, tables: d.tables });
      }
      await supabase.from('robot_runs').update({ finished_at: new Date().toISOString(), ok: true }).eq('id', runId);
    } catch (e) {
      await log({ step: what, ok: false, message: (e as Error).message, network: await networkCheck().catch(x => String(x)) });
      await supabase.from('robot_runs').update({ finished_at: new Date().toISOString(), ok: false }).eq('id', runId);
      process.exitCode = 1;
    }
    return;
  }

  const pulls: PullResult[] = [];
  if (what === 'both' || what === 'pull') {
    const from = addDays(yesterday, -(PULL_DAYS - 1));
    for (const [acct, key] of [['stripe_shop', env.STRIPE_SHOP_KEY], ['stripe_office', env.STRIPE_OFFICE_KEY]] as const) {
      let res: PullResult;
      try { res = await pullStripe(acct, key, from, yesterday); }
      catch (e) { res = { source: acct, label: STRIPE_LABEL[acct], ok: false, from, to: yesterday, added: 0, updated: 0, seen: 0, message: (e as Error).message }; }
      pulls.push(res); await log({ step: 'pull', ...res });
    }
    // Paymentsense, through its website (login link arrives in the robot mailbox)
    let ps: PullResult;
    if (!paymentsenseConfigured()) ps = { source: 'paymentsense', label: 'Paymentsense', ok: false, from: yesterday, to: yesterday, added: 0, updated: 0, seen: 0, message: 'Not set up yet (no PAYMENTSENSE_EMAIL).' };
    else {
      try { ps = await pullPaymentsense(yesterday); }
      catch (e) {
        ps = { source: 'paymentsense', label: 'Paymentsense', ok: false, from: yesterday, to: yesterday, added: 0, updated: 0, seen: 0, message: `Couldn’t download from Paymentsense: ${(e as Error).message.split('\n')[0]}` };
        await log({ step: 'ps-error', ok: false, message: String((e as Error).stack || (e as Error).message).slice(0, 2000) });
      }
    }
    pulls.push(ps); await log({ step: 'pull', ...ps });

    // Semtek, over the shop's ZeroTier network
    let sem: PullResult;
    const semBase = { source: 'semtek', label: 'Semtek', from: yesterday, to: yesterday, added: 0, updated: 0, seen: 0 };
    if (!semtekConfigured()) sem = { ...semBase, ok: false, message: 'Not set up yet (no Semtek database details).' };
    else if (env.ZEROTIER_OK !== 'true') sem = { ...semBase, ok: false, message: 'Couldn’t join the shop’s ZeroTier network, so Semtek wasn’t downloaded. Import it by hand or run again.' };
    else {
      try { sem = await pullSemtek(yesterday); }
      catch (e) { sem = { ...semBase, ok: false, message: `Couldn’t read Semtek: ${(e as Error).message}` }; await log({ step: 'semtek-network', network: await networkCheck().catch(x => String(x)) }); }
    }
    pulls.push(sem); await log({ step: 'pull', ...sem });
  }

  const ok = pulls.every(p => p.ok || p.message.startsWith('Not set up'));
  // The report and email must never abort the run: the data is already saved by this point.
  if (what === 'both' || what === 'report') {
    try {
      const rep = renderReport(await gatherReport(yesterday, pulls));
      let emailed: string | null = null;
      if (env.SMTP_USER && env.SMTP_PASS && env.REPORT_TO) {
        try { await sendReport(rep.subject, rep.html); emailed = env.REPORT_TO; await log({ step: 'email', ok: true, to: emailed, subject: rep.subject }); }
        catch (e) { await log({ step: 'email', ok: false, message: `Couldn’t send the email (${(e as Error).message}); the report is saved in the app.`, subject: rep.subject }); }
      } else {
        await log({ step: 'email', ok: false, message: 'Email not set up yet (SMTP_USER / SMTP_PASS / REPORT_TO). Report saved in the app only.', subject: rep.subject });
      }
      await supabase.from('robot_runs').update({ report_html: rep.html, emailed_to: emailed }).eq('id', runId);
    } catch (e) { await log({ step: 'report', ok: false, message: (e as Error).message }); }
  }
  await supabase.from('robot_runs').update({ finished_at: new Date().toISOString(), ok }).eq('id', runId);
  if (!ok) process.exitCode = 1;
}

/** Send the morning email, retrying a few times on a temporary (4xx) SMTP failure such as IONOS's "454". */
async function sendReport(subject: string, html: string) {
  const mail = nodemailer.createTransport({ host: env.SMTP_HOST || 'smtp.ionos.co.uk', port: Number(env.SMTP_PORT) || 465, secure: true, auth: { user: env.SMTP_USER!, pass: env.SMTP_PASS! } });
  let last: unknown;
  for (let i = 1; i <= 4; i++) {
    try { await mail.sendMail({ from: `Em H ledger <${env.SMTP_USER}>`, to: env.REPORT_TO!, subject, html }); return; }
    catch (e) { last = e; if (((e as { responseCode?: number }).responseCode ?? 0) >= 500) throw e; await new Promise(r => setTimeout(r, 15000 * i)); }
  }
  throw last;
}

main().catch(async e => {
  console.error(e);
  process.exitCode = 1;
});
