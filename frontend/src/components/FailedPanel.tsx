import { fmtBnb } from '../lib/units.ts'
import { useQuote } from '../state.tsx'
import { PRICE_LABELS, type OutcomeLabels } from '../lib/labels.ts'

export function FailedPanel({ isVoid, outcome, raised, target, labels = PRICE_LABELS }: { isVoid: boolean; outcome: number; raised: bigint; target: bigint; labels?: OutcomeLabels }) {
  const isQ = labels.kind === 'question'
  const { symbol: q } = useQuote()
  return (
    <div className="panel state-panel failed">
      {isVoid ? (
        <>
          <h2>Market voided</h2>
          <div>{isQ ? 'Resolved VOID' : 'No settlement price'}: everyone redeemed at 0.50.</div>
          <div className="muted small">
            {isQ ? 'The question resolved VOID (by proposal, owner override, or no proposal before the deadline)' : 'The oracle had no update inside the settlement window'}, so every{' '}
            {labels.names[0]} and {labels.names[1]} share paid 0.50 {q}. No coin launched.
          </div>
        </>
      ) : (
        <>
          <h2>
            Settled <span className={outcome === 0 ? 'up' : 'down'}>{labels.marks[outcome === 0 ? 0 : 1]}</span> · no launch
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
