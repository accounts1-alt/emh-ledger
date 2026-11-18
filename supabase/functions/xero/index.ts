// Xero connection for the Em H Orders app.
//  GET  /xero/callback?code&state      Xero sends the admin back here after "Connect Xero"
//  POST /xero {action:'status'}        any orders user: is Xero connected?
//  POST /xero {action:'auth_url'}      admin: link to start connecting
//  POST /xero {action:'disconnect'}    admin
//  POST /xero {action:'sync'}          admin: Xero is master - pull all customers and items
//  POST /xero {action:'send', order_id} admin/invoicing: create a DRAFT invoice in Xero, mark order invoiced
import { createClient } from 'npm:@supabase/supabase-js@2';

const CLIENT_ID = (Deno.env.get('XERO_CLIENT_ID') ?? '').trim().replace(/^["']|["']$/g, '');
const CLIENT_SECRET = (Deno.env.get('XERO_CLIENT_SECRET') ?? '').trim().replace(/^["']|["']$/g, '');
const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const REDIRECT = `${SB_URL}/functions/v1/xero/callback`;
const APP = 'https://accounts1-alt.github.io/emh-ledger/orders/#setup';
const SCOPES = 'openid profile email offline_access accounting.invoices accounting.contacts accounting.settings.read';
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
  const { data: items } = await db.from('ord_items').select('id, name, xero_code, xero_tax_type, xero_account').in('id', lines.map(l => l.item_id));
  const item = new Map((items ?? []).map(i => [i.id, i]));
  const { data: cust } = await db.from('ord_customers').select('id, name, xero_contact_id, is_test').eq('id', o.customer_id).single();
  if (cust?.is_test) throw new Fail('This is a test customer – it is never sent to Xero');
  const { data: tx } = await db.from('ord_settings').select('value').eq('key', 'xero_tax_type').maybeSingle();
  const taxType = tx?.value || 'ZERORATEDOUTPUT';

  const LineItems = lines.map(l => {
    const p = price.get(l.id), it = item.get(l.item_id)!;
    if (p == null) throw new Fail(`No price for ${it.name}`);
    // Xero's API does not copy an item's VAT onto the line (it uses the account's), so send the item's own
    // sales account + VAT rate (saved at sync). Items without them: account 224 + zero-rated.
    const li: Record<string, unknown> = { Description: it.name, Quantity: Number(l.qty_net), UnitAmount: p,
      AccountCode: it.xero_account || SALES_ACCOUNT, TaxType: it.xero_tax_type || taxType };
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

const norm = (s: string) => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Xero is the master list: bring in every customer and item, overwrite names, archive/delete what's gone. */
async function sync(who: string) {
  // ---- customers ----
  const contacts: { ContactID: string; Name: string; ContactStatus: string; IsCustomer?: boolean; IsSupplier?: boolean }[] = [];
  for (let page = 1; page < 50; page++) {
    const r = await xero(`Contacts?page=${page}&pageSize=500`);
    const c = r.Contacts ?? [];
    contacts.push(...c);
    if (c.length < 500) break;
  }
  const xc = contacts.filter(c => c.ContactStatus === 'ACTIVE' && c.IsCustomer === true);   // only contacts Xero marks as customers (have sales invoices)
  const { data: appC } = await db.from('ord_customers').select('*');
  const cById = new Map((appC ?? []).filter(c => c.xero_contact_id).map(c => [c.xero_contact_id, c]));
  const cUnlinked = new Map((appC ?? []).filter(c => !c.xero_contact_id && !c.is_test).map(c => [norm(c.name), c]));
  const res = { customers_added: 0, customers_updated: 0, customers_archived: 0, customers_deleted: 0, items_added: 0, items_updated: 0, items_archived: 0, items_deleted: 0 };
  const seenC = new Set<string>();
  const newC: Record<string, unknown>[] = [];
  for (const x of xc) {
    seenC.add(x.ContactID);
    const row = cById.get(x.ContactID) ?? cUnlinked.get(norm(x.Name));
    if (row) {
      cUnlinked.delete(norm(row.name));
      if (row.name !== x.Name || row.xero_contact_id !== x.ContactID || !row.active || row.orphaned) {
        await db.from('ord_customers').update({ name: x.Name, xero_contact_id: x.ContactID, active: true, orphaned: false }).eq('id', row.id);
        res.customers_updated++;
      }
    } else newC.push({ name: x.Name, xero_contact_id: x.ContactID, created_by: 'xero sync' });
  }
  if (newC.length) { const { error } = await db.from('ord_customers').insert(newC); if (error) throw new Fail(`Saving customers: ${error.message}`); res.customers_added = newC.length; }
  // gone from Xero: archive if used on an order, otherwise remove (app-only new customers are kept until their first invoice)
  const goneC = (appC ?? []).filter(c => !c.is_test && c.xero_contact_id && !seenC.has(c.xero_contact_id));
  const usedC = new Set<number>();
  if (goneC.length) ((await db.rpc('ord_used_customers', { ids: goneC.map(c => c.id) })).data ?? []).forEach((id: number) => usedC.add(Number(id)));
  const archC = goneC.filter(c => usedC.has(c.id) && !c.orphaned).map(c => c.id);
  const delC = goneC.filter(c => !usedC.has(c.id)).map(c => c.id);
  for (let k = 0; k < archC.length; k += 200) await db.from('ord_customers').update({ active: false, orphaned: true }).in('id', archC.slice(k, k + 200));
  for (let k = 0; k < delC.length; k += 200) await db.from('ord_customers').delete().in('id', delC.slice(k, k + 200));
  res.customers_archived = archC.length; res.customers_deleted = delC.length;

  // ---- items ----
  let itemsResp;
  try { itemsResp = await xero('Items'); }
  catch (e) { await saveStamp(who, res, 'Items: ' + (e as Error).message); throw new Fail('Customers synced, but Xero would not give the item list – click Reconnect in Settings (Xero needs to approve reading items), then Sync again.'); }
  const xi = (itemsResp.Items ?? []).filter((i: { IsSold?: boolean }) => i.IsSold !== false) as { ItemID: string; Code: string; Name?: string; SalesDetails?: { TaxType?: string; AccountCode?: string } }[];
  const { data: appI } = await db.from('ord_items').select('*');
  const iById = new Map((appI ?? []).filter(i => i.xero_item_id).map(i => [i.xero_item_id, i]));
  const iByCode = new Map((appI ?? []).filter(i => !i.xero_item_id && i.xero_code).map(i => [i.xero_code, i]));
  const iUnlinked = new Map((appI ?? []).filter(i => !i.xero_item_id && !i.xero_code).map(i => [norm(i.name), i]));
  const seenI = new Set<number>();
  const newI: Record<string, unknown>[] = [];
  for (const x of xi) {
    const name = (x.Name || x.Code).trim();
    const tax = x.SalesDetails?.TaxType || null, acct = x.SalesDetails?.AccountCode || null;
    const row = iById.get(x.ItemID) ?? iByCode.get(x.Code) ?? iUnlinked.get(norm(name));
    if (row) {
      seenI.add(row.id); iByCode.delete(x.Code); iUnlinked.delete(norm(row.name));
      if (row.name !== name || row.xero_code !== x.Code || row.xero_item_id !== x.ItemID || !row.active || row.orphaned || row.xero_tax_type !== tax || row.xero_account !== acct) {
        await db.from('ord_items').update({ name, xero_code: x.Code, xero_item_id: x.ItemID, xero_tax_type: tax, xero_account: acct, active: true, orphaned: false }).eq('id', row.id);
        res.items_updated++;
      }
    } else newI.push({ name, xero_code: x.Code, xero_item_id: x.ItemID, xero_tax_type: tax, xero_account: acct, created_by: 'xero sync' });
  }
  if (newI.length) { const { error } = await db.from('ord_items').insert(newI); if (error) throw new Fail(`Saving items: ${error.message}`); res.items_added = newI.length; }
  const goneI = (appI ?? []).filter(i => !seenI.has(i.id) && (i.xero_code || i.xero_item_id));   // app-only items are kept
  const usedI = new Set<number>();
  if (goneI.length) ((await db.rpc('ord_used_items', { ids: goneI.map(i => i.id) })).data ?? []).forEach((id: number) => usedI.add(Number(id)));
  const archI = goneI.filter(i => usedI.has(i.id) && !i.orphaned).map(i => i.id);
  const delI = goneI.filter(i => !usedI.has(i.id)).map(i => i.id);
  for (let k = 0; k < archI.length; k += 200) await db.from('ord_items').update({ active: false, orphaned: true }).in('id', archI.slice(k, k + 200));
  for (let k = 0; k < delI.length; k += 200) await db.from('ord_items').delete().in('id', delI.slice(k, k + 200));
  res.items_archived = archI.length; res.items_deleted = delI.length;
  await saveStamp(who, res);
  return res;
}
async function saveStamp(who: string, res: Record<string, number>, error?: string) {
  await db.from('ord_settings').upsert({ key: 'last_xero_sync', value: JSON.stringify({ at: new Date().toISOString(), by: who, ...res, error }) });
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
    if (b.action === 'sync') {
      if (me.role !== 'admin') throw new Fail('Only admins can sync with Xero');
      return json(await sync(me.email));
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
