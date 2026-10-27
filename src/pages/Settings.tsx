import { useState } from 'react';
import { q, rpc, supabase } from '../lib/supabase';
import { loadCategories, loadSettings, type Category } from '../lib/data';
import { ACCOUNTS, ACCOUNT_LABEL, fmtDate, money, today } from '../lib/format';
import { PageHead, useLoad, useToast, Loading, ErrorBox, EditDialog, ReasonDialog, Modal } from '../components/ui';

const AMOUNT_ACCOUNTS = ACCOUNTS.filter(a => !/^(cheques|vouchers)_/.test(a));
const ITEM_ACCOUNTS = ['cheques_office', 'cheques_posted', 'vouchers_office', 'vouchers_posted'];

/** Opening cheques/vouchers are saved as items (posted ones inside an opening posting) so they can be posted and banked. */
async function addOpeningItem(account: string, date: string, amount: number, d: { payer: string; cheque_no: string; bank: string }, voucherFeePct: number) {
  const isCheque = account.startsWith('cheques');
  const row = isCheque
    ? await q(supabase.from('cheques').insert({ received_date: date, payer: d.payer || 'Opening balance', cheque_no: d.cheque_no || null, bank: d.bank || null, amount, against_pos: false, opening: true }).select('id').single()) as { id: string }
    : await q(supabase.from('voucher_lots').insert({ received_date: date, amount, against_pos: false, opening: true }).select('id').single()) as { id: string };
  if (account.endsWith('_posted')) {
    await rpc('create_posting', { p_kind: isCheque ? 'cheque' : 'voucher', p_date: date, p_fee_fixed: 0, p_fee_pct: isCheque ? 0 : voucherFeePct, p_note: 'Opening balance', p_items: [row.id] });
  }
}
type Opening = { id: string; account: string; as_of: string; amount: number; created_at: string; updated_at: string };

