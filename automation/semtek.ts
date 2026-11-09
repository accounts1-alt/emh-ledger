// Semtek: the till's SQL Server database, reached over ZeroTier during the GitHub run.
// "discover" reads only the layout; "compare" checks the database against lines already imported from Semtek files.
// Only payment columns are read (never card details or customer contact data).
import sql from 'mssql';
import type { PullResult } from './stripe';
import { addDays } from '../src/lib/recon';

import { execSync } from 'node:child_process';
import dgram from 'node:dgram';
import net from 'node:net';

import { all, q, supabase } from '../src/lib/supabase';
import { round2, type SemtekRow } from '../src/lib/parsers';


const env = process.env;

export function semtekConfigured() { return !!(env.SEMTEK_SQL_HOST && env.SEMTEK_SQL_USER && env.SEMTEK_SQL_PASS); }

/** Connect, retrying for a couple of minutes: a fresh ZeroTier member can take a while to find a route to the shop. */
export async function semtekConnect(database = env.SEMTEK_SQL_DB || undefined) {
  let last: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try { return await connectOnce(database); }
    catch (e) { last = e; console.log(`Semtek connect attempt ${attempt} failed: ${(e as Error).message}`); await new Promise(r => setTimeout(r, 15000)); }
  }
  throw new Error(`${(last as Error).message} (tried 5 times over ~3 minutes; is DATA-PC on, and is your own PC disconnected from the Shop network?)`);
}

async function connectOnce(database?: string) {
  // "10.147.17.5\SQLEXPRESS" = a named instance; "10.147.17.5" or "10.147.17.5,1433" = host and port
  const raw = env.SEMTEK_SQL_HOST!.trim();
  const [hostPort, instanceName] = raw.split('\\');
  const [server, portText] = hostPort.split(/[,:]/);
  const port = Number(env.SEMTEK_SQL_PORT || portText) || undefined;
  const pool = new sql.ConnectionPool({
    server, port: instanceName && !port ? undefined : port ?? 1433, database, user: env.SEMTEK_SQL_USER!, password: env.SEMTEK_SQL_PASS!,
    connectionTimeout: 30000, requestTimeout: 120000,
    options: { encrypt: false, trustServerCertificate: true, instanceName: instanceName || undefined },
  });
  return pool.connect();
}

export interface Discovery {
  version: string; database: string; databases: string[];
  tables: { name: string; rows: number; columns: string[] }[];
  views: string[];
  /** tables whose columns look like a payments breakdown (cash / cheque / card / vouchers / bacs) */
  likely: string[];
}

export async function discoverSemtek(): Promise<Discovery> {
  const pool = await semtekConnect();
  try {
    const info = (await pool.request().query(`select @@version as v, db_name() as db`)).recordset[0];
    const dbs = (await pool.request().query(`select name from sys.databases where database_id > 4 order by name`)).recordset.map((r: { name: string }) => r.name);
    const t = (await pool.request().query(`
      select s.name + '.' + t.name as name, sum(p.rows) as n
      from sys.tables t join sys.schemas s on s.schema_id = t.schema_id
      join sys.partitions p on p.object_id = t.object_id and p.index_id in (0, 1)
      group by s.name, t.name order by sum(p.rows) desc`)).recordset as { name: string; n: number }[];
    const cols = (await pool.request().query(`
      select TABLE_SCHEMA + '.' + TABLE_NAME as t, COLUMN_NAME + ' ' + DATA_TYPE as c
      from INFORMATION_SCHEMA.COLUMNS order by TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`)).recordset as { t: string; c: string }[];
    const v = (await pool.request().query(`select s.name + '.' + v.name as name from sys.views v join sys.schemas s on s.schema_id = v.schema_id order by 1`)).recordset.map((r: { name: string }) => r.name);
    const byTable = new Map<string, string[]>();
    for (const c of cols) { const l = byTable.get(c.t) ?? []; l.push(c.c); byTable.set(c.t, l); }
    const tables = t.map(x => ({ name: x.name, rows: Number(x.n), columns: byTable.get(x.name) ?? [] }));
    const payWords = [/cash/i, /cheque|check/i, /card/i, /voucher/i, /bacs/i];
    const likely = [...byTable.entries()].filter(([, cs]) => payWords.filter(w => cs.some(c => w.test(c))).length >= 3).map(([name]) => name);
    return { version: String(info.v).split('\n')[0], database: info.db, databases: dbs, tables, views: v, likely };
  } finally { await pool.close(); }
}

