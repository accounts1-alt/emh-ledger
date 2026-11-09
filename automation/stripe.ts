// Nightly Stripe pull: reads charges through the Stripe API and saves them exactly like the CSV import does.
import { STRIPE_FINGERPRINT, stripeFingerprint, round2, type CardRow } from '../src/lib/parsers';
import { all, q, supabase } from '../src/lib/supabase';
import { addDays } from '../src/lib/recon';

type Account = 'stripe_shop' | 'stripe_office';
export const STRIPE_LABEL: Record<Account, string> = { stripe_shop: 'Stripe Shop', stripe_office: 'Stripe Office' };

/** The parts of a Stripe charge we use. */
export interface StripeCharge {
  id: string; created: number; amount: number; amount_refunded: number; status: string; captured: boolean; paid: boolean;
  description: string | null; currency: string;
  customer: null | string | { description?: string | null; name?: string | null };
  balance_transaction: null | string | { fee: number; currency: string };
  payment_method_details?: { card?: { brand?: string; funding?: string; last4?: string } } | null;
}

/** One charge → one card_txns row, the same as a line of the Stripe payments CSV (dates in UTC, like the export). */
export function chargeToRow(c: StripeCharge, account: Account): CardRow | null {
  if (c.status !== 'succeeded' || !c.captured) return null;
  const iso = new Date(c.created * 1000).toISOString();
  const date = iso.slice(0, 10), time = iso.slice(11, 19);
  const gross = c.amount / 100, refunded = c.amount_refunded / 100;
  const desc = (c.description ?? '').replace(/\s+/g, ' ').trim();
  const custDesc = typeof c.customer === 'object' && c.customer ? (c.customer.description || '').trim() : '';
  const bt = typeof c.balance_transaction === 'object' && c.balance_transaction ? c.balance_transaction : null;
  const card = c.payment_method_details?.card;
  return {
    merchant: account, ext_id: c.id, txn_at: `${date} ${time}`, txn_date: date,
    amount: round2(gross - refunded), refunded: round2(refunded), fee: bt ? round2(bt.fee / 100) : 0,
    customer: account === 'stripe_shop' ? desc.split(' | ')[0] : (custDesc || desc),
    description: desc, payout_ref: null,
    card_scheme: card?.brand ? card.brand[0].toUpperCase() + card.brand.slice(1) : '', card_type: card?.funding ?? '', card_last4: card?.last4 ?? '', terminal_id: '',
  };
}

async function listCharges(key: string, from: string, to: string): Promise<StripeCharge[]> {
  const out: StripeCharge[] = [];
  let after: string | null = null;
  for (;;) {
    const p = new URLSearchParams({ limit: '100', 'created[gte]': String(Date.parse(from + 'T00:00:00Z') / 1000), 'created[lt]': String(Date.parse(addDays(to, 1) + 'T00:00:00Z') / 1000) });
    p.append('expand[]', 'data.balance_transaction'); p.append('expand[]', 'data.customer');
    if (after) p.set('starting_after', after);
    const res = await fetch(`https://api.stripe.com/v1/charges?${p}`, { headers: { Authorization: `Bearer ${key}` } });
    const body = await res.json() as { data?: StripeCharge[]; has_more?: boolean; error?: { message: string } };
    if (!res.ok) throw new Error(`Stripe said: ${body.error?.message ?? res.status}`);
    out.push(...(body.data ?? []));
    if (!body.has_more || !body.data?.length) break;
    after = body.data[body.data.length - 1].id;
  }
  return out;
}

export interface PullResult { source: string; label: string; ok: boolean; from: string; to: string; added: number; updated: number; seen: number; message: string }

/** Pull [from, to] for one Stripe account: add new charges, pick up refunds on ones already in the app. */
export async function pullStripe(account: Account, key: string | undefined, from: string, to: string): Promise<PullResult> {
  const base = { source: account, label: STRIPE_LABEL[account], from, to, added: 0, updated: 0, seen: 0 };
  if (!key) return { ...base, ok: false, message: 'Not set up yet (no Stripe key).' };
  const charges = await listCharges(key, from, to);
  const wrong = charges.find(c => stripeFingerprint(c.id) && stripeFingerprint(c.id) !== STRIPE_FINGERPRINT[account]);
  if (wrong) throw new Error(`This key belongs to the other Stripe account (charge ${wrong.id}). Check the ${account === 'stripe_shop' ? 'STRIPE_SHOP_KEY' : 'STRIPE_OFFICE_KEY'} secret.`);
  const rows = charges.map(c => chargeToRow(c, account)).filter((r): r is CardRow => !!r);

  const existing = await all((a, b) => supabase.from('card_txns').select('id,ext_id,amount,refunded').eq('merchant', account)
    .gte('txn_date', addDays(from, -1)).lte('txn_date', addDays(to, 1)).range(a, b)) as { id: string; ext_id: string; amount: number; refunded: number }[];
  const byId = new Map(existing.map(e => [e.ext_id, e]));
  const fresh = rows.filter(r => !byId.has(r.ext_id));
  const changed = rows.filter(r => { const e = byId.get(r.ext_id); return e && Math.abs(Number(e.refunded) - r.refunded) > 0.004; });

  const imp = await q(supabase.from('import_files').insert({
    source: account, filename: 'Nightly pull (Stripe API)', rows_in_file: rows.length, rows_added: fresh.length, rows_duplicate: rows.length - fresh.length, date_from: from, date_to: to,
  }).select('id').single()) as { id: string };
  for (let i = 0; i < fresh.length; i += 500)
    await q(supabase.from('card_txns').upsert(fresh.slice(i, i + 500).map(r => ({ ...r, import_id: imp.id })), { onConflict: 'merchant,ext_id', ignoreDuplicates: true }));
  for (const r of changed) {
    const e = byId.get(r.ext_id)!;
    await q(supabase.from('card_txns').update({ amount: r.amount, refunded: r.refunded, change_reason: `Refund picked up by the nightly Stripe pull (refunded £${r.refunded.toFixed(2)})` }).eq('id', e.id));
  }
  return { ...base, ok: true, added: fresh.length, updated: changed.length, seen: rows.length,
    message: `${fresh.length} new payment${fresh.length === 1 ? '' : 's'}${changed.length ? `, ${changed.length} refund${changed.length === 1 ? '' : 's'} picked up` : ''}${rows.length - fresh.length - changed.length ? `, ${rows.length - fresh.length - changed.length} already in the app` : ''}.` };
}
