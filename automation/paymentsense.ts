// Paymentsense: logs in to myaccount.paymentsense.com with the emailed "Log in now" link.
// The login email is forwarded from your inbox to the robot mailbox (IONOS), which the robot reads over IMAP.
// Each night it downloads "Last week" and "This week" as CSV and adds what the app doesn't have yet.
import { chromium, type Page } from 'playwright-core';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { guessPeriod, parseFile, type CardRow } from '../src/lib/parsers';
import { all, q, supabase } from '../src/lib/supabase';
import type { PullResult } from './stripe';

const env = process.env;
export const PS_LOGIN_URL = 'https://myaccount.paymentsense.com/login';
export function paymentsenseConfigured() { return !!(env.PAYMENTSENSE_EMAIL && env.SMTP_USER && env.SMTP_PASS); }

/** Wait for a Paymentsense login email that arrived after `since` and return the "Log in now" link. */
export async function waitForLoginLink(since: Date, timeoutMs = 240000): Promise<{ link: string; subject: string; from: string }> {
  const client = new ImapFlow({ host: env.IMAP_HOST || 'imap.ionos.co.uk', port: 993, secure: true, auth: { user: env.SMTP_USER!, pass: env.SMTP_PASS! }, logger: false });
  await client.connect();
  try {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const uids = (await client.search({ since: new Date(since.getTime() - 24 * 3600 * 1000) }, { uid: true })) || [];
        for (const uid of [...uids].reverse()) {
          const msg = await client.fetchOne(String(uid), { source: true, internalDate: true, envelope: true }, { uid: true });
          if (!msg || !msg.source || (msg.internalDate && new Date(msg.internalDate) < new Date(since.getTime() - 60000))) continue;
          const mail = await simpleParser(msg.source);
          const text = `${mail.subject ?? ''} ${mail.from?.text ?? ''} ${mail.html || mail.text || ''}`;
          if (!/paymentsense/i.test(text)) continue;
          const hrefs = [...String(mail.html || mail.text || '').matchAll(/href=["']([^"']+)["']/gi)].map(m => m[1].replace(/&amp;/g, '&'));
          const link = hrefs.find(h => /paymentsense/i.test(h) && /(login|log-in|signin|auth|token|magic|verify)/i.test(h))
            ?? hrefs.find(h => /paymentsense/i.test(h) && !/(unsubscribe|privacy|apple|google|play\.|itunes)/i.test(h));
          if (link) {
            await client.messageMove(String(uid), 'Trash', { uid: true }).catch(() => undefined); // tidy up: the link only works once
            return { link, subject: mail.subject ?? '', from: mail.from?.text ?? '' };
          }
        }
      } finally { lock.release(); }
      await new Promise(r => setTimeout(r, 10000));
    }
    throw new Error('No Paymentsense login email reached the robot mailbox within 4 minutes. Check the forward rule in your inbox.');
  } finally { await client.logout().catch(() => undefined); }
}

/** What a page looks like, for working out the clicks: address, headings, buttons, links, inputs and a small screenshot. */
async function snapshot(page: Page, label: string) {
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => undefined);
  // passed as plain text: the code runner adds helpers to compiled functions that don't exist inside the browser
  const info = await page.evaluate(`(() => {
    const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const txt = e => (e.innerText || e.getAttribute('aria-label') || e.getAttribute('title') || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    const all = q => Array.from(document.querySelectorAll(q)).filter(vis);
    return {
      title: document.title,
      headings: all('h1,h2,h3').map(txt).filter(Boolean).slice(0, 30),
      buttons: all('button,[role=button],a.btn,input[type=submit]').map(e => txt(e) || e.value).filter(Boolean).slice(0, 60),
      links: all('a[href]').map(e => txt(e) + ' -> ' + e.getAttribute('href')).slice(0, 80),
      inputs: all('input,select').map(e => e.tagName.toLowerCase() + ' type=' + (e.getAttribute('type') || '') + ' name=' + (e.getAttribute('name') || '') + ' id=' + e.id + ' placeholder=' + (e.getAttribute('placeholder') || '') + ' aria=' + (e.getAttribute('aria-label') || '')).slice(0, 40),
      text: document.body.innerText.replace(/\\n{2,}/g, '\\n').slice(0, 2500),
    };
  })()`) as { title: string; headings: string[]; buttons: string[]; links: string[]; inputs: string[]; text: string };
  const shot = (await page.screenshot({ type: 'jpeg', quality: 45, fullPage: false })).toString('base64');
  return { label, url: page.url(), ...info, screenshot_jpeg_base64: shot };
}

