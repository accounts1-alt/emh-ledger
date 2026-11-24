// The nightly robot. Run by GitHub Actions (.github/workflows/nightly.yml):
//   npx tsx automation/run.ts [both|pull|report|backup|semtek-discover|semtek-compare|paymentsense-test]
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
import { gzipSync } from 'node:zlib';
import { supabase } from '../src/lib/supabase';
import { addDays } from '../src/lib/recon';
import { pullStripe, STRIPE_LABEL, type PullResult } from './stripe';
import { gatherReport, renderReport } from './report';
import { pullPaymentsense, paymentsenseConfigured } from './paymentsense';
import { discoverSemtek, compareSemtek, semtekConfigured, networkCheck, pullSemtek, checkSemtekPerms, inspectPaymentWrite, writeKiplingPayment, writePayment, diagCard } from './semtek';

const env = process.env;
const what = (process.argv[2] || 'both').toLowerCase();
const londonToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
const yesterday = env.REPORT_DAY || addDays(londonToday(), -1);
const PULL_DAYS = 7; // re-read a week each night: catches a missed night and late refunds

type Log = (s: Record<string, unknown>) => Promise<void>;

// ---- The gateway (the one point that talks to Semtek) --------------------
// Every app that wants something from Semtek writes a row into gateway_commands.
// The worker is the only thing that touches Semtek, and it does three things
// here: obey the on/paused/stopped switch, drain the command queue, and keep
// the shop's connection status up to date so the portal can show it.

// The on/paused/stopped switch. 'on' means Semtek may be touched this run.
async function semtekAccess(): Promise<{ access: string; note: string | null }> {
  const r = await supabase.from('gateway_control').select('semtek_access, note').eq('id', 1).maybeSingle();
  const d = r.data as { semtek_access?: string; note?: string } | null;
  return { access: (d?.semtek_access || 'on').toLowerCase(), note: d?.note ?? null };
}

// Record what the connection looks like right now, for the portal to display.
async function setConnection(status: 'ok' | 'error' | 'paused' | 'stopped', message: string) {
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { status, last_message: message.slice(0, 500), last_checked_at: now };
  if (status === 'ok') patch.last_ok_at = now;
  await supabase.from('gateway_connection').update(patch).eq('id', 1);
}

// Run one queued command. Add a new `case` here for each new kind of job.
async function runCommand(kind: string, params: Record<string, unknown>) {
  switch (kind) {
    case 'write_payment': return await writePayment(params);
    case 'ping': return { ok: true, pong: true };
    default: throw new Error(`Unknown command kind: ${kind}`);
  }
}

// Drain pending commands from enabled apps. Returns a short tally for the report.
async function processCommands(log: Log): Promise<{ done: number; failed: number; blocked: number }> {
  const tally = { done: 0, failed: 0, blocked: 0 };
  const q = await supabase.from('gateway_commands')
    .select('id, app_id, kind, params, gateway_apps!inner(name, enabled)')
    .eq('status', 'pending').order('requested_at').limit(50);
  const rows = (q.data || []) as Array<{ id: number; app_id: string; kind: string; params: Record<string, unknown> | null; gateway_apps: { name: string; enabled: boolean } }>;
  for (const cmd of rows) {
    const app = cmd.gateway_apps;
    if (!app?.enabled) {
      tally.blocked++;
      await supabase.from('gateway_commands').update({ status: 'blocked', result: { message: `App “${app?.name ?? cmd.app_id}” is switched off in the portal.` }, processed_at: new Date().toISOString() }).eq('id', cmd.id).eq('status', 'pending');
      await log({ step: 'gateway-command', id: cmd.id, app: app?.name, kind: cmd.kind, ok: false, blocked: true });
      continue;
    }
    try {
      const result = await runCommand(cmd.kind, cmd.params || {});
      tally.done++;
      await supabase.from('gateway_commands').update({ status: 'done', result, processed_at: new Date().toISOString() }).eq('id', cmd.id).eq('status', 'pending');
      await supabase.from('gateway_apps').update({ last_used_at: new Date().toISOString() }).eq('id', cmd.app_id);
      await log({ step: 'gateway-command', id: cmd.id, app: app.name, kind: cmd.kind, ok: true, result });
    } catch (e) {
      tally.failed++;
      await supabase.from('gateway_commands').update({ status: 'failed', result: { message: (e as Error).message }, processed_at: new Date().toISOString() }).eq('id', cmd.id).eq('status', 'pending');
      await log({ step: 'gateway-command', id: cmd.id, app: app.name, kind: cmd.kind, ok: false, message: (e as Error).message });
    }
  }
  return tally;
}

