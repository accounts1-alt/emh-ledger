// The nightly robot. Run by GitHub Actions (.github/workflows/nightly.yml):
//   npx tsx automation/run.ts [both|pull|report|semtek-discover|semtek-compare|paymentsense-explore]
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
import { explorePaymentsense, paymentsenseConfigured } from './paymentsense';
import { discoverSemtek, compareSemtek, semtekConfigured, networkCheck, pullSemtek } from './semtek';

const env = process.env;
const what = (process.argv[2] || 'both').toLowerCase();
const londonToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
const yesterday = env.REPORT_DAY || addDays(londonToday(), -1);
const PULL_DAYS = 7; // re-read a week each night: catches a missed night and late refunds

async function main() {
  if (!env.SUPABASE_SECRET_KEY) throw new Error('The SUPABASE_SECRET_KEY secret is missing, so the robot can’t reach the app.');
  const run = await supabase.from('robot_runs').insert({ what, report_for: yesterday }).select('id').single();
  if (run.error) throw new Error(`Can’t reach the app: ${run.error.message}`);
  const runId = (run.data as { id: number }).id;
  const steps: Record<string, unknown>[] = [];
  const log = async (s: Record<string, unknown>) => { steps.push(s); console.log(JSON.stringify(s)); await supabase.from('robot_runs').update({ steps }).eq('id', runId); };

  if (what === 'paymentsense-explore') {
    let ok = true;
    if (!paymentsenseConfigured()) { await log({ step: 'ps-explore', ok: false, message: 'PAYMENTSENSE_EMAIL (or the robot mailbox SMTP_USER / SMTP_PASS) secret is missing.' }); ok = false; }
    else {
      try { await explorePaymentsense(log); }
      catch (e) { ok = false; await log({ step: 'ps-explore', ok: false, message: (e as Error).message.split('\n').slice(0, 6).join(' | ') }); }
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
  if (what === 'both' || what === 'report') {
    const rep = renderReport(await gatherReport(yesterday, pulls));
    let emailed: string | null = null;
    if (env.SMTP_USER && env.SMTP_PASS && env.REPORT_TO) {
      const mail = nodemailer.createTransport({ host: env.SMTP_HOST || 'smtp.ionos.co.uk', port: 465, secure: true, auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } });
      await mail.sendMail({ from: `Em H ledger <${env.SMTP_USER}>`, to: env.REPORT_TO, subject: rep.subject, html: rep.html });
      emailed = env.REPORT_TO;
      await log({ step: 'email', ok: true, to: emailed, subject: rep.subject });
    } else {
      await log({ step: 'email', ok: false, message: 'Email not set up yet (SMTP_USER / SMTP_PASS / REPORT_TO). Report saved in the app only.', subject: rep.subject });
    }
    await supabase.from('robot_runs').update({ report_html: rep.html, emailed_to: emailed }).eq('id', runId);
  }
  await supabase.from('robot_runs').update({ finished_at: new Date().toISOString(), ok }).eq('id', runId);
  if (!ok) process.exitCode = 1;
}

main().catch(async e => {
  console.error(e);
  process.exitCode = 1;
});