// ---------- reading sales the way the Semtek export shows them ----------

const stamp = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' '); // SQL datetimes come back as UTC = the till's wall clock
const s = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());
const n = (v: unknown) => round2(Number(v) || 0);

/** Raw Sales + Payments rows for [from, to] (only the payment columns; never card details or other customer data). */
export async function readSemtekRaw(from: string, to: string, createdSince?: string, floor?: string) {
  const pool = await semtekConnect();
  try {
    // IDs start with the moment they were keyed in (yyyymmddhhmmss…), so "created since" also catches back-dated lines
    const req = () => pool.request().input('f', sql.DateTime, new Date(from + 'T00:00:00Z')).input('t', sql.DateTime, new Date(to + 'T00:00:00Z'))
      .input('c', sql.NVarChar, createdSince ? createdSince.replace(/-/g, '') : '99999999').input('fl', sql.DateTime, new Date((floor ?? from) + 'T00:00:00Z'));
    const sales = (await req().query(`
      select s.SaleID, s.TillID, s.Date, s.Total, s.FinalTally, s.CashIn, s.Cash, s.Chq, s.CC, s.Vouchers, s.Coupons, s.Account, s.Waive, s.Paid, s.Change, s.Bacs, s.Notes,
             s.CustomerID, c.AccountNo, c.LastName, c.FirstName, c.Company, o.Operator, o.FirstName as OpFirst, o.LastName as OpLast
      from Sales s left join Customers c on c.CustomerID = s.CustomerID left join Operators o on o.OperatorID = s.OperatorID
      where s.Date < dateadd(day, 1, @t) and s.Date >= @fl and (s.Date >= @f or (s.SaleID like '20%' and s.SaleID >= @c))`)).recordset;
    const payments = (await req().query(`
      select p.PaymentID, p.Station, p.Date, p.Cash, p.Cheque, p.CreditCard, p.Vouchers, p.Coupons, p.Bacs, p.Amount, p.Notes,
             p.CustomerID, c.AccountNo, c.LastName, c.FirstName, c.Company, o.Operator, o.FirstName as OpFirst, o.LastName as OpLast
      from Payments p left join Customers c on c.CustomerID = p.CustomerID left join Operators o on o.OperatorID = p.OperatorID
      where p.Date < dateadd(day, 1, @t) and p.Date >= @fl and (p.Date >= @f or (p.PaymentID like '20%' and p.PaymentID >= @c))`)).recordset;
    return { sales, payments };
  } finally { await pool.close(); }
}

/** First guess at how the export builds each line; checked against imported files by compareSemtek. */
export function toRows(raw: Awaited<ReturnType<typeof readSemtekRaw>>): SemtekRow[] {
  const cust = (r: Record<string, unknown>) => ({ customer_id: s(r.CustomerID), account_no: s(r.AccountNo), last_name: s(r.LastName), first_name: s(r.FirstName), company: s(r.Company), operator: s(r.Operator) });
  const out: SemtekRow[] = [];
  for (const r of raw.sales) {
    const at = stamp(r.Date as Date), acc = n(r.Account);
    out.push({ sale_id: s(r.SaleID), type: 'Sale', txn_at: at, txn_date: at.slice(0, 10), station: s(r.TillID), ...cust(r),
      cash: n(r.Cash), cheque: n(r.Chq), credit_card: n(r.CC), vouchers: n(r.Vouchers), coupons: n(r.Coupons), bacs: n(r.Bacs),
      account: acc, on_account: acc > 0 ? acc : 0, off_account: acc < 0 ? acc : 0, amount: n(r.FinalTally), notes: s(r.Notes) });
  }
  for (const r of raw.payments) {
    const at = stamp(r.Date as Date), amt = n(r.Amount);
    out.push({ sale_id: s(r.PaymentID), type: 'Payment', txn_at: at, txn_date: at.slice(0, 10), station: s(r.Station), ...cust(r),
      cash: n(r.Cash), cheque: n(r.Cheque), credit_card: n(r.CreditCard), vouchers: n(r.Vouchers), coupons: n(r.Coupons), bacs: n(r.Bacs),
      account: -amt, on_account: 0, off_account: amt, amount: amt, notes: s(r.Notes) });
  }
  return out;
}

