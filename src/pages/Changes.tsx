import { useState } from 'react';
import { q, supabase } from '../lib/supabase';
import { fmtStamp } from '../lib/format';
import { PageHead, useLoad, Loading, ErrorBox, Empty, changedKeys, showVal } from '../components/ui';

const TABLE_LABEL: Record<string, string> = {
  semtek_lines: 'Semtek line', card_txns: 'Card transaction', bacs_lines: 'BACS line', counts: 'Count', floats: 'Float', entries: 'Entry',
  cheques: 'Cheque', voucher_lots: 'Vouchers', postings: 'Posting', bankings: 'Banking', fees: 'Fee', settings: 'Setting', categories: 'Category',
  opening_balances: 'Opening balance', import_files: 'Import', app_users: 'User',
};
type Audit = { id: number; table_name: string; row_id: string; action: string; reason: string; old_row: Record<string, unknown>; new_row: Record<string, unknown>; at: string; user_email: string | null };

const describe = (a: Audit) => {
  const r = a.new_row;
  if (r.ref) return `#${r.ref}`;
  if (a.table_name === 'semtek_lines') return `${r.txn_date} ${r.last_name ?? ''}`;
  if (a.table_name === 'card_txns') return `${r.txn_date} ${r.merchant} £${r.amount}`;
  if (a.table_name === 'cheques') return `${r.payer ?? ''} £${r.amount}`;
  if (a.table_name === 'categories') return String(r.name);
  if (a.table_name === 'settings') return String(r.label ?? r.key);
  return String(r.txn_date ?? r.received_date ?? '');
};

export default function ChangesPage() {
  const [table, setTable] = useState('');
  const [limit, setLimit] = useState(100);
  const { data, error, loading } = useLoad(() => {
    let qy = supabase.from('audit_log').select('*').order('at', { ascending: false }).limit(limit);
    if (table) qy = qy.eq('table_name', table);
    return q(qy) as Promise<Audit[]>;
  }, [table, limit]);
  return (
    <>
      <PageHead title="Change history" sub="Every change and void, newest first, with the reason given and the figures before and after.">
        <select id="chg-table" value={table} onChange={e => setTable(e.target.value)}><option value="">Everything</option>{Object.entries(TABLE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}s</option>)}</select>
      </PageHead>
      {loading ? <Loading /> : error ? <ErrorBox error={error} /> : !data?.length ? <Empty>No changes recorded yet.</Empty> : (
        <section className="card flush"><div className="table-wrap"><table>
          <thead><tr><th>When</th><th>By</th><th>What</th><th>Reason</th><th>Change</th></tr></thead>
          <tbody>{data.map(a => (
            <tr key={a.id}><td className="nowrap small">{fmtStamp(a.at)}</td><td className="small">{a.user_email ?? 'system'}</td>
              <td>{TABLE_LABEL[a.table_name] ?? a.table_name} <span className="muted small">{describe(a)}</span>{a.action === 'void' && <span className="chip short">voided</span>}</td>
              <td className="wrap">{a.reason}</td>
              <td className="small">{changedKeys(a.old_row, a.new_row).map(k => <div key={k}><span className="muted">{k.replace(/_/g, ' ')}:</span> <span className="old">{showVal(a.old_row[k])}</span> → {showVal(a.new_row[k])}</div>)}</td></tr>
          ))}</tbody>
        </table></div>
        {data.length === limit && <div className="row end pad"><button className="ghost" onClick={() => setLimit(l => l + 200)}>Show more</button></div>}
        </section>
      )}
    </>
  );
}
