// Semtek: the till's SQL Server database, reached over ZeroTier during the GitHub run.
// "discover" reads only the layout; "compare" checks the database against lines already imported from Semtek files.
// Only payment columns are read (never card details or customer contact data).
import sql from 'mssql';
import { all, supabase } from '../src/lib/supabase';
import { round2, type SemtekRow } from '../src/lib/parsers';


const env = process.env;

export function semtekConfigured() { return !!(env.SEMTEK_SQL_HOST && env.SEMTEK_SQL_USER && env.SEMTEK_SQL_PASS); }

export async function semtekConnect(database = env.SEMTEK_SQL_DB || undefined) {
  // "10.147.17.5\SQLEXPRESS" = a named instance; "10.147.17.5" or "10.147.17.5,1433" = host and port
  const raw = env.SEMTEK_SQL_HOST!.trim();
  const [hostPort, instanceName] = raw.split('\\');
  const [server, portText] = hostPort.split(/[,:]/);
  const port = Number(env.SEMTEK_SQL_PORT || portText) || undefined;
  return sql.connect({
    server, port: instanceName && !port ? undefined : port ?? 1433, database, user: env.SEMTEK_SQL_USER!, password: env.SEMTEK_SQL_PASS!,
    connectionTimeout: 30000, requestTimeout: 120000,
    options: { encrypt: false, trustServerCertificate: true, instanceName: instanceName || undefined },
  });
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
export async function readSemtekRaw(from: string, to: string) {
  const pool = await semtekConnect();
  try {
    const req = () => pool.request().input('f', sql.DateTime, new Date(from + 'T00:00:00Z')).input('t', sql.DateTime, new Date(to + 'T00:00:00Z'));
    const sales = (await req().query(`
      select s.SaleID, s.TillID, s.Date, s.Total, s.FinalTally, s.CashIn, s.Cash, s.Chq, s.CC, s.Vouchers, s.Coupons, s.Account, s.Waive, s.Paid, s.Change, s.Bacs, s.Notes,
             s.CustomerID, c.AccountNo, c.LastName, c.FirstName, c.Company, o.Operator, o.FirstName as OpFirst, o.LastName as OpLast
      from Sales s left join Customers c on c.CustomerID = s.CustomerID left join Operators o on o.OperatorID = s.OperatorID
      where s.Date >= @f and s.Date < dateadd(day, 1, @t)`)).recordset;
    const payments = (await req().query(`
      select p.PaymentID, p.Station, p.Date, p.Cash, p.Cheque, p.CreditCard, p.Vouchers, p.Coupons, p.Bacs, p.Amount, p.Notes,
             p.CustomerID, c.AccountNo, c.LastName, c.FirstName, c.Company, o.Operator, o.FirstName as OpFirst, o.LastName as OpLast
      from Payments p left join Customers c on c.CustomerID = p.CustomerID left join Operators o on o.OperatorID = p.OperatorID
      where p.Date >= @f and p.Date < dateadd(day, 1, @t)`)).recordset;
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
  const appById = new Map(app.map(r => [String(r.sale_id), r]));
  const dbById = new Map(rows.map(r => [r.sale_id, r]));
  const rawById = new Map<string, Record<string, unknown>>([...raw.sales.map(r => [s(r.SaleID), r] as const), ...raw.payments.map(r => [s(r.PaymentID), r] as const)]);
  const mism: Record<string, number> = {}; const examples: Record<string, unknown[]> = {};
  let same = 0;
  for (const r of rows) {
    const a = appById.get(r.sale_id); if (!a) continue;
    let ok = true;
    for (const f of FIELDS) {
      const dv = r[f], av = a[f];
      const eq = typeof dv === 'number' ? Math.abs(dv - Number(av)) < 0.005 : s(dv) === s(av);
      if (!eq) {
        ok = false; mism[f] = (mism[f] ?? 0) + 1;
        const ex = (examples[f] ??= []);
        if (ex.length < 6) { const rw = { ...rawById.get(r.sale_id) }; delete rw.LastName; delete rw.FirstName; ex.push({ id: r.sale_id, type: r.type, db: dv, app: av, raw: rw }); }
      }
    }
    if (ok) same++;
  }
  const onlyDb = rows.filter(r => !appById.has(r.sale_id));
  const onlyApp = app.filter(r => !dbById.has(String(r.sale_id)));
  return {
    from, to, db_lines: rows.length, app_lines: app.length, both: rows.length - onlyDb.length, identical: same, mismatches: mism, examples,
    only_in_db: { count: onlyDb.length, sample: onlyDb.slice(0, 8).map(r => ({ id: r.sale_id, type: r.type, at: r.txn_at, amount: r.amount })) },
    only_in_app: { count: onlyApp.length, sample: onlyApp.slice(0, 8).map(r => ({ id: r.sale_id, type: r.type, at: r.txn_at, amount: r.amount, voided: r.voided })) },
  };
}
