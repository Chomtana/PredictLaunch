import { big, LaunchStatus, n, OutcomeCode, poolOf, progressOf, type LaunchSummary } from '../lib/api.ts'
import { asset, duration, settleLabel } from '../lib/format.ts'
import { fmtBnb, fmtPrice, usd } from '../lib/units.ts'
import { useApp } from '../state.tsx'
import { AssetBadge, CoinAvatar, ProgressBar } from './ui.tsx'

export type Phase = 'live' | 'settling' | 'graduating' | 'graduated' | 'failed' | 'void'

export function phaseOf(l: Pick<LaunchSummary, 'status' | 'settleTime' | 'outcome' | 'resolved'>, now: number): Phase {
  const st = n(l.status)
  if (st === LaunchStatus.Graduated) return 'graduated'
  if (st === LaunchStatus.Graduating) return 'graduating'
  if (st === LaunchStatus.Failed) return l.resolved && n(l.outcome) === OutcomeCode.Void ? 'void' : 'failed'
  return now < n(l.settleTime) ? 'live' : 'settling'
}

export const PHASE_LABEL: Record<Phase, string> = {
  live: 'Live',
  settling: 'Settling',
  graduating: 'Launching',
  graduated: 'Graduated',
  failed: 'Failed',
  void: 'Void',
}

export function StatusChip({ phase }: { phase: Phase }) {
  return (
    <span className={`chip-status ${phase}`}>
      {phase === 'live' && <i className="live-dot" />}
      {PHASE_LABEL[phase]}
    </span>
  )
}

/** "BTC ≥ $100,000 by Nov 26 12:00" */
export function questionShort(l: LaunchSummary, feedSym: string) {
  return `${asset(feedSym)} ≥ ${fmtPrice(l.strike)} by ${settleLabel(n(l.settleTime))}`
}

export function LaunchCard({ l, now }: { l: LaunchSummary; now: number }) {
  const { feedSymbol, bnbUsd, priceOf } = useApp()
  const sym = feedSymbol(l.feed)
  const phase = phaseOf(l, now)
  const pool = poolOf(l)
  const prog = progressOf(l)
  const up = l.upPrice
  const cur = priceOf(l.feed)
  const above = cur != null ? cur >= big(l.strike) : null
  const left = n(l.settleTime) - now
  return (
    <a className={`panel launch-card ${phase}`} href={`#/launch/${l.id}`}>
      <div className="lc-head">
        <CoinAvatar name={l.name} image={l.imageURI} size={52} />
        <div className="lc-title">
          <div className="lc-name">{l.name}</div>
          <div className="muted mono small">${l.symbol}</div>
        </div>
        <StatusChip phase={phase} />
      </div>

      <div className="lc-question">
        <AssetBadge asset={asset(sym)} />
        <span>{questionShort(l, sym)}</span>
      </div>

      <div className="lc-odds">
        <div className="odds-bar">
          <div className="odds-up" style={{ width: `${up ?? 50}%` }} />
        </div>
        <div className="odds-labels">
          <span className="up">Up {up != null ? `${up}¢` : '—'}</span>
          {cur != null && (
            <span className={`muted small ${above ? 'up' : 'down'}`}>
              now {fmtPrice(cur)} {above ? '▲' : '▼'}
            </span>
          )}
          <span className="down">Down {up != null ? `${100 - up}¢` : '—'}</span>
        </div>
      </div>

      <div className="lc-progress">
        <div className="lc-progress-top">
          <span>
            <b className="mono">{fmtBnb(pool, 3)}</b> <span className="muted">/ {fmtBnb(l.target, 2)} BNB</span>
          </span>
          <span className="muted small">{usd(pool, bnbUsd)}</span>
        </div>
        <ProgressBar value={prog} glow={phase === 'graduated'} />
        <div className="lc-foot">
          <span className="cut-badge">{n(l.cutBps) / 100}% to launch</span>
          <span className="muted small">
            {phase === 'live' ? <>settles in {duration(left)}</> : phase === 'settling' ? 'settling…' : phase === 'graduated' ? 'trading on PancakeSwap' : PHASE_LABEL[phase]}
          </span>
        </div>
      </div>
    </a>
  )
}
