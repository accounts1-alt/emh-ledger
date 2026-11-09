import { useState } from 'react';
import { q, supabase } from '../lib/supabase';
import { fmtShort, money } from '../lib/format';
import { useLoad, useToast } from './ui';

type Field = { before: unknown; semtek: unknown; yours: unknown };
type Line = {
  id: string; sale_id: string; type: string; txn_date: string; amount: number; last_name: string | null; account_no: string | null;
  src: Record<string, unknown> | null; semtek_change: { seen: string; fields: Record<string, Field> } | null; semtek_missing_since: string | null;
};
const MONEY = new Set(['cash', 'cheque', 'credit_card', 'vouchers', 'coupons', 'bacs', 'account', 'on_account', 'off_account', 'amount']);
const LABEL: Record<string, string> = { txn_at: 'Time', txn_date: 'Date', station: 'Station', operator: 'Operator', customer_id: 'Customer', account_no: 'Account no', last_name: 'Name', first_name: 'First name', company: 'Company', cash: 'Cash', cheque: 'Cheque', credit_card: 'Card', vouchers: 'Vouchers', coupons: 'Coupons', bacs: 'BACS', account: 'Account', on_account: 'On account', off_account: 'Off account', amount: 'Amount', notes: 'Notes' };
const show = (f: string, v: unknown) => (MONEY.has(f) ? money(Number(v) || 0) : f === 'txn_date' ? fmtShort(String(v)) : String(v ?? '') || '–');
const who = (l: Line) => [l.last_name, l.account_no].filter(x => x && x !== '0').join(', ');

/** Lines the nightly robot found changed or deleted in Semtek that need your decision. Shows nothing when there are none. */
export function SemtekChanges() {
  const toast = useToast();
  const list = useLoad(async () => {
    const [changed, missing] = await Promise.all([
      q(supabase.from('semtek_lines').select('id,sale_id,type,txn_date,amount,last_name,account_no,src,semtek_change,semtek_missing_since').not('semtek_change', 'is', null).eq('voided', false).order('txn_date')),
      q(supabase.from('semtek_lines').select('id,sale_id,type,txn_date,amount,last_name,account_no,src,semtek_change,semtek_missing_since').not('semtek_missing_since', 'is', null).eq('semtek_missing_ack', false).eq('voided', false).order('txn_date')),
    ]) as [Line[], Line[]];
    return { changed, missing };
  }, []);
  const [busy, setBusy] = useState<string | null>(null);
  if (!list.data || (!list.data.changed.length && !list.data.missing.length)) return null;

  const act = async (l: Line, what: 'semtek' | 'mine' | 'void' | 'keep') => {
    setBusy(l.id);
    try {
      const fields = l.semtek_change?.fields ?? {};
      const semVals = Object.fromEntries(Object.entries(fields).map(([f, v]) => [f, v.semtek]));
      const src = { ...(l.src ?? {}), ...semVals };
      if (what === 'semtek') await q(supabase.from('semtek_lines').update({ ...semVals, src, semtek_change: null, change_reason: 'Changed in Semtek: took Semtek’s figures' }).eq('id', l.id));
      if (what === 'mine') await q(supabase.from('semtek_lines').update({ src, semtek_change: null }).eq('id', l.id));
      if (what === 'void') await q(supabase.from('semtek_lines').update({ voided: true, semtek_missing_since: null, change_reason: 'Deleted in Semtek' }).eq('id', l.id));
      if (what === 'keep') await q(supabase.from('semtek_lines').update({ semtek_missing_since: null, semtek_missing_ack: true }).eq('id', l.id));
      toast({ semtek: 'Semtek’s figures saved.', mine: 'Kept your figures.', void: 'Line voided.', keep: 'Line kept.' }[what]);
      list.reload();
    } catch (e) { toast(String((e as Error).message)); }
    setBusy(null);
  };

  const { changed, missing } = list.data;
  return (
    <section className="card span2">
      <h2>Changed in Semtek <span className="chip short">{changed.length + missing.length}</span></h2>
      {changed.length > 0 && <>
        <p className="small muted">Semtek changed these after you had adjusted them in the app. Your version is kept until you decide.</p>
        {changed.map(l => (
          <div key={l.id} className="sem-change">
            <div className="row between wrap-row"><strong>{l.type} · {fmtShort(l.txn_date)}{who(l) ? ` · ${who(l)}` : ''}</strong>
              <span className="nowrap"><button className="ghost small" disabled={busy === l.id} onClick={() => act(l, 'semtek')}>Use Semtek’s</button><button className="ghost small" disabled={busy === l.id} onClick={() => act(l, 'mine')}>Keep mine</button></span></div>
            <table className="ledger small"><thead><tr><th /><th className="r">Was in Semtek</th><th className="r">Semtek now</th><th className="r">Yours</th></tr></thead>
              <tbody>{Object.entries(l.semtek_change!.fields).map(([f, v]) => <tr key={f}><td>{LABEL[f] ?? f}</td><td className="r num muted">{show(f, v.before)}</td><td className="r num"><strong>{show(f, v.semtek)}</strong></td><td className="r num">{show(f, v.yours)}</td></tr>)}</tbody></table>
          </div>
        ))}
      </>}
      {missing.length > 0 && <>
        <p className="small muted">These are no longer in Semtek (deleted at the till since they were downloaded).</p>
        <table className="ledger"><tbody>{missing.map(l => (
          <tr key={l.id}><td>{l.type} · {fmtShort(l.txn_date)}{who(l) ? ` · ${who(l)}` : ''}<div className="muted small">ID {l.sale_id} · noticed {fmtShort(l.semtek_missing_since!)}</div></td>
            <td className="r num">{money(Number(l.amount))}</td>
            <td className="r nowrap"><button className="ghost small" disabled={busy === l.id} onClick={() => act(l, 'void')}>Void it</button><button className="ghost small" disabled={busy === l.id} onClick={() => act(l, 'keep')}>Keep it</button></td></tr>
        ))}</tbody></table>
      </>}
    </section>
  );
}