type Log = (s: Record<string, unknown>) => Promise<void>;

/** Log in: type the email, wait for the forwarded "Log in now" email, open its link. */
async function login(page: Page, log?: Log) {
  await page.goto(PS_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const email = page.locator('input[type=email]').first();
  await email.fill(env.PAYMENTSENSE_EMAIL!, { timeout: 30000 });
  const since = new Date();
  await page.getByRole('button', { name: /next/i }).first().click({ timeout: 10000 }).catch(() => email.press('Enter'));
  await page.getByText(/head over to your inbox/i).first().waitFor({ timeout: 30000 }).catch(() => undefined);
  const { link } = await waitForLoginLink(since);
  await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForURL(/myaccount\.paymentsense\.com\/(home|transactions)/, { timeout: 60000 });
  if (log) await log({ step: 'ps', label: 'logged in' });
}

/** On the Transactions page: choose a date range (Today / Yesterday / This week / Last week / This month), apply, export CSV. */
async function exportRange(page: Page, choice: string): Promise<{ filename: string; buf: ArrayBuffer }> {
  await page.goto('https://myaccount.paymentsense.com/transactions', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  await closePopups(page);
  await page.locator('[aria-label="view filters menu" i]').first().click({ timeout: 15000 });
  await page.waitForTimeout(1500);
  await page.locator('mat-form-field').filter({ hasText: /date range/i }).first().click({ timeout: 15000 })
    .catch(() => page.getByText(/^\s*date range\s*$/i).first().click({ timeout: 10000 }));
  await page.waitForTimeout(1500);
  await page.getByText(new RegExp(`^\\s*${choice}\\s*$`, 'i')).last().click({ timeout: 10000 });
  await page.getByRole('button', { name: /^\s*done\s*$/i }).first().click({ timeout: 10000 }).catch(() => undefined);
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: /^\s*apply\s*$/i }).first().click({ timeout: 10000 });
  await page.waitForTimeout(6000);
  await closePopups(page);
  await page.locator('[aria-label="export transactions" i]').first().click({ timeout: 15000 });
  await page.waitForTimeout(1500);
  const dl = page.waitForEvent('download', { timeout: 90000 });
  await page.getByText(/csv export/i).first().click({ timeout: 10000 });
  const d = await dl;
  const path = await d.path();
  const b = (await import('node:fs')).readFileSync(path!);
  return { filename: d.suggestedFilename(), buf: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer };
}

export interface PsFile { choice: string; filename: string; lines: number; period: [string, string] | null; head: string[] }

/** Download "Last week" and "This week" as CSV. */
export async function downloadPaymentsense(log?: Log): Promise<{ files: (PsFile & { buf: ArrayBuffer })[] }> {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'en-GB', timezoneId: 'Europe/London', acceptDownloads: true });
    const page = await ctx.newPage();
    await login(page, log);
    const files: (PsFile & { buf: ArrayBuffer })[] = [];
    for (const choice of ['Last week', 'This week']) {
      const { filename, buf } = await exportRange(page, choice);
      const text = new TextDecoder().decode(buf);
      const lines = text.split(/\r?\n/).filter(Boolean);
      files.push({ choice, filename, buf, lines: lines.length - 1, period: guessPeriod('paymentsense', buf, filename), head: lines.slice(0, 2) });
    }
    return { files };
  } finally { await browser.close(); }
}

