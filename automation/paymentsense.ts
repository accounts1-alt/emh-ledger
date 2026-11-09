// Paymentsense: logs in to myaccount.paymentsense.com with the emailed "Log in now" link.
// The login email is forwarded from your inbox to the robot mailbox (IONOS), which the robot reads over IMAP.
// Step 1 (now): "explore" logs in and records what the pages look like, so the download clicks can be written.
import { chromium, type Page } from 'playwright-core';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

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

/** Log in with the emailed link and record the first pages. */
export async function explorePaymentsense(log: (s: Record<string, unknown>) => Promise<void>) {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'en-GB', timezoneId: 'Europe/London' });
    const page = await ctx.newPage();
    await page.goto(PS_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await log({ step: 'ps-explore', ...(await snapshot(page, 'login page')) });

    const email = page.locator('input[type=email], input[name*=mail i], input[id*=mail i], input[autocomplete=username]').first();
    await email.fill(env.PAYMENTSENSE_EMAIL!, { timeout: 30000 });
    const since = new Date();
    const submit = page.locator('button[type=submit], button:has-text("Continue"), button:has-text("Log in"), button:has-text("Send")').first();
    if (await submit.count()) await submit.click(); else await email.press('Enter');
    await page.waitForTimeout(4000);
    await log({ step: 'ps-explore', ...(await snapshot(page, 'after asking for the login email')) });

    const { link, subject, from } = await waitForLoginLink(since);
    await log({ step: 'ps-explore', label: 'login email found', subject, from, link_host: new URL(link).host });
    await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6000);
    await log({ step: 'ps-explore', ...(await snapshot(page, 'after opening the login link')) });

    await page.goto('https://myaccount.paymentsense.com/transactions', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6000);
    await page.getByRole('button', { name: /dismiss/i }).first().click({ timeout: 3000 }).catch(() => undefined);
    await log({ step: 'ps-explore', ...(await snapshot(page, 'transactions page')) });
    // how the two icon buttons are built, so they can be found reliably
    const icons = await page.evaluate(`Array.from(document.querySelectorAll('[aria-label],[mattooltip],[title]')).map(e => e.tagName.toLowerCase() + ' aria=' + (e.getAttribute('aria-label') || '') + ' tip=' + (e.getAttribute('mattooltip') || e.getAttribute('title') || '') + ' class=' + (e.getAttribute('class') || '').slice(0, 60)).slice(0, 40)`);
    await log({ step: 'ps-explore', label: 'labelled elements', icons });
    await closePopups(page, log);

    // the filters menu: date range
    await page.locator('[aria-label="view filters menu" i]').first().click({ timeout: 15000 });
    await page.waitForTimeout(2000);
    const field = page.locator('mat-form-field').filter({ hasText: /date range/i }).first();
    const dateSel = (await field.count()) ? field.locator('mat-select, [role=combobox], [role=button]').first() : page.getByText(/^\s*today\s*$/i).first();
    await dateSel.click({ timeout: 15000 });
    await page.waitForTimeout(1500);
    const options = await page.locator('mat-option, [role=option]').allInnerTexts();
    await log({ step: 'ps-explore', label: 'date range choices', options: options.map(o => o.trim()) });
    const pick = ['last 7 days', '7 days', 'last week', 'yesterday'].map(w => options.findIndex(o => o.toLowerCase().includes(w))).find(i => i >= 0);
    if (pick === undefined) { await log({ step: 'ps-explore', label: 'no suitable date choice' }); return; }
    await page.locator('mat-option, [role=option]').nth(pick).click();
    await page.waitForTimeout(1500);
    await log({ step: 'ps-explore', ...(await snapshot(page, `chose "${options[pick].trim()}"`)), screenshot_jpeg_base64: undefined });
    await page.getByRole('button', { name: /^\s*apply\s*$/i }).first().click({ timeout: 10000 });
    await page.waitForTimeout(6000);
    await closePopups(page);

    // export as CSV
    await page.locator('[aria-label="export transactions" i]').first().click({ timeout: 15000 });
    await page.waitForTimeout(1500);
    const download = page.waitForEvent('download', { timeout: 60000 }).catch(() => null);
    await page.getByText(/csv export/i).first().click({ timeout: 10000 });
    const d = await download;
    if (d) {
      const path = await d.path();
      const body = path ? (await import('node:fs')).readFileSync(path, 'utf8') : '';
      const lines = body.split(/\r?\n/).filter(Boolean);
      await log({ step: 'ps-explore', label: 'CSV downloaded', filename: d.suggestedFilename(), lines: lines.length, head: lines.slice(0, 3), tail: lines.slice(-2) });
    } else await log({ step: 'ps-explore', ...(await snapshot(page, 'no CSV download within 60s')) });
  } finally { await browser.close(); }
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
