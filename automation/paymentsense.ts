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
  const info = await page.evaluate(() => {
    const vis = (e: Element) => { const r = (e as HTMLElement).getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const txt = (e: Element) => ((e as HTMLElement).innerText || e.getAttribute('aria-label') || e.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    return {
      title: document.title,
      headings: [...document.querySelectorAll('h1,h2,h3')].filter(vis).map(txt).filter(Boolean).slice(0, 30),
      buttons: [...document.querySelectorAll('button,[role=button],a.btn,input[type=submit]')].filter(vis).map(e => txt(e) || (e as HTMLInputElement).value).filter(Boolean).slice(0, 60),
      links: [...document.querySelectorAll('a[href]')].filter(vis).map(e => `${txt(e)} -> ${(e as HTMLAnchorElement).getAttribute('href')}`).slice(0, 80),
      inputs: [...document.querySelectorAll('input,select')].filter(vis).map(e => `${e.tagName.toLowerCase()} type=${e.getAttribute('type') ?? ''} name=${e.getAttribute('name') ?? ''} id=${e.id} placeholder=${e.getAttribute('placeholder') ?? ''} aria=${e.getAttribute('aria-label') ?? ''}`).slice(0, 40),
      text: document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 2500),
    };
  });
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

    for (const name of ['Transactions', 'Reports', 'Statements']) {
      const nav = page.getByRole('link', { name: new RegExp(name, 'i') }).or(page.getByRole('button', { name: new RegExp(name, 'i') })).first();
      if (await nav.count()) {
        await nav.click().catch(() => undefined);
        await page.waitForTimeout(6000);
        await log({ step: 'ps-explore', ...(await snapshot(page, `after clicking ${name}`)) });
        break;
      }
    }
  } finally { await browser.close(); }
}