async function main() {
  if (!env.SUPABASE_SECRET_KEY) throw new Error('The SUPABASE_SECRET_KEY secret is missing, so the robot can’t reach the app.');
  // a scheduled start when this morning's report has already gone out: nothing to do
  // An automatic start (GitHub's own timer, or the database timer poking us with auto=1) does nothing
  // if this morning's report has already gone out — so a backup poke can't send a second email.
  if (env.GITHUB_EVENT_NAME === 'schedule' || env.AUTO === '1') {
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

  if (what === 'gateway') {
    // Drain the portal's command queue (and nothing else). The portal pokes this
    // whenever an app leaves a command, so write-payment and the like happen promptly.
    let ok = true;
    const { access, note } = await semtekAccess();
    if (access !== 'on') {
      await setConnection(access === 'stopped' ? 'stopped' : 'paused', `Semtek access is ${access}${note ? ` — ${note}` : ''}. Commands left in the queue.`);
      await log({ step: 'gateway', ok: false, skipped: true, access, note });
    } else if (!semtekConfigured() || env.ZEROTIER_OK !== 'true') {
      await setConnection('error', 'Couldn’t reach the shop’s ZeroTier network. Commands left in the queue.');
      await log({ step: 'gateway', ok: false, message: 'No Semtek connection (is the PC off ZeroTier, or the robot member not yet authorised?).' });
      ok = false;
    } else {
      try {
        const tally = await processCommands(log);
        await setConnection('ok', `Gateway ran: ${tally.done} done, ${tally.failed} failed, ${tally.blocked} blocked.`);
        await log({ step: 'gateway', ok: true, ...tally });
      } catch (e) {
        ok = false;
        await setConnection('error', (e as Error).message);
        await log({ step: 'gateway', ok: false, message: (e as Error).message, network: await networkCheck().catch(x => String(x)) });
      }
    }
    await supabase.from('robot_runs').update({ finished_at: new Date().toISOString(), ok }).eq('id', runId);
    if (!ok) process.exitCode = 1;
    return;
  }

  if (what === 'semtek-diag-card') {
    let ok = true;
    if (!semtekConfigured() || env.ZEROTIER_OK !== 'true') { await log({ step: 'semtek-diag-card', ok: false, message: 'No Semtek connection (is your PC fully off ZeroTier?).' }); ok = false; }
    else {
      try { await log({ step: 'semtek-diag-card', ok: true, ...(await diagCard(10.58, '2026-11-20', '2026-11-20')) }); }
      catch (e) { ok = false; await log({ step: 'semtek-diag-card', ok: false, message: (e as Error).message, network: await networkCheck().catch(x => String(x)) }); }
    }
    await supabase.from('robot_runs').update({ finished_at: new Date().toISOString(), ok }).eq('id', runId);
    if (!ok) process.exitCode = 1;
    return;
  }

  if (what === 'semtek-write-payment') {
    let ok = true;
    if (!semtekConfigured()) { await log({ step: 'semtek-write-payment', ok: false, message: 'No Semtek database details set.' }); ok = false; }
    else if (env.ZEROTIER_OK !== 'true') { await log({ step: 'semtek-write-payment', ok: false, message: 'Couldn’t join the shop ZeroTier network (is your PC disconnected from Shop?). Nothing was written.' }); ok = false; }
    else {
      try { await log({ step: 'semtek-write-payment', ok: true, ...(await writeKiplingPayment()) }); }
      catch (e) { ok = false; await log({ step: 'semtek-write-payment', ok: false, message: (e as Error).message, network: await networkCheck().catch(x => String(x)) }); }
    }
    await supabase.from('robot_runs').update({ finished_at: new Date().toISOString(), ok }).eq('id', runId);
    if (!ok) process.exitCode = 1;
    return;
  }

  if (what === 'semtek-perms' || what === 'semtek-inspect-payment') {
    let ok = true;
    const step = what;
    if (!semtekConfigured()) { await log({ step, ok: false, message: 'No Semtek database details set.' }); ok = false; }
    else if (env.ZEROTIER_OK !== 'true') { await log({ step, ok: false, message: 'Couldn’t join the shop ZeroTier network (is your PC disconnected from Shop?).' }); ok = false; }
    else {
      try {
        if (what === 'semtek-perms') await log({ step, ok: true, ...(await checkSemtekPerms()) });
        else await log({ step, ok: true, ...(await inspectPaymentWrite(env.CUSTOMER_LIKE || '%Kipling%')) });
      }
      catch (e) { ok = false; await log({ step, ok: false, message: (e as Error).message, network: await networkCheck().catch(x => String(x)) }); }
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

    // Semtek, over the shop's ZeroTier network — but only through the gateway.
    // The portal's on/paused/stopped switch is obeyed here too: paused or stopped
    // means the robot leaves Semtek alone for the night.
    let sem: PullResult;
    const semBase = { source: 'semtek', label: 'Semtek', from: yesterday, to: yesterday, added: 0, updated: 0, seen: 0 };
    const { access, note } = await semtekAccess();
    if (!semtekConfigured()) sem = { ...semBase, ok: false, message: 'Not set up yet (no Semtek database details).' };
    else if (access !== 'on') {
      sem = { ...semBase, ok: false, message: `Semtek access is ${access} in the portal${note ? ` — ${note}` : ''}, so nothing was read or written.` };
      await setConnection(access === 'stopped' ? 'stopped' : 'paused', `Semtek access is ${access}${note ? ` — ${note}` : ''}.`);
    }
    else if (env.ZEROTIER_OK !== 'true') {
      sem = { ...semBase, ok: false, message: 'Couldn’t join the shop’s ZeroTier network, so Semtek wasn’t downloaded. Import it by hand or run again.' };
      await setConnection('error', 'Couldn’t join the shop’s ZeroTier network.');
    }
    else {
      try { sem = await pullSemtek(yesterday); await setConnection('ok', `Read Semtek for ${yesterday}: ${sem.added} added, ${sem.updated} updated.`); }
      catch (e) { sem = { ...semBase, ok: false, message: `Couldn’t read Semtek: ${(e as Error).message}` }; await setConnection('error', (e as Error).message); await log({ step: 'semtek-network', network: await networkCheck().catch(x => String(x)) }); }
    }
    pulls.push(sem); await log({ step: 'pull', ...sem });

    // While we're connected, drain the portal's command queue (write-payment, etc.).
    if (sem.ok) {
      try { const tally = await processCommands(log); await log({ step: 'gateway', ok: true, ...tally }); }
      catch (e) { await log({ step: 'gateway', ok: false, message: (e as Error).message }); }
    }

    // one-off: capture how Semtek holds the £10.58 of 20 Nov, the next time the till connects (then stop)
    if (sem.ok) {
      const flag = await supabase.from('settings').select('value').eq('key', 'diag_card').maybeSingle();
      const d = flag.data?.value as { amount: number; date: string } | null | undefined;
      if (d) {
        try { await log({ step: 'semtek-diag-card', ok: true, ...(await diagCard(d.amount, d.date, d.date)) }); } catch (e) { await log({ step: 'semtek-diag-card', ok: false, message: (e as Error).message }); }
        await supabase.from('settings').update({ value: null, change_reason: 'diagnostic captured' }).eq('key', 'diag_card');
      }
    }
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
  // Nightly backup of every table, emailed as a zipped attachment (never aborts the run).
  // Emailed backup switched OFF (16 Nov 2026, owner's request: no business data by email). Kept only for an explicit manual run.
  if (what === 'backup' && env.ALLOW_EMAIL_BACKUP === '1') {
    try { await log({ step: 'backup', ok: true, ...(await emailBackup()) }); }
    catch (e) { await log({ step: 'backup', ok: false, message: (e as Error).message }); }
  }
  await supabase.from('robot_runs').update({ finished_at: new Date().toISOString(), ok }).eq('id', runId);
  if (!ok) process.exitCode = 1;
}

/** Take a full copy of the database (ButcherPay + orders) and email it, zipped, to REPORT_TO. */
async function emailBackup() {
  if (!(env.SMTP_USER && env.SMTP_PASS && env.REPORT_TO)) throw new Error('Email not set up (SMTP_USER / SMTP_PASS / REPORT_TO).');
  const { data, error } = await supabase.rpc('backup_dump');
  if (error) throw new Error(`Couldn’t read the database: ${error.message}`);
  const json = JSON.stringify(data);
  const gz = gzipSync(Buffer.from(json));
  const tables = Object.entries((data as { tables: Record<string, unknown[]> }).tables).map(([k, v]) => `${k}: ${v.length}`);
  const day = londonToday();
  const mail = nodemailer.createTransport({ host: env.SMTP_HOST || 'smtp.ionos.co.uk', port: Number(env.SMTP_PORT) || 465, secure: true, auth: { user: env.SMTP_USER!, pass: env.SMTP_PASS! } });
  let last: unknown;
  for (let i = 1; i <= 4; i++) {
    try {
      await mail.sendMail({ from: `Em H backup <${env.SMTP_USER}>`, to: env.REPORT_TO!, subject: `Em H database backup – ${day}`,
        html: `<p>Nightly backup of the ButcherPay and Orders database, attached (<b>emh-backup-${day}.json.gz</b>, ${Math.round(gz.length / 1024)} KB).</p><p>Keep these emails – if anything is ever lost, send the latest one to Claude to restore it.</p><p style="color:#777;font-size:12px">${tables.join(' · ')}</p>`,
        attachments: [{ filename: `emh-backup-${day}.json.gz`, content: gz, contentType: 'application/gzip' }] });
      return { to: env.REPORT_TO, kb: Math.round(gz.length / 1024), tables: tables.length };
    } catch (e) { last = e; if (((e as { responseCode?: number }).responseCode ?? 0) >= 500) throw e; await new Promise(r => setTimeout(r, 15000 * i)); }
  }
  throw last;
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
