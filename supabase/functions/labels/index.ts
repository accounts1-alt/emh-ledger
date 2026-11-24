// Reads photos of subtotal label sheets with Gemini for the Em H Orders app.
//  POST /labels { images: [base64 jpeg...], expect: ["Minced Beef", "Chicken – Necks", ...] }
//  -> { labels: [{ photo, name, match, kind, crossed_out, packets, kg, total }] }
// Only admin / processing logins. The Gemini key lives in ord_secrets (no read access for any login).
import { createClient } from 'npm:@supabase/supabase-js@2';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const MODEL = 'gemini-2.5-flash';
const db = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
class Fail extends Error {}

const PROMPT = (expect: string[]) => `You are reading photos of butcher's label sheets. Each photo shows several printed labels stuck on a sheet; photos may be rotated or sideways.
There are two kinds of label:
- "subtotal": shows an item name, the word "Transactions" with a number under it (= number of packets), and a box with "Weight" (kg) and "TOTAL" (£).
- "pack": a single-packet label with a barcode and a box with "£ / kg", "kg" and a price.
A label crossed out with pen (a big X or scribble over it) is "crossed_out": true.
Return EVERY label you can see, one entry per label, in reading order per photo:
- photo: index of the photo, starting at 0
- name: the item name exactly as printed (e.g. "Minced Beef", "Top Rib Cubed"); ignore handwriting such as dates or "Samples"
- kind: "subtotal" or "pack" (or "other" if it is neither)
- crossed_out: true/false
- packets: the Transactions number (subtotal only, else null)
- kg: the weight in kg as a number (subtotal: the Weight box; pack: the kg box)
- total: the £ amount as a number (subtotal: TOTAL; pack: the price)
- match: if the label is clearly the same product as one of these order items, copy that order item text exactly; otherwise "".
Order items: ${expect.length ? expect.map(e => JSON.stringify(e)).join(', ') : '(none given)'}
Read digits carefully; never guess a number you cannot read – use null instead.`;

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    labels: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          photo: { type: 'INTEGER' }, name: { type: 'STRING' }, match: { type: 'STRING' },
          kind: { type: 'STRING', enum: ['subtotal', 'pack', 'other'] }, crossed_out: { type: 'BOOLEAN' },
          packets: { type: 'NUMBER', nullable: true }, kg: { type: 'NUMBER', nullable: true }, total: { type: 'NUMBER', nullable: true },
        },
        required: ['photo', 'name', 'kind', 'crossed_out', 'match'],
      },
    },
  },
  required: ['labels'],
};

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    if (req.method !== 'POST') throw new Fail('Not found');
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: au } = await db.auth.getUser(token);
    const email = au.user?.email?.toLowerCase();
    if (!email) throw new Fail('Please sign in again');
    const { data: u } = await db.from('ord_users').select('role').eq('email', email).maybeSingle();
    if (!u || !['admin', 'processing'].includes(u.role)) throw new Fail('Only processing can read labels');

    const { data: k } = await db.from('ord_secrets').select('value').eq('key', 'gemini_api_key').maybeSingle();
    if (!k?.value) throw new Fail('The Gemini key is not set yet – an admin needs to add it in Settings');

    const b = await req.json().catch(() => ({}));
    const images: string[] = Array.isArray(b.images) ? b.images.filter((x: unknown) => typeof x === 'string' && x.length > 100) : [];
    const expect: string[] = Array.isArray(b.expect) ? b.expect.filter((x: unknown) => typeof x === 'string').slice(0, 200) : [];
    if (!images.length) throw new Fail('Take at least one photo');
    if (images.length > 12) throw new Fail('At most 12 photos at a time');

    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': k.value },
      body: JSON.stringify({
        contents: [{ parts: [{ text: PROMPT(expect) }, ...images.map(d => ({ inline_data: { mime_type: 'image/jpeg', data: d.replace(/^data:image\/\w+;base64,/, '') } }))] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: SCHEMA },
      }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) {
      const m = out?.error?.message ?? r.status;
      if (r.status === 400 && /API key/i.test(String(m))) throw new Fail('Gemini did not accept the key – check it in Settings');
      throw new Fail(`Gemini said: ${m}`);
    }
    const text = out?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? '').join('') ?? '';
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Fail('Could not read the labels – try a clearer photo'); }
    const labels = (parsed.labels ?? []).map((l: Record<string, unknown>) => ({
      photo: Number(l.photo) || 0, name: String(l.name ?? '').trim(), match: String(l.match ?? '').trim(),
      kind: l.kind, crossed_out: !!l.crossed_out,
      packets: l.packets == null ? null : Number(l.packets), kg: l.kg == null ? null : Number(l.kg), total: l.total == null ? null : Number(l.total),
    }));
    return json({ labels });
  } catch (e) {
    const msg = e instanceof Fail ? e.message : `Something went wrong: ${(e as Error).message}`;
    return json({ error: msg }, e instanceof Fail ? 400 : 500);
  }
});
