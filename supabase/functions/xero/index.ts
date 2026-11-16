// Xero connection for the Em H Orders app.
//  GET  /xero/callback?code&state      Xero sends the admin back here after "Connect Xero"
//  POST /xero {action:'status'}        any orders user: is Xero connected?
//  POST /xero {action:'auth_url'}      admin: link to start connecting
//  POST /xero {action:'disconnect'}    admin
//  POST /xero {action:'send', order_id} admin/invoicing: create a DRAFT invoice in Xero, mark order invoiced
import { createClient } from 'npm:@supabase/supabase-js@2';

const CLIENT_ID = (Deno.env.get('XERO_CLIENT_ID') ?? '').trim().replace(/^["']|["']$/g, '');
const CLIENT_SECRET = (Deno.env.get('XERO_CLIENT_SECRET') ?? '').trim().replace(/^["']|["']$/g, '');
const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const REDIRECT = `${SB_URL}/functions/v1/xero/callback`;
const APP = 'https://accounts1-alt.github.io/emh-ledger/orders/#setup';
const SCOPES = 'openid profile email offline_access accounting.invoices accounting.contacts';
const SALES_ACCOUNT = '224';

const db = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
class Fail extends Error {}

async function caller(req: Request) {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data } = await db.auth.getUser(token);
  const email = data.user?.email?.toLowerCase();
  if (!email) throw new Fail('Please sign in again');
  const { data: u } = await db.from('ord_users').select('role').eq('email', email).maybeSingle();
  if (!u) throw new Fail('Your login is not set up for orders');
  return { email, role: u.role as string };
}

async function tokenCall(body: Record<string, string>) {
  const r = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(`${CLIENT_ID}:${CLIENT_SECRET}`), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const t = await r.json();
  if (!r.ok) throw new Fail(`Xero login failed: ${t.error ?? r.status}`);
  return t as { access_token: string; refresh_token: string; expires_in: number };
}

/** A valid access token + tenant, refreshing if needed. */
async function xeroAuth() {
  const { data: a } = await db.from('xero_auth').select('*').eq('id', 1).maybeSingle();
  if (!a?.refresh_token || !a.tenant_id) throw new Fail('Xero is not connected yet – an admin needs to click “Connect Xero” in Settings');
  if (a.access_token && new Date(a.expires_at).getTime() > Date.now() + 60_000) return a;
  let t;
  try { t = await tokenCall({ grant_type: 'refresh_token', refresh_token: a.refresh_token }); }
  catch { throw new Fail('The Xero connection has expired – an admin needs to click “Connect Xero” in Settings again'); }
  const upd = { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString() };
  await db.from('xero_auth').update(upd).eq('id', 1);
  return { ...a, ...upd };
}

async function xero(path: string, init: RequestInit = {}) {
  const a = await xeroAuth();
  const r = await fetch(`https://api.xero.com/api.xro/2.0/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${a.access_token}`, 'xero-tenant-id': a.tenant_id, Accept: 'application/json', 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msgs = body?.Elements?.flatMap((e: { ValidationErrors?: { Message: string }[] }) => e.ValidationErrors?.map(v => v.Message) ?? []) ?? [];
    throw new Fail(`Xero said: ${msgs.join('; ') || body?.Message || body?.Detail || r.status}`);
  }
  return body;
}

async function contactFor(customer: { id: number; name: string; xero_contact_id: string | null }) {
  if (customer.xero_contact_id) return customer.xero_contact_id;
  // look for an existing Xero contact with exactly this name, otherwise create one
  const found = await xero(`Contacts?where=${encodeURIComponent(`Name=="${customer.name.replace(/"/g, '\\"')}"`)}`);
  let id: string | undefined = found.Contacts?.[0]?.ContactID;
  if (!id) id = (await xero('Contacts', { method: 'PUT', body: JSON.stringify({ Contacts: [{ Name: customer.name }] }) })).Contacts?.[0]?.ContactID;
  if (!id) throw new Fail('Couldn’t find or create the customer in Xero');
  await db.from('ord_customers').update({ xero_contact_id: id }).eq('id', customer.id);
  return id;
}

async function send(orderId: number, who: string) {
  const { data: o } = await db.from('ord_orders').select('*').eq('id', orderId).maybeSingle();
  if (!o) throw new Fail('Order not found');
  if (o.status !== 'fulfilled') throw new Fail(o.status === 'invoiced' ? 'Already invoiced' : 'Processing has not finished this order yet');
  if (o.xero_invoice_id) throw new Fail('This order was already sent to Xero');
  const { data: lines } = await db.from('ord_lines').select('id, item_id, qty_net, sent_unit, trays, removed').eq('order_id', orderId).eq('removed', false).order('position');
  if (!lines?.length) throw new Fail('No items on this order');
  const { data: prices } = await db.from('ord_line_prices').select('*').in('line_id', lines.map(l => l.id));
  const price = new Map((prices ?? []).map(p => [p.line_id, Number(p.price)]));
  const { data: items } = await db.from('ord_items').select('id, name, xero_code').in('id', lines.map(l => l.item_id));
  const item = new Map((items ?? []).map(i => [i.id, i]));
  const { data: cust } = await db.from('ord_customers').select('id, name, xero_contact_id').eq('id', o.customer_id).single();

  const LineItems = lines.map(l => {
    const p = price.get(l.id), it = item.get(l.item_id)!;
    if (p == null) throw new Fail(`No price for ${it.name}`);
    const li: Record<string, unknown> = { Description: it.name, Quantity: Number(l.qty_net), UnitAmount: p, AccountCode: SALES_ACCOUNT };
    if (it.xero_code) li.ItemCode = it.xero_code;
    return li;
  });
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
  const inv = {
    Type: 'ACCREC', Status: 'DRAFT', LineAmountTypes: 'Exclusive',
    Contact: { ContactID: await contactFor(cust!) },
    Date: today, DueDate: today, Reference: `Order #${o.id}`, LineItems,
  };
  const res = await xero('Invoices', { method: 'PUT', headers: { 'Idempotency-Key': `emh-order-${o.id}-${Math.floor(Date.now() / 120000)}` }, body: JSON.stringify({ Invoices: [inv] }) });
  const x = res.Invoices?.[0];
  if (!x?.InvoiceID) throw new Fail('Xero did not return an invoice');
  await db.from('ord_orders').update({ status: 'invoiced', invoiced_at: new Date().toISOString(), invoiced_by: who, invoice_number: x.InvoiceNumber, xero_invoice_id: x.InvoiceID }).eq('id', o.id);
  await db.from('ord_log').insert({ order_id: o.id, by_user: who, action: 'sent to Xero', detail: `${x.InvoiceNumber} (draft) £${x.Total}` });
  return { invoice_number: x.InvoiceNumber, total: x.Total };
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const url = new URL(req.url);
  try {
    if (!CLIENT_ID || !CLIENT_SECRET) throw new Fail('Xero app details (XERO_CLIENT_ID / XERO_CLIENT_SECRET) are not set yet');

    if (req.method === 'GET' && url.pathname.endsWith('/callback')) {
      const code = url.searchParams.get('code'), state = url.searchParams.get('state');
      const { data: a } = await db.from('xero_auth').select('state, connected_by').eq('id', 1).maybeSingle();
      if (!code || !state || !a?.state || state !== a.state) return Response.redirect(`${APP}`, 302);
      const t = await tokenCall({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT });
      const conns = await (await fetch('https://api.xero.com/connections', { headers: { Authorization: `Bearer ${t.access_token}` } })).json();
      const c = (conns as { tenantId: string; tenantName: string; tenantType: string }[]).find(x => x.tenantType === 'ORGANISATION');
      if (!c) throw new Fail('No Xero organisation was connected');
      await db.from('xero_auth').update({ tenant_id: c.tenantId, tenant_name: c.tenantName, access_token: t.access_token, refresh_token: t.refresh_token,
        expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(), state: null, connected_at: new Date().toISOString() }).eq('id', 1);
      return Response.redirect(APP, 302);
    }

    if (req.method !== 'POST') return json({ error: 'Not found' }, 404);
    const me = await caller(req);
    const b = await req.json().catch(() => ({}));

    if (b.action === 'status') {
      const { data: a } = await db.from('xero_auth').select('tenant_name, connected_by, connected_at, refresh_token').eq('id', 1).maybeSingle();
      return json({ connected: !!a?.refresh_token, tenant_name: a?.tenant_name ?? null, connected_by: a?.connected_by ?? null, connected_at: a?.connected_at ?? null,
        client_hint: me.role === 'admin' ? `${CLIENT_ID.slice(0, 4)}…${CLIENT_ID.slice(-4)} (${CLIENT_ID.length} characters)` : null });
    }
    if (b.action === 'auth_url') {
      if (me.role !== 'admin') throw new Fail('Only admins can connect Xero');
      const state = crypto.randomUUID();
      await db.from('xero_auth').upsert({ id: 1, state, connected_by: me.email });
      const q = new URLSearchParams({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT, scope: SCOPES, state });
      return json({ url: `https://login.xero.com/identity/connect/authorize?${q}` });
    }
    if (b.action === 'disconnect') {
      if (me.role !== 'admin') throw new Fail('Only admins can disconnect Xero');
      await db.from('xero_auth').update({ access_token: null, refresh_token: null, tenant_id: null, tenant_name: null }).eq('id', 1);
      return json({ ok: true });
    }
    if (b.action === 'send') {
      if (!['admin', 'invoicing'].includes(me.role)) throw new Fail('Only invoicing can send invoices');
      return json(await send(Number(b.order_id), me.email));
    }
    throw new Fail('Unknown action');
  } catch (e) {
    const msg = e instanceof Fail ? e.message : `Something went wrong: ${(e as Error).message}`;
    if (req.method === 'GET') return new Response(`<p style="font:18px system-ui">${msg.replace(/</g, '&lt;')}</p><p><a href="${APP}">Back to Em H Orders</a></p>`, { status: 400, headers: { 'Content-Type': 'text/html' } });
    return json({ error: msg }, e instanceof Fail ? 400 : 500);
  }
});
