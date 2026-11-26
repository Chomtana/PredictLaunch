import { asset, countdown, pad2, settleLabel } from '../lib/format.ts'
import { fmtPrice, fmtUsd, num18 } from '../lib/units.ts'
import type { Phase } from './LaunchCard.tsx'
import { AssetBadge, CoinAvatar, Spinner } from './ui.tsx'
import { StatusChip } from './LaunchCard.tsx'
import type { OracleSource } from '../lib/api.ts'
import { SourceBadge, pct } from './Cournot.tsx'

/** "Will BTC be ≥ $100,000 at Nov 26, 12:00?" */
export const question = (feedSym: string, strike: bigint, settleTime: number) => `Will ${asset(feedSym)} be ≥ ${fmtPrice(strike)} at ${settleLabel(settleTime)}?`

export function PriceHeader(p: {
  name: string
  symbol: string
  image: string
  feedSym: string
  strike: bigint
  current: bigint | null
  /** Oracle price (settles the market), shown under a Binance display price; null to hide. */
  oracle?: bigint | null
  settleTime: number
  settlePrice: bigint | null
  phase: Phase
  now: number
}) {
  const left = p.settleTime - p.now
  const cd = countdown(left)
  const shown = p.phase === 'live' ? p.current : (p.settlePrice ?? p.current)
  const delta = shown != null ? num18(shown) - num18(p.strike) : null
  const coin = asset(p.feedSym)
  return (
    <div className="price-header">
      <div className="ph-top">
        <CoinAvatar name={p.name} image={p.image} size={64} rounded={14} />
        <div className="ph-title">
          <h1>{question(p.feedSym, p.strike, p.settleTime)}</h1>
          <div className="ph-sub">
            <span>
              <b style={{ color: 'var(--text)' }}>{p.name}</b> <span className="mono">${p.symbol}</span>
            </span>
            <span>·</span>
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <AssetBadge asset={coin} size={16} /> {p.feedSym || coin} oracle
            </span>
            <StatusChip phase={p.phase} />
          </div>
        </div>
      </div>
      <div className="ph-stats">
        <div className="ph-stat">
          <div className="label">Price to beat</div>
          <div className="value num">{fmtPrice(p.strike)}</div>
        </div>
        <div className="ph-sep" />
        <div className="ph-stat current">
          <div className="label">
            {p.phase === 'live' || p.settlePrice == null ? 'Current price' : 'Settlement price'}
            {delta != null && (
              <span className={`ph-delta ${delta >= 0 ? 'up' : 'down'}`}>
                {delta >= 0 ? '▲' : '▼'} {fmtUsd(Math.abs(delta))}
              </span>
            )}
          </div>
          <div className="value num">{shown != null ? fmtPrice(shown) : '—'}</div>
          {p.phase === 'live' && p.oracle != null && (
            <div className="muted small" title="Live price is from Binance (display only). The market settles on the onchain oracle.">
              oracle {fmtPrice(p.oracle)}
            </div>
          )}
        </div>
        {p.phase === 'live' ? (
          <div className={`countdown ${left > 3600 ? 'calm' : ''}`} aria-label="Time to settlement">
            {cd.d > 0 && <CdPart n={cd.d} u="DAYS" />}
            {(cd.d > 0 || cd.h > 0) && <CdPart n={cd.h} u="HRS" />}
            <CdPart n={cd.m} u="MIN" />
            {cd.d === 0 && <CdPart n={cd.s} u="SECS" />}
          </div>
        ) : p.phase === 'settling' ? (
          <div className="settling-note">
            <Spinner /> Settling…
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** Header for a question launch: the question as the title, YES on the book vs the Cournot opening, countdown. */
export function QuestionHeader(p: {
  name: string
  symbol: string
  image: string
  question: string
  settleTime: number
  phase: Phase
  now: number
  /** YES mid on the book, cents */
  yesMid: number | null
  probability: number | null
  source: OracleSource | null
}) {
  const left = p.settleTime - p.now
  const cd = countdown(left)
  return (
    <div className="price-header">
      <div className="ph-top">
        <CoinAvatar name={p.name} image={p.image} size={64} rounded={14} />
        <div className="ph-title">
          <h1>{p.question}</h1>
          <div className="ph-sub">
            <span>
              <b style={{ color: 'var(--text)' }}>{p.name}</b> <span className="mono">${p.symbol}</span>
            </span>
            <span>·</span>
            <span>Cournot question · settles {settleLabel(p.settleTime)}</span>
            <SourceBadge source={p.source} />
            <StatusChip phase={p.phase} />
          </div>
        </div>
      </div>
      <div className="ph-stats">
        <div className="ph-stat">
          <div className="label">YES on the book</div>
          <div className="value num up">{p.yesMid != null ? `${p.yesMid}¢` : '—'}</div>
        </div>
        <div className="ph-sep" />
        <div className="ph-stat">
          <div className="label">Cournot opening</div>
          <div className="value num">{pct(p.probability)}</div>
        </div>
        {p.phase === 'live' ? (
          <div className={`countdown ${left > 3600 ? 'calm' : ''}`} aria-label="Time to settlement">
            {cd.d > 0 && <CdPart n={cd.d} u="DAYS" />}
            {(cd.d > 0 || cd.h > 0) && <CdPart n={cd.h} u="HRS" />}
            <CdPart n={cd.m} u="MIN" />
            {cd.d === 0 && <CdPart n={cd.s} u="SECS" />}
          </div>
        ) : p.phase === 'settling' ? (
          <div className="settling-note">
            <Spinner /> Settling…
          </div>
        ) : null}
      </div>
    </div>
  )
}

function CdPart({ n, u }: { n: number; u: string }) {
  return (
    <div>
      <div className="num">{pad2(n)}</div>
      <div className="unit">{u}</div>
    </div>
  )
}
