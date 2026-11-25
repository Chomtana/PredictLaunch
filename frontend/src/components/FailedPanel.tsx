import { fmtBnb } from '../lib/units.ts'
import { useQuote } from '../state.tsx'

export function FailedPanel({ isVoid, outcome, raised, target }: { isVoid: boolean; outcome: number; raised: bigint; target: bigint }) {
  const { symbol: q } = useQuote()
  return (
    <div className="panel state-panel failed">
      {isVoid ? (
        <>
          <h2>Market voided</h2>
          <div>No settlement price: everyone redeemed at 0.50.</div>
          <div className="muted small">The oracle had no update inside the settlement window, so every Up and Down share paid 0.50 {q}. No coin launched.</div>
        </>
      ) : (
        <>
          <h2>
            Settled <span className={outcome === 0 ? 'up' : 'down'}>{outcome === 0 ? 'Up ▲' : 'Down ▼'}</span> · no launch
          </h2>
          <div>Target not reached: winners were paid in full.</div>
          <div className="muted small">
            The pool would have been {fmtBnb(raised, 3)} of {fmtBnb(target, 2)} {q}. Without a launch nothing is held back: every winning share paid 1.00 {q}
            to your trading balance.
          </div>
        </>
      )}
    </div>
  )
}