export default function SettingsPage() {
  const toast = useToast();
  const settings = useLoad(loadSettings, []);
  const cats = useLoad(loadCategories, []);
  const opening = useLoad(() => q(supabase.from('opening_balances').select('*').eq('voided', false)) as Promise<Opening[]>, []);
  const [editSetting, setEditSetting] = useState<{ id: string; key: string; value: unknown; label: string } | null>(null);
  const [editCat, setEditCat] = useState<Category | null>(null); const [retire, setRetire] = useState<Category | null>(null);
  const [newCat, setNewCat] = useState<{ name: string; direction: 'in' | 'out'; against_pos_default: boolean } | null>(null);
  const [editOpen, setEditOpen] = useState<Opening | null>(null);
  const [newOpen, setNewOpen] = useState<{ account: string; as_of: string; amount: string; payer: string; cheque_no: string; bank: string } | null>(null);
  const [itemsKey, setItemsKey] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  return (
    <>
      <PageHead title="Settings" />
      <section className="card">
        <h2>Fees and defaults</h2>
        {settings.loading ? <Loading /> : settings.error ? <ErrorBox error={settings.error} /> : (
          <table className="ledger"><tbody>{settings.data!.rows.map(s => (
            <tr key={s.id}><td>{s.label}</td><td className="r num">{String(s.value)}</td><td className="r"><button className="ghost small" onClick={() => setEditSetting(s)}>Change</button></td></tr>
          ))}</tbody></table>
        )}
      </section>

      <section className="card">
        <div className="row between"><h2>Categories</h2><button className="ghost" onClick={() => setNewCat({ name: '', direction: 'in', against_pos_default: false })}>+ Add category</button></div>
        {cats.loading ? <Loading /> : cats.error ? <ErrorBox error={cats.error} /> : (
          <div className="grid2">
            {(['in', 'out'] as const).map(d => (
              <div key={d}><h3>{d === 'in' ? 'Money received' : 'Money spent'}</h3>
                <table className="ledger"><tbody>{cats.data!.filter(c => c.direction === d && !c.voided).map(c => (
                  <tr key={c.id}><td>{c.name}{c.against_pos_default && <span className="muted small"> · counts against Semtek</span>}</td>
                    <td className="r nowrap">{!c.system_key && <><button className="ghost small" onClick={() => setEditCat(c)}>Rename</button><button className="ghost small" onClick={() => setRetire(c)}>Retire</button></>}</td></tr>
                ))}</tbody></table>
              </div>
            ))}
          </div>
        )}
        <p className="small muted">Floats are handled on the Floats page, not as a spending category, so they never count as an expense.</p>
      </section>

      <section className="card">
        <div className="row between"><h2>Opening balances</h2><button className="ghost" onClick={() => setNewOpen({ account: AMOUNT_ACCOUNTS.find(a => !opening.data?.some(o => o.account === a)) ?? 'cheques_office', as_of: today(), amount: '', payer: '', cheque_no: '', bank: '' })}>+ Add opening balance</button></div>
        <p className="small muted">What was in each place on the day you start using the app. Cheques and vouchers are kept as items (listed under Opening cheques and vouchers) so you can post and bank them.</p>
        {opening.loading ? <Loading /> : opening.error ? <ErrorBox error={opening.error} /> : !opening.data?.length ? <p className="muted">No opening balances yet.</p> : (
          <table className="ledger"><tbody>{opening.data.map(o => (
            <tr key={o.id}><td>{ACCOUNT_LABEL[o.account]}</td><td className="muted small">{fmtDate(o.as_of)}</td><td className="r num">{money(o.amount)}</td><td className="r"><button className="ghost small" onClick={() => setEditOpen(o)}>Adjust</button></td></tr>
          ))}</tbody></table>
        )}
      </section>

      <OpeningItems key={itemsKey} />

      {editSetting && <EditDialog table="settings" row={{ ...editSetting, value: String(editSetting.value) }} title={editSetting.label} onClose={() => setEditSetting(null)}
        fields={[{ key: 'value', label: editSetting.label, type: 'number' }]} onSaved={() => { setEditSetting(null); settings.reload(); }} />}
      {editCat && <EditDialog table="categories" row={editCat as unknown as Record<string, unknown>} title="Rename category" onClose={() => setEditCat(null)} onSaved={() => { setEditCat(null); cats.reload(); }}
        fields={[{ key: 'name', label: 'Name', type: 'text' }, ...(editCat.direction === 'in' ? [{ key: 'against_pos_default', label: 'Counts against Semtek by default', type: 'bool' } as const] : [])]} />}
      {retire && <ReasonDialog title={`Retire “${retire.name}”`} confirm="Retire" onCancel={() => setRetire(null)} prompt="It will no longer be offered for new entries. Past entries keep it."
        onConfirm={async reason => { await q(supabase.from('categories').update({ voided: true, change_reason: reason }).eq('id', retire.id)); setRetire(null); cats.reload(); toast('Category retired.'); }} />}
      {newCat && <Modal title="Add category" onClose={() => setNewCat(null)}>
        <div className="stack">
          <label className="field"><span>Name</span><input id="nc-name" value={newCat.name} onChange={e => setNewCat({ ...newCat, name: e.target.value })} /></label>
          <label className="field"><span>For</span><select id="nc-dir" value={newCat.direction} onChange={e => setNewCat({ ...newCat, direction: e.target.value as 'in' | 'out' })}><option value="in">Money received</option><option value="out">Money spent</option></select></label>
          {newCat.direction === 'in' && <label className="check"><input type="checkbox" checked={newCat.against_pos_default} onChange={e => setNewCat({ ...newCat, against_pos_default: e.target.checked })} /> Usually goes through Semtek</label>}
          {err && <ErrorBox error={err} />}
          <div className="row end"><button className="ghost" onClick={() => setNewCat(null)}>Cancel</button>
            <button className="primary" disabled={!newCat.name.trim()} onClick={async () => { try { await q(supabase.from('categories').insert({ ...newCat, name: newCat.name.trim() })); setNewCat(null); setErr(null); cats.reload(); toast('Category added.'); } catch (e) { setErr(String((e as Error).message)); } }}>Add</button></div>
        </div>
      </Modal>}
      {editOpen && <EditDialog table="opening_balances" row={editOpen} title={`Opening balance – ${ACCOUNT_LABEL[editOpen.account]}`} onClose={() => setEditOpen(null)} onSaved={() => { setEditOpen(null); opening.reload(); }}
        fields={[{ key: 'as_of', label: 'As of', type: 'date' }, { key: 'amount', label: 'Amount £', type: 'number' }]} />}
      {newOpen && <Modal title="Add opening balance" onClose={() => setNewOpen(null)}>
        <div className="stack">
          <label className="field"><span>Account</span><select id="no-acct" value={newOpen.account} onChange={e => setNewOpen({ ...newOpen, account: e.target.value })}>
            {ACCOUNTS.filter(a => ITEM_ACCOUNTS.includes(a) || !opening.data?.some(o => o.account === a)).map(a => <option key={a} value={a}>{ACCOUNT_LABEL[a]}</option>)}</select></label>
          <label className="field"><span>As of</span><input id="no-date" type="date" value={newOpen.as_of} onChange={e => setNewOpen({ ...newOpen, as_of: e.target.value })} /></label>
          <label className="field"><span>Amount £</span><input id="no-amt" type="number" step="0.01" value={newOpen.amount} onChange={e => setNewOpen({ ...newOpen, amount: e.target.value })} /></label>
          {newOpen.account.startsWith('cheques') && <div className="grid3">
            <label className="field"><span>Name on cheque</span><input id="no-payer" value={newOpen.payer} onChange={e => setNewOpen({ ...newOpen, payer: e.target.value })} placeholder="Blank = a total" /></label>
            <label className="field"><span>Cheque no.</span><input id="no-chqno" value={newOpen.cheque_no} onChange={e => setNewOpen({ ...newOpen, cheque_no: e.target.value })} /></label>
            <label className="field"><span>Bank</span><input id="no-bank" value={newOpen.bank} onChange={e => setNewOpen({ ...newOpen, bank: e.target.value })} /></label>
          </div>}
          {ITEM_ACCOUNTS.includes(newOpen.account) && <p className="small muted">{newOpen.account.endsWith('_posted') ? 'Saved as already posted, so it waits on the Banking page.' : 'Saved as in the office, so it shows on the Posting page.'} You can add several, one at a time.</p>}
          {err && <ErrorBox error={err} />}
          <div className="row end"><button className="ghost" onClick={() => setNewOpen(null)}>Cancel</button>
            <button className="primary" disabled={newOpen.amount === ''} onClick={async () => { try {
              if (ITEM_ACCOUNTS.includes(newOpen.account)) {
                if (!(Number(newOpen.amount) > 0)) throw new Error('Enter an amount above £0.');
                await addOpeningItem(newOpen.account, newOpen.as_of, Number(newOpen.amount), newOpen, settings.data?.voucher_fee_pct ?? 1);
                setNewOpen({ ...newOpen, amount: '', payer: '', cheque_no: '', bank: '' }); setItemsKey(k => k + 1);
              } else {
                await q(supabase.from('opening_balances').insert({ account: newOpen.account, as_of: newOpen.as_of, amount: Number(newOpen.amount) })); setNewOpen(null); opening.reload();
              }
              setErr(null); toast('Opening balance saved.');
            } catch (e) { setErr(String((e as Error).message)); } }}>Save</button></div>
        </div>
      </Modal>}
    </>
  );
}

