// The morning email: what the night's pull did, yesterday against Semtek, and every problem still open.
import { loadCompare, loadCoverage, type CompareData } from '../src/lib/data';
import { all, q, supabase } from '../src/lib/supabase';
import { addDays, type DayRow, type Figure, type BacsMatch } from '../src/lib/recon';
import type { Coverage } from '../src/lib/recon';
import type { PullResult } from './stripe';

export const APP_URL = 'https://emh-ledger.netlify.app';
const SOURCE_LABEL: Record<string, string> = { semtek: 'Semtek', paymentsense: 'Paymentsense', stripe_shop: 'Stripe Shop', stripe_office: 'Stripe Office', bacs: 'BACS' };
const TYPE_LABEL: Record<string, string> = { cash: 'Cash', cheque: 'Cheques', vouchers: 'Vouchers', cards: 'Cards', bacs: 'BACS' };

export interface ReportData {
  day: string; from: string;
  compare: Pick<CompareData, 'days' | 'cards' | 'cheques' | 'bacs'>;
  coverage: Coverage[];
  lastCount: string | null;
  floatsOut: { ref: number; date_from: string; date_to: string; amount: number }[];
  chequesWaiting: { received_date: string; payer: string | null; cheque_no: string | null; amount: number }[];
  vouchersWaiting: { received_date: string; amount: number }[];
  pulls: PullResult[];
}

export async function gatherReport(day: string, pulls: PullResult[]): Promise<ReportData> {
  const from = addDays(day, -13);
  const [compare, coverage, counts, floats, cheques, vouchers] = await Promise.all([
    loadCompare(from, day), loadCoverage(),
    q(supabase.from('counts').select('date_to').eq('voided', false).order('date_to', { ascending: false }).limit(1)) as Promise<{ date_to: string }[]>,
    q(supabase.from('v_float_status').select('ref,date_from,date_to,amount,status').eq('status', 'out').lt('date_to', addDays(day, -7)).order('date_from')) as Promise<ReportData['floatsOut']>,
    all((a, b) => supabase.from('cheques').select('received_date,payer,cheque_no,amount').eq('voided', false).eq('status', 'office').lt('received_date', addDays(day, -7)).order('received_date').range(a, b)) as Promise<ReportData['chequesWaiting']>,
    all((a, b) => supabase.from('voucher_lots').select('received_date,amount').eq('voided', false).is('posting_id', null).lt('received_date', addDays(day, -7)).order('received_date').range(a, b)) as Promise<ReportData['vouchersWaiting']>,
  ]);
  return { day, from, compare, coverage, lastCount: counts[0]?.date_to ?? null, floatsOut: floats, chequesWaiting: cheques, vouchersWaiting: vouchers, pulls };
}

