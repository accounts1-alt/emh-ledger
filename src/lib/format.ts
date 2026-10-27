export const money = (n: number | null | undefined, opts: { blankZero?: boolean; sign?: boolean } = {}) => {
  if (n === null || n === undefined || Number.isNaN(n)) return '–';
  const v = Math.round(Number(n) * 100) / 100;
  if (opts.blankZero && v === 0) return '';
  const s = Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (v < 0) return '−£' + s;
  return (opts.sign && v > 0 ? '+£' : '£') + s;
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const fmtDate = (iso: string | null | undefined, withDay = true) => {
  if (!iso) return '–';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const wd = DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${withDay ? wd + ' ' : ''}${d} ${MONTHS[m - 1]} ${y}`;
};
export const fmtShort = (iso: string) => { const [, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[m - 1]}`; };
export const fmtRange = (a: string, b: string) => (a === b ? fmtDate(a) : `${fmtDate(a)} – ${fmtDate(b)}`);
export const fmtStamp = (iso: string) => { const d = new Date(iso); return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); };
export const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export const ACCOUNT_LABEL: Record<string, string> = {
  cash: 'Office cash', float: 'Float at shop', cheques_office: 'Cheques in office', cheques_posted: 'Cheques posted',
  vouchers_office: 'Vouchers in office', vouchers_posted: 'Vouchers posted',
  paymentsense: 'Paymentsense', amex: 'Amex', stripe_shop: 'Stripe Shop', stripe_office: 'Stripe Office',
};
export const ACCOUNTS = Object.keys(ACCOUNT_LABEL);
export const MERCHANT_LABEL: Record<string, string> = { paymentsense: 'Paymentsense', amex: 'Amex', stripe_shop: 'Stripe Shop', stripe_office: 'Stripe Office' };
export const ENTRY_ACCOUNT_LABEL: Record<string, string> = {
  cash: 'Cash', cheque: 'Cheque', voucher: 'Voucher', paymentsense: 'Card – Paymentsense', amex: 'Card – Amex', stripe_shop: 'Card – Stripe Shop', stripe_office: 'Card – Stripe Office',
};