type OpenItem = { id: string; kind: 'cheque' | 'voucher'; date: string; payer: string | null; cheque_no: string | null; bank: string | null; amount: number; status: string };

/** Cheques and vouchers already in the office on the start date, kept as items so they can be posted and banked. */
function OpeningItems() {
  const toast = useToast();
  const list = useLoad(async () => {
    const [c, v] = await Promise.all([
      q(supabase.from('cheques').select('id,received_date,payer,cheque_no,bank,amount,status').eq('opening', true).eq('voided', false).order('received_date')) as Promise<{ id: string; received_date: string; payer: string | null; cheque_no: string | null; bank: string | null; amount: number; status: string }[]>,
      q(supabase.from('voucher_lots').select('id,received_date,amount,posting_id').eq('opening', true).eq('voided', false).order('received_date')) as Promise<{ id: string; received_date: string; amount: number; posting_id: string | null }[]>,
    ]);
    return [...c.map(x => ({ id: x.id, kind: 'cheque' as const, date: x.received_date, payer: x.payer, cheque_no: x.cheque_no, bank: x.bank, amount: Number(x.amount), status: x.status })),
      ...v.map(x => ({ id: x.id, kind: 'voucher' as const, date: x.received_date, payer: null, cheque_no: null, bank: null, amount: Number(x.amount), status: x.posting_id ? 'posted' : 'office' }))] as OpenItem[];
  }, []);
  const [voiding, setVoiding] = useState<OpenItem | null>(null);
  const tbl = (kind: 'cheque' | 'voucher') => (list.data ?? []).filter(i => i.kind === kind);
  return (
    <section className="card">
      <h2>Opening cheques and vouchers</h2>
      <p className="small muted">Added with “+ Add opening balance” above. They work like any other cheque or voucher and are left out of the Semtek comparison.</p>
      {list.loading ? <Loading /> : list.error ? <ErrorBox error={list.error} /> : !list.data?.length ? <p className="muted">None entered.</p> : (
        <table className="ledger"><tbody>
          {(['cheque', 'voucher'] as const).flatMap(k => tbl(k).map(i => (
            <tr key={i.id}><td>{k === 'cheque' ? `Cheque${i.payer ? ' – ' + i.payer : ''}${i.cheque_no ? ' #' + i.cheque_no : ''}` : 'Vouchers'}</td><td className="muted small">{fmtDate(i.date)}</td>
              <td><span className={`chip ${i.status === 'office' ? 'pending' : 'ok'}`}>{i.status === 'office' ? 'in office' : i.status}</span></td>
              <td className="r num">{money(i.amount)}</td>
              <td className="r">{i.status === 'office' && <button className="ghost small" onClick={() => setVoiding(i)}>Remove</button>}</td></tr>)))}
        </tbody></table>
      )}
      {voiding && <ReasonDialog title="Remove opening item" danger confirm="Remove" onCancel={() => setVoiding(null)} prompt={`${money(voiding.amount)} will be removed from the opening balance. It stays in the change history.`}
        onConfirm={async reason => { await q(supabase.from(voiding.kind === 'cheque' ? 'cheques' : 'voucher_lots').update({ voided: true, change_reason: reason }).eq('id', voiding.id)); setVoiding(null); list.reload(); toast('Removed.'); }} />}
    </section>
  );
}
