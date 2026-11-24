// Reads photos of subtotal label sheets with Gemini for the Em H Orders app.
//  POST /labels { images: [base64 jpeg...], expect: ["Minced Beef", "Chicken – Necks", ...] }
//  -> { labels: [{ photo, name, match, kind, crossed_out, packets, kg, total }] }
// Only admin / processing logins. The Gemini key lives in ord_secrets (no read access for any login).
import { createClient } from 'npm:@supabase/supabase-js@2';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// Google retires model names often: try the newest Flash first, then whatever Flash models this key can use.
const PREFERRED = ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash'];
let goodModel: string | null = null;
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

    const body = JSON.stringify({
      contents: [{ parts: [{ text: PROMPT(expect) }, ...images.map(d => ({ inline_data: { mime_type: 'image/jpeg', data: d.replace(/^data:image\/\w+;base64,/, '') } }))] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: SCHEMA },
    });
    const call = (model: string) => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': k.value }, body });
    const gone = (status: number, m: string) => status === 404 || /no longer available|not found|is not supported|deprecated|retired/i.test(m);
    const busy = (status: number, m: string) => status === 503 || status === 429 || status === 500 || /high demand|overloaded|try again|unavailable|resource has been exhausted/i.test(m);
    const wait = (ms: number) => new Promise(res => setTimeout(res, ms));
    let busyCount = 0;
    const t0 = Date.now(), late = () => Date.now() - t0 > 70000;   // stay well inside the server time limit
    let candidates = goodModel ? [goodModel, ...PREFERRED.filter(x => x !== goodModel)] : [...PREFERRED];
    let listed = false, out: any = {}, r: Response | null = null, lastMsg = '';
    for (let i = 0; i < candidates.length; i++) {
      // a busy model gets two more tries with a short wait before moving on to the next model
      for (let attempt = 0; attempt < 3; attempt++) {
        r = await call(candidates[i]);
        out = await r.json().catch(() => ({}));
        if (r.ok) break;
        lastMsg = String(out?.error?.message ?? r.status);
        if (!busy(r.status, lastMsg)) break;
        busyCount++;
        if (late()) break;
        if (attempt < 2) await wait(attempt === 0 ? 1500 : 4000);
      }
      if (r!.ok) { goodModel = candidates[i]; break; }
      if (late()) break;
      if (r!.status === 400 && /API key/i.test(lastMsg)) throw new Fail('Gemini did not accept the key – check it in Settings');
      if (!gone(r!.status, lastMsg) && !busy(r!.status, lastMsg)) throw new Fail(`Gemini said: ${lastMsg}`);
      if (i === candidates.length - 1 && !listed) {
        // ask Google which Flash models this key may use, newest first
        listed = true;
        const lr = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': k.value } });
        const lj = await lr.json().catch(() => ({}));
        const ver = (n: string) => Number((n.match(/gemini-(\d+(?:\.\d+)?)/) ?? [])[1] ?? 0);
        const more = ((lj.models ?? []) as { name: string; supportedGenerationMethods?: string[] }[])
          .filter(x => x.supportedGenerationMethods?.includes('generateContent'))
          .map(x => x.name.replace(/^models\//, ''))
          .filter(n => /^gemini-[\d.]+-flash(-latest)?$/.test(n) && !candidates.includes(n))
          .sort((a, b) => ver(b) - ver(a));
        candidates = [...candidates, ...more];
      }
    }
    if (!r?.ok) throw new Fail(busyCount ? 'Gemini is very busy right now – please try again in a minute or two' : `Gemini said: ${lastMsg}`);
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