const FIELDS = ['type', 'txn_at', 'station', 'operator', 'customer_id', 'account_no', 'last_name', 'first_name', 'company', 'cash', 'cheque', 'credit_card', 'vouchers', 'coupons', 'bacs', 'account', 'on_account', 'off_account', 'amount', 'notes'] as const;

/** Compare database lines with the lines already imported from Semtek files, field by field. */
export async function compareSemtek(from: string, to: string) {
  const raw = await readSemtekRaw(from, to);
  const rows = toRows(raw);
  const app = await all((a, b) => supabase.from('semtek_lines').select('*').gte('txn_date', from).lte('txn_date', to).range(a, b)) as Record<string, unknown>[];
  const key = (id: unknown, type: unknown) => `${s(id)}|${s(type)}`;
  const appById = new Map(app.map(r => [key(r.sale_id, r.type), r]));
  const dbById = new Map(rows.map(r => [key(r.sale_id, r.type), r]));
  const rawById = new Map<string, Record<string, unknown>>([...raw.sales.map(r => [key(r.SaleID, 'Sale'), r] as const), ...raw.payments.map(r => [key(r.PaymentID, 'Payment'), r] as const)]);
  const norm = (f: string, v: unknown) => (f === 'txn_at' ? s(v).replace('T', ' ').slice(0, 19) : s(v).replace(/\r\n/g, '\n'));
  const mism: Record<string, number> = {}; const examples: Record<string, unknown[]> = {};
  let same = 0;
  for (const r of rows) {
    const a = appById.get(key(r.sale_id, r.type)); if (!a) continue;
    let ok = true;
    for (const f of FIELDS) {
      const dv = r[f], av = a[f];
      const eq = typeof dv === 'number' ? Math.abs(dv - Number(av)) < 0.005 : norm(f, dv) === norm(f, av);
      if (!eq) {
        ok = false; mism[f] = (mism[f] ?? 0) + 1;
        const ex = (examples[f] ??= []);
        if (ex.length < 6) { const rw = { ...rawById.get(key(r.sale_id, r.type)) }; delete rw.LastName; delete rw.FirstName; ex.push({ id: r.sale_id, type: r.type, db: dv, app: av, raw: rw }); }
      }
    }
    if (ok) same++;
  }
  const onlyDb = rows.filter(r => !appById.has(key(r.sale_id, r.type)));
  const onlyApp = app.filter(r => !dbById.has(key(r.sale_id, r.type)));
  return {
    from, to, db_lines: rows.length, app_lines: app.length, both: rows.length - onlyDb.length, identical: same, mismatches: mism, examples,
    only_in_db: { count: onlyDb.length, sample: onlyDb.slice(0, 8).map(r => ({ id: r.sale_id, type: r.type, at: r.txn_at, amount: r.amount })) },
    only_in_app: { count: onlyApp.length, sample: onlyApp.slice(0, 8).map(r => ({ id: r.sale_id, type: r.type, at: r.txn_at, amount: r.amount, voided: r.voided })) },
  };
}

// ---------- network check (recorded in the run log when the connection fails) ----------

const sh = (cmd: string) => { try { return execSync(cmd, { timeout: 20000, encoding: 'utf8' }).trim(); } catch (e) { return `FAILED: ${String((e as { stdout?: string }).stdout ?? '').trim() || (e as Error).message.split('\n')[0]}`; } };

/** Ask SQL Server Browser (UDP 1434) which TCP port an instance listens on. */
function browserPort(host: string, instance: string): Promise<string> {
  return new Promise(resolve => {
    const sock = dgram.createSocket('udp4');
    const t = setTimeout(() => { sock.close(); resolve('no answer from SQL Browser on UDP 1434'); }, 8000);
    sock.on('message', m => { clearTimeout(t); sock.close(); const txt = m.subarray(3).toString('ascii'); const block = txt.split(';;').find(b => b.toUpperCase().includes(`INSTANCENAME;${instance.toUpperCase()};`)) ?? txt; resolve(block); });
    sock.send(Buffer.from([0x03]), 1434, host);
  });
}
const tcpOpen = (host: string, port: number) => new Promise<string>(resolve => {
  const c = net.connect({ host, port, timeout: 8000 }, () => { c.destroy(); resolve('open'); });
  c.on('timeout', () => { c.destroy(); resolve('timeout'); }); c.on('error', e => resolve(`error: ${e.message}`));
});