// ---------- rendering (pure, so it can be tested without a database) ----------
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const money = (n: number | null | undefined) => (n === null || n === undefined ? '–' : `${n < 0 ? '−' : ''}£${Math.abs(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const signed = (n: number | null) => (n === null ? '–' : n > 0 ? `+${money(n)}` : money(n));
const dayName = (iso: string) => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const STATUS: Record<string, [string, string]> = {
  match: ['Matches', '#1a7f37'], ok: ['OK (within tolerance)', '#1a7f37'], diff: ['Doesn’t match', '#c62828'], waiting: ['Waiting', '#9a6700'], none: ['Nothing', '#777'],
};
const chip = (s: string) => `<span style="color:${STATUS[s][1]};font-weight:600">${STATUS[s][0]}</span>`;
const TD = 'style="padding:6px 10px;border-bottom:1px solid #eee"', TDR = 'style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap"';
const TH = 'style="padding:6px 10px;border-bottom:2px solid #ddd;text-align:left;font-size:12px;color:#666"';
const table = (head: string[], rows: string[][], right: number[] = []) =>
  `<table style="border-collapse:collapse;width:100%;font-size:14px;margin:4px 0 18px"><tr>${head.map((h, i) => `<th ${right.includes(i) ? TH.replace('left', 'right') : TH}>${h}</th>`).join('')}</tr>${rows.map(r => `<tr>${r.map((c, i) => `<td ${right.includes(i) ? TDR : TD}>${c}</td>`).join('')}</tr>`).join('')}</table>`;
const h2 = (t: string) => `<h2 style="font-size:17px;margin:26px 0 6px">${t}</h2>`;
const p = (t: string, muted = false) => `<p style="margin:4px 0 10px;${muted ? 'color:#666;font-size:13px' : ''}">${t}</p>`;

type Problem = { date: string; type: string; f: Figure; span?: string };
/** Every day/type in the window that doesn't match. Cash is one figure per count period. */
export function findProblems(days: DayRow[]): Problem[] {
  const out: Problem[] = [];
  for (const d of days) {
    if (d.cash && d.cash.status === 'diff') out.push({ date: d.cash.from, type: 'cash', f: d.cash, span: d.cash.to > d.cash.from ? `${dayName(d.cash.from)} – ${dayName(d.cash.to)}` : undefined });
    for (const t of ['cheque', 'vouchers', 'cards', 'bacs'] as const) if (d[t].status === 'diff') out.push({ date: d.date, type: t, f: d[t] });
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : -1));
}
const unmatched = (list: BacsMatch[], dates: Set<string>) => list.filter(m => (!m.bank || !m.semtek) && dates.has((m.bank ?? m.semtek)!.txn_date));

export function renderReport(r: ReportData): { subject: string; html: string; problems: number } {
  const { days } = r.compare;
  const y = days.find(d => d.date === r.day);
  const cashY = days.find(d => d.cash && d.cash.from <= r.day && r.day <= d.cash.to)?.cash ?? null;
  const problems = findProblems(days);
  const probDates = (t: string) => new Set(problems.filter(x => x.type === t).map(x => x.date));
  const cardsLoose = unmatched(r.compare.cards, probDates('cards'));
  const chequesLoose = unmatched(r.compare.cheques, probDates('cheque'));
  const bacsLoose = unmatched(r.compare.bacs, probDates('bacs'));
  const notSetUp = (x: PullResult) => !x.ok && x.message.startsWith('Not set up');
  const pullFailed = r.pulls.filter(x => !x.ok && !notSetUp(x));
  const reminders = r.floatsOut.length + (r.chequesWaiting.length ? 1 : 0) + (r.vouchersWaiting.length ? 1 : 0);

  // which sources are behind
  const latest = new Map<string, string>();
  for (const c of r.coverage) if (!latest.has(c.source) || c.date_to > latest.get(c.source)!) latest.set(c.source, c.date_to);
  const behind = Object.keys(SOURCE_LABEL).filter(s => (latest.get(s) ?? '') < r.day).map(s => `${SOURCE_LABEL[s]} (${latest.get(s) ? 'up to ' + dayName(latest.get(s)!) : 'nothing yet'})`);
  if (!r.lastCount || r.lastCount < r.day) behind.push(`Weekly count (${r.lastCount ? 'counted up to ' + dayName(r.lastCount) : 'none yet'})`);

  const n = problems.length + pullFailed.length;
  const subject = `${dayName(r.day)}: ${n ? `${n} problem${n === 1 ? '' : 's'}` : 'everything matches'}${reminders ? ` · ${reminders} reminder${reminders === 1 ? '' : 's'}` : ''} – Em H takings`;
  const parts: string[] = [];
  parts.push(`<h1 style="font-size:20px;margin:0 0 4px">Takings report for ${new Date(r.day + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}</h1>`);
  parts.push(p(n ? `<strong style="color:#c62828">${n} thing${n === 1 ? '' : 's'} to look at.</strong> Details below.` : '<strong style="color:#1a7f37">Nothing to fix.</strong> Everything that can be checked matches.'));

  if (r.pulls.length) {
    parts.push(h2('Last night’s download'));
    parts.push(table(['Source', 'Dates', 'Result'], r.pulls.map(x => [esc(x.label), `${dayName(x.from)} – ${dayName(x.to)}`, x.ok ? esc(x.message) : notSetUp(x) ? `<span style="color:#777">${esc(x.message)}</span>` : `<span style="color:#c62828;font-weight:600">${esc(x.message)}</span>`])));
  }

  parts.push(h2(`Yesterday against Semtek`));
  if (!y || !y.semtekLoaded) parts.push(p('Semtek isn’t in the app for yesterday yet, so nothing can be compared.'));
  else {
    const rows: string[][] = [];
    const add = (t: string, f: Figure | null, note = '') => f && rows.push([TYPE_LABEL[t] + note, money(f.semtek), f.actual === null ? '–' : money(f.actual), signed(f.diff), chip(f.status)]);
    add('cash', cashY, cashY && cashY.to > cashY.from ? ` <span style="color:#666;font-size:12px">(${dayName(cashY.from)} – ${dayName(cashY.to)})</span>` : '');
    add('cheque', y.cheque); add('vouchers', y.vouchers); add('cards', y.cards); add('bacs', y.bacs);
    parts.push(table(['', 'Semtek', 'Received', 'Difference', ''], rows, [1, 2, 3]));
  }

  parts.push(h2(`Problems in the last 14 days`));
  if (!problems.length) parts.push(p('None. Every day that can be checked matches.'));
  else parts.push(table(['Day', 'What', 'Semtek', 'Received', 'Difference'],
    problems.map(x => [x.span ?? dayName(x.date), TYPE_LABEL[x.type], money(x.f.semtek), money(x.f.actual), `<strong style="color:#c62828">${signed(x.f.diff)}</strong>`]), [2, 3, 4]));

  const lines = (title: string, list: BacsMatch[], who: string) => {
    if (!list.length) return;
    parts.push(`<h3 style="font-size:15px;margin:14px 0 4px">${title}</h3>`);
    parts.push(table(['Day', 'Only in', 'Detail', 'Amount'], list.map(m => {
      const side = m.bank ? 'bank' : 'semtek'; const l = (m.bank ?? m.semtek)!;
      return [dayName(l.txn_date), side === 'bank' ? who : 'Semtek', esc(l.label), money(l.amount)];
    }), [3]));
  };
  lines('Card payments with no partner', cardsLoose, 'Card machine');
  lines('Cheques with no partner', chequesLoose, 'Cheques received');
  lines('BACS with no partner', bacsLoose, 'Bank');

  if (behind.length) {
    parts.push(h2('Not loaded up to yesterday yet'));
    parts.push(p(behind.map(esc).join('<br>')));
    parts.push(p('Anything that depends on these shows as “waiting” until they come in.', true));
  }

  if (reminders) {
    parts.push(h2('Reminders'));
    const rem: string[] = [];
    for (const f of r.floatsOut) rem.push(`Float #${f.ref} (${money(Number(f.amount))} for ${dayName(f.date_from)}${f.date_to > f.date_from ? ' – ' + dayName(f.date_to) : ''}) hasn’t been counted back.`);
    if (r.chequesWaiting.length) rem.push(`${r.chequesWaiting.length} cheque${r.chequesWaiting.length === 1 ? '' : 's'} (${money(r.chequesWaiting.reduce((s, c) => s + Number(c.amount), 0))}) in the office for over a week, oldest from ${dayName(r.chequesWaiting[0].received_date)}. Post them?`);
    if (r.vouchersWaiting.length) rem.push(`${money(r.vouchersWaiting.reduce((s, c) => s + Number(c.amount), 0))} of vouchers in the office for over a week, oldest from ${dayName(r.vouchersWaiting[0].received_date)}. Post them?`);
    parts.push(p(rem.join('<br>')));
  }

  parts.push(`<p style="margin:28px 0 0"><a href="${APP_URL}/#compare" style="background:#1d4ed8;color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none">Open Against Semtek</a></p>`);
  parts.push(p('Sent automatically every morning by the Em H ledger.', true));
  const html = `<!doctype html><html><body style="margin:0;background:#f6f6f4"><div style="max-width:720px;margin:0 auto;padding:22px 18px;background:#fff;font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#1b1b1b;line-height:1.4">${parts.join('\n')}</div></body></html>`;
  return { subject, html, problems: n };
}
