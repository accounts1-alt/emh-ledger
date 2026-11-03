import { COINS, NOTES } from '../lib/denoms';
import { money, r2 } from '../lib/format';

export const DENOMS = [...COINS, ...NOTES];
export const DENOM_KEYS = DENOMS.map(([k]) => k);
export type Denoms = Record<string, string>;
export const emptyDenoms = (): Denoms => Object.fromEntries(DENOM_KEYS.map(k => [k, '']));
export const denomTotal = (d: Record<string, unknown>) => r2(DENOMS.reduce((s, [k, , v]) => s + (Number(d[k]) || 0) * v, 0));
export const denomInts = (d: Record<string, unknown>) => Object.fromEntries(DENOM_KEYS.map(k => [k, Math.max(0, Math.round(Number(d[k]) || 0))]));
export const denomsFrom = (r: Record<string, unknown>): Denoms => Object.fromEntries(DENOM_KEYS.map(k => [k, Number(r[k]) ? String(r[k]) : '']));

/** Coins and notes, each counted separately, in counting-machine order. */
export function CashInput({ value, onChange, idPrefix, compact }: { value: Denoms; onChange: (d: Denoms) => void; idPrefix: string; compact?: boolean }) {
  const set = (k: string, v: string) => onChange({ ...value, [k]: v });
  const coins = r2(COINS.reduce((s, [k, , v]) => s + (Number(value[k]) || 0) * v, 0));
  const notes = r2(NOTES.reduce((s, [k, , v]) => s + (Number(value[k]) || 0) * v, 0));
  return (
    <div className={`cash-input ${compact ? 'compact' : ''}`}>
      <div className="ci-group">
        <div className="ci-label">Coins <span className="muted">(number of each)</span></div>
        <div className="ci-row">
          {COINS.map(([k, l]) => (
            <label key={k} className="ci-cell"><span>{l}</span>
              <input id={`${idPrefix}-${k}`} type="number" min="0" inputMode="numeric" value={value[k] ?? ''} onChange={e => set(k, e.target.value)} /></label>
          ))}
          <div className="ci-sum"><span>Coins</span><strong className="num">{money(coins)}</strong></div>
        </div>
      </div>
      <div className="ci-group">
        <div className="ci-label">Notes <span className="muted">(number of each)</span></div>
        <div className="ci-row">
          {NOTES.map(([k, l]) => (
            <label key={k} className="ci-cell"><span>{l}</span>
              <input id={`${idPrefix}-${k}`} type="number" min="0" inputMode="numeric" value={value[k] ?? ''} onChange={e => set(k, e.target.value)} /></label>
          ))}
          <div className="ci-sum"><span>Notes</span><strong className="num">{money(notes)}</strong></div>
          <div className="ci-sum total"><span>Total</span><strong className="num">{money(coins + notes)}</strong></div>
        </div>
      </div>
    </div>
  );
}