export async function networkCheck() {
  const raw = env.SEMTEK_SQL_HOST!.trim();
  const [hostPort, instance] = raw.split('\\');
  const host = hostPort.split(/[,:]/)[0];
  const out: Record<string, unknown> = {
    robot_zt: sh('sudo zerotier-cli info'),
    networks: sh('sudo zerotier-cli listnetworks'),
    ping: sh(`ping -c 3 -W 2 ${host} | tail -2`),
    peers_direct: sh(`sudo zerotier-cli peers | grep -c DIRECT`),
  };
  if (instance) {
    const b = await browserPort(host, instance);
    out.sql_browser = b;
    const m = /tcp;(\d+)/i.exec(b);
    if (m) out[`tcp_${m[1]}`] = await tcpOpen(host, Number(m[1]));
  }
  out.tcp_1433 = await tcpOpen(host, 1433);
  return out;
}

// ---------- the nightly Semtek download ----------

/**
 * Add Semtek lines that aren't in the app yet. Never changes a line that is already there (your adjustments stay).
 * Reads the last 60 days by sale date, plus anything keyed in during the last 14 days but dated earlier,
 * and never goes back before the first day the app holds Semtek for (so deleted older history isn't brought back).
 */
export async function pullSemtek(yesterday: string): Promise<PullResult & { manual_matches?: unknown[] }> {
  const base = { source: 'semtek', label: 'Semtek', added: 0, updated: 0, seen: 0 };
  const firstImp = await q(supabase.from('import_files').select('date_from').eq('source', 'semtek').eq('voided', false).order('date_from').limit(1)) as { date_from: string }[];
  const floor = firstImp[0]?.date_from ?? addDays(yesterday, -59);
  const from = addDays(yesterday, -59) > floor ? addDays(yesterday, -59) : floor;
  const raw = await readSemtekRaw(from, yesterday, addDays(yesterday, -13), floor);
  const rows = toRows(raw);
  const lo = rows.reduce((m, r) => (r.txn_date < m ? r.txn_date : m), from);
  const app = await all((a, b) => supabase.from('semtek_lines').select('sale_id,type,txn_date,amount,manual,voided').gte('txn_date', lo).range(a, b)) as { sale_id: string; type: string; txn_date: string; amount: number; manual: boolean; voided: boolean }[];
  const have = new Set(app.map(r => `${r.sale_id}|${r.type}`));
  const manual = app.filter(r => r.manual && !r.voided);
  const fresh: SemtekRow[] = []; const manualMatches: unknown[] = [];
  for (const r of rows) {
    if (have.has(`${r.sale_id}|${r.type}`)) continue;
    // a line you added by hand for this one: don't add it twice
    const i = manual.findIndex(m => m.type === r.type && m.txn_date === r.txn_date && Math.abs(Number(m.amount) - r.amount) < 0.005);
    if (i >= 0) { manual.splice(i, 1); manualMatches.push({ id: r.sale_id, type: r.type, date: r.txn_date, amount: r.amount }); continue; }
    fresh.push(r);
  }
  const imp = await q(supabase.from('import_files').insert({
    source: 'semtek', filename: 'Nightly pull (Semtek database)', rows_in_file: rows.length, rows_added: fresh.length, rows_duplicate: rows.length - fresh.length, date_from: from, date_to: yesterday,
  }).select('id').single()) as { id: string };
  for (let i = 0; i < fresh.length; i += 500)
    await q(supabase.from('semtek_lines').upsert(fresh.slice(i, i + 500).map(r => ({ ...r, import_id: imp.id })), { onConflict: 'sale_id,type', ignoreDuplicates: true }));
  const backdated = fresh.filter(r => r.txn_date < addDays(yesterday, -1)).length;
  return { ...base, ok: true, from, to: yesterday, added: fresh.length, seen: rows.length, manual_matches: manualMatches,
    message: `${fresh.length} new line${fresh.length === 1 ? '' : 's'}${backdated ? ` (${backdated} dated earlier than yesterday)` : ''}${manualMatches.length ? `, ${manualMatches.length} skipped because you'd added them by hand` : ''}.` };
}