/** Nightly: download, then add card payments the app doesn't have yet (same checks as the Import page). `test` = read only. */
export async function pullPaymentsense(yesterday: string, test = false, log?: Log): Promise<PullResult & { files?: PsFile[]; by_day?: Record<string, unknown> }> {
  const base = { source: 'paymentsense', label: 'Paymentsense', added: 0, updated: 0, seen: 0 };
  const settings = await q(supabase.from('settings').select('key,value').eq('voided', false)) as { key: string; value: unknown }[];
  const amexPct = Number(settings.find(x => x.key === 'amex_fee_pct')?.value ?? 1.9);
  const { files } = await downloadPaymentsense(log);
  const all_: CardRow[] = []; const seenKey = new Set<string>();
  let from = yesterday;
  for (const f of files) {
    const parsed = parseFile('paymentsense', f.buf, f.filename, amexPct);
    for (const r of parsed.rows as CardRow[]) {
      const k = `${r.merchant}|${r.ext_id}`;
      if (seenKey.has(k) || r.txn_date > yesterday) continue; // today's come tomorrow
      seenKey.add(k); all_.push(r);
    }
    if (f.period && f.period[0] < from) from = f.period[0];
  }
  for (const r of all_) if (r.txn_date < from) from = r.txn_date;
  const existing = await all((a, b) => supabase.from('card_txns').select('merchant,ext_id').in('merchant', ['paymentsense', 'amex']).gte('txn_date', from).lte('txn_date', yesterday).range(a, b)) as { merchant: string; ext_id: string }[];
  const have = new Set(existing.map(e => `${e.merchant}|${e.ext_id}`));
  const fresh = all_.filter(r => !have.has(`${r.merchant}|${r.ext_id}`));
  const byDay: Record<string, { lines: number; total: number; new: number }> = {};
  for (const r of all_) { const d = (byDay[r.txn_date] ??= { lines: 0, total: 0, new: 0 }); d.lines++; d.total = Math.round((d.total + r.amount) * 100) / 100; }
  for (const r of fresh) byDay[r.txn_date].new++;
  const info = { files: files.map(({ buf: _b, ...f }) => f), by_day: byDay };
  if (test) return { ...base, ok: true, from, to: yesterday, seen: all_.length, added: 0, message: `Test only: ${all_.length} card payments read, ${fresh.length} would be added.`, ...info };

  const imp = await q(supabase.from('import_files').insert({
    source: 'paymentsense', filename: 'Nightly pull (Paymentsense)', rows_in_file: all_.length, rows_added: fresh.length, rows_duplicate: all_.length - fresh.length, date_from: from, date_to: yesterday,
  }).select('id').single()) as { id: string };
  for (let i = 0; i < fresh.length; i += 500)
    await q(supabase.from('card_txns').upsert(fresh.slice(i, i + 500).map(r => ({ ...r, import_id: imp.id })), { onConflict: 'merchant,ext_id', ignoreDuplicates: true }));
  return { ...base, ok: true, from, to: yesterday, seen: all_.length, added: fresh.length,
    message: `${fresh.length} new card payment${fresh.length === 1 ? '' : 's'}${all_.length - fresh.length ? `, ${all_.length - fresh.length} already in the app` : ''}.`, ...info };
}

/** Close any pop-up (Angular Material dialog / overlay) covering the page, recording what it said. */
export async function closePopups(page: Page, log?: (s: Record<string, unknown>) => Promise<void>) {
  for (let i = 0; i < 4; i++) {
    const backdrop = page.locator('.cdk-overlay-backdrop-showing');
    if (!(await backdrop.count())) return;
    const pane = page.locator('.cdk-overlay-pane').last();
    const said = await pane.innerText().catch(() => '');
    const buttons = await pane.locator('button, a').allInnerTexts().catch(() => [] as string[]);
    if (log) await log({ step: 'ps-explore', label: 'pop-up found', said: said.replace(/\s+/g, ' ').slice(0, 600), buttons });
    const close = pane.locator('button').filter({ hasText: /close|dismiss|ok|got it|no thanks|not now|continue|accept|×|✕/i }).first();
    if (await close.count()) await close.click({ timeout: 5000 }).catch(() => undefined);
    else { await page.keyboard.press('Escape'); await backdrop.first().click({ position: { x: 5, y: 5 }, timeout: 3000, force: true }).catch(() => undefined); }
    await page.waitForTimeout(1500);
  }
}
