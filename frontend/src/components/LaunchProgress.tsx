import { big, n, poolOf, progressOf, type LaunchSummary, type UserLaunch } from '../lib/api.ts'
import { compact } from '../lib/format.ts'
import { fmtShares, LOSER_SUPPLY, num18, usd, fmtAmt } from '../lib/units.ts'
import { ProgressBar } from './ui.tsx'
import { useQuote } from '../state.tsx'
import { labelsFor } from '../lib/labels.ts'

/** Tokens a loser gets: loserShares / totalLoserShares × 500M. */
export const tokensFor = (loserShares: bigint, totalLoserShares: bigint) =>
  totalLoserShares > 0n ? (loserShares * LOSER_SUPPLY) / totalLoserShares : 0n

/** Pool raised (or projected while live) vs target, plus the user's token estimate. */
export function LaunchProgress({
  l,
  quoteUsd,
  position,
  mine,
}: {
  l: LaunchSummary
  quoteUsd: bigint | null
  position: { up: bigint; down: bigint } | null
  mine: UserLaunch | null
}) {
  const { symbol: q } = useQuote()
  const pool = poolOf(l)
  const target = big(l.target)
  const prog = progressOf(l)
  const active = n(l.status) === 0
  const pairs = big(l.pairs)
  const cut = n(l.cutBps)
  const needPairs = cut > 0 && target > pool ? ((target - pool) * 10000n) / BigInt(cut) : 0n
  // While live, every open pair has one loser share; pairs = totalLoserShares at settlement.
  const total = active ? pairs : big(l.totalLoserShares)
  const est = (s: bigint) => compact(num18(tokensFor(s, total)))
  const [U, D] = labelsFor(l).names
  return (
    <div className="panel section">
      <h3>{active ? 'Projected pool' : 'Pool'}</h3>
      <div className="pool-big">
        <span className="v mono">{fmtAmt(pool, 3)} {q}</span>
        <span className="muted">of {fmtAmt(target, 2)} {q} target</span>
        <span className="muted small" style={{ marginLeft: 'auto' }}>
          {usd(pool, quoteUsd)}
        </span>
      </div>
      <ProgressBar value={prog} glow={prog >= 1} />
      <div className="muted small" style={{ marginTop: 8 }}>
        {active
          ? prog >= 1
            ? 'On track to graduate at settlement.'
            : `${fmtShares(needPairs)} more open pairs reach the target (${cut / 100}% of each settled pair goes to the pool).`
          : `${Math.round(prog * 100)}% of target`}
      </div>
      <div className="stat-grid">
        <div className="stat">
          <span className="k">Open pairs</span>
          <span className="v mono">{fmtShares(pairs)}</span>
        </div>
        <div className="stat">
          <span className="k">Cut to pool</span>
          <span className="v">{cut / 100}%</span>
        </div>
        <div className="stat">
          <span className="k">Loser tokens</span>
          <span className="v">500M</span>
        </div>
        <div className="stat">
          <span className="k">Opening price</span>
          <span className="v mono">{pool > 0n ? `${(num18(pool) / 5e8).toExponential(2)} ${q}` : '—'}</span>
        </div>
      </div>
      {mine && big(mine.loserShares) > 0n ? (
        <div className="banner info" style={{ marginTop: 14, marginBottom: 0 }}>
          Your loser shares: <b className="mono">{fmtShares(mine.loserShares)}</b> → ≈ <b>{est(big(mine.loserShares))}</b> ${l.symbol}
        </div>
      ) : active && position && (position.up > 0n || position.down > 0n) && total > 0n ? (
        <div className="banner info" style={{ marginTop: 14, marginBottom: 0 }}>
          If {U} loses, your {fmtShares(position.up)} {U} → ≈ {est(position.up)} ${l.symbol}. If {D} loses, your {fmtShares(position.down)} {D} → ≈{' '}
          {est(position.down)} ${l.symbol}.
        </div>
      ) : null}
    </div>
  )
}
