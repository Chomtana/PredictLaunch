// Cournot oracle views for question launches.
//
// The UI never shows what the oracle answered before settlement: no probability, no evidence, no
// market price and no oracle mode (live/mock). Traders see the exact question and which Cournot market
// settles it; after settlement, the outcome.

import { n, toUnixSec, type CournotMarket, type LaunchOracle } from '../lib/api.ts'
import { duration, settleLabel } from '../lib/format.ts'
import { QUESTION_LABELS, outcomeName } from '../lib/labels.ts'

export function MarketRow({ m, on, onPick }: { m: CournotMarket; on: boolean; onPick: () => void }) {
  const end = toUnixSec(m.endTime)
  return (
    <label className={`cn-market ${on ? 'on' : ''}`}>
      <input type="radio" name="cn-market" checked={on} onChange={onPick} />
      <div className="cn-market-body">
        <div className="cn-market-title">{m.title}</div>
        <div className="muted small">ends {Number.isFinite(end) ? settleLabel(end) : '—'}</div>
      </div>
    </label>
  )
}

/** The linked market's title from the opening record (`market_info` as Cournot sent it), if any. */
function marketTitle(oracle: LaunchOracle | null): string | null {
  const m = oracle?.opening?.market
  const t = m && typeof m === 'object' ? (m as Record<string, unknown>).title : null
  return typeof t === 'string' && t ? t : null
}

/** Launch page, in place of the price chart: the exact question and the Cournot market that settles it. */
export function CournotPanel({ question, oracle }: { question: string; oracle: LaunchOracle | null }) {
  const market = marketTitle(oracle)
  return (
    <div className="panel section cn-panel" data-testid="cournot-panel">
      <div className="cn-panel-head">
        <h3>Resolved by Cournot</h3>
      </div>
      <div className="cn-claim">
        <div className="muted small">Exact question</div>
        <q>{oracle?.opening?.claim ?? question}</q>
      </div>
      {market && (
        <div className="cn-kv">
          <span className="muted">Cournot market</span>
          <span>{market}</span>
        </div>
      )}
      <div className="muted small">
        YES pays out if Cournot resolves the question YES at settlement, NO otherwise. The oracle's answer is
        not shown before then.
      </div>
    </div>
  )
}

const qName = (o: number) => (o === 2 ? 'VOID' : outcomeName(QUESTION_LABELS, o))

/** Settlement: proposal status, outcome, challenge countdown, evidence hash. */
export function SettlementPanel({ oracle, settleTime, now, resolved, outcome }: {
  oracle: LaunchOracle | null
  settleTime: number
  now: number
  resolved: boolean
  outcome: number
}) {
  const pr = oracle?.proposal ?? null
  const ends = pr ? toUnixSec(pr.challengeEndsAt) : NaN
  const left = Number.isFinite(ends) ? ends - now : 0
  let status: string
  if (resolved) status = `Resolved ${qName(outcome)}`
  else if (!pr?.proposed) status = now < settleTime ? `Settles ${settleLabel(settleTime)}` : 'Awaiting a resolver proposal'
  else if (pr.final) status = 'Final (owner override): resolving'
  else if (left > 0) status = 'Proposed: challenge window open'
  else status = 'Proposed: challenge window over, resolving'
  const proposed = pr?.proposed ? n(pr.outcome) : null
  const at = pr ? toUnixSec(pr.proposedAt) : NaN
  return (
    <div className="panel section cn-settle" data-testid="settlement-panel">
      <h3>Settlement</h3>
      <div className="cn-kv">
        <span className="muted">Status</span>
        <b>{status}</b>
      </div>
      {proposed != null && (
        <div className="cn-kv">
          <span className="muted">Proposed outcome</span>
          <b className={proposed === 0 ? 'up' : proposed === 1 ? 'down' : ''}>{qName(proposed)}</b>
        </div>
      )}
      {pr?.proposed && Number.isFinite(at) && (
        <div className="cn-kv">
          <span className="muted">Proposed at</span>
          <span>{settleLabel(at)}</span>
        </div>
      )}
      {pr?.proposed && !pr.final && !resolved && (
        <div className="cn-kv">
          <span className="muted">Challenge window</span>
          <b className="mono" data-testid="challenge-countdown">
            {left > 0 ? `${duration(left)} left` : 'closed'}
          </b>
        </div>
      )}
      {pr?.proposed && (
        <div className="cn-kv">
          <span className="muted">Evidence hash</span>
          <code className="mono small cn-hash">{pr.evidenceHash}</code>
        </div>
      )}
      {!pr?.proposed && !resolved && now >= settleTime && <div className="muted small">Waiting for Cournot's answer.</div>}
    </div>
  )
}
