// Semtek: the till's SQL Server database, reached over ZeroTier during the GitHub run.
// Step 1 (now): "discover" only reads the database's layout (table names, columns, row counts) so we can find the sales tables.
// No sales data is copied in this step.
import sql from 'mssql';

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
