// Cournot oracle views for question launches. Everything here renders what the sequencer returned
// (SPEC "Oracle record") generically: no field is assumed beyond the documented shapes, and unknown
// keys are shown as they come.

import type { ReactNode } from 'react'
import { n, toUnixSec, type CournotMarket, type LaunchOracle, type OracleRecord, type OracleSource } from '../lib/api.ts'
import { duration, settleLabel } from '../lib/format.ts'
import { QUESTION_LABELS, outcomeName } from '../lib/labels.ts'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => v != null && typeof v === 'object' && !Array.isArray(v)
const isScalar = (v: unknown) => v == null || typeof v !== 'object'
const isUrl = (v: unknown): v is string => typeof v === 'string' && /^https?:\/\/\S+$/i.test(v)

/** "primary_anchor" → "Primary anchor" */
export const humanize = (k: string) => {
  const s = k.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase()
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export const pct = (p: number | null | undefined, dp = 1) => (p == null || !Number.isFinite(p) ? '—' : `${(p * 100).toFixed(dp)}%`)

function Val({ v }: { v: unknown }): ReactNode {
  if (v == null) return <span className="muted">—</span>
  if (isUrl(v))
    return (
      <a className="link" href={v} target="_blank" rel="noreferrer noopener">
        {v}
      </a>
    )
  if (typeof v === 'object') return <code className="mono small">{JSON.stringify(v)}</code>
  return <>{String(v)}</>
}

/** Rows of objects: columns are the union of their keys; a row's `url` links its `summary` (or gets a link column). */
export function RecordsTable({ rows }: { rows: unknown[] }) {
  const objs = rows.map((r) => (isObj(r) ? r : { value: r }))
  const cols: string[] = []
  for (const o of objs) for (const k of Object.keys(o)) if (k !== 'url' && !cols.includes(k)) cols.push(k)
  const hasUrl = objs.some((o) => isUrl(o.url))
  const linkCol = hasUrl && !cols.includes('summary')
  return (
    <div className="cn-scroll">
      <table className="table cn-table">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c}>{humanize(c)}</th>
            ))}
            {linkCol && <th>Link</th>}
          </tr>
        </thead>
        <tbody>
          {objs.map((o, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c}>
                  {c === 'summary' && isUrl(o.url) ? (
                    <a className="link" href={o.url} target="_blank" rel="noreferrer noopener">
                      {String(o.summary ?? o.url)}
                    </a>
                  ) : (
                    <Val v={o[c]} />
                  )}
                </td>
              ))}
              {linkCol && (
                <td>
                  <Val v={o.url} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Nested data flattened to path | value rows. */
export function PathTable({ value, prefix = '' }: { value: unknown; prefix?: string }) {
  const rows: [string, unknown][] = []
  const walk = (v: unknown, p: string) => {
    if (isObj(v) && Object.keys(v).length) for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k)
    else if (Array.isArray(v) && v.length && !v.every(isScalar)) v.forEach((x, i) => walk(x, `${p}[${i}]`))
    else rows.push([p, Array.isArray(v) ? v.join(', ') : v])
  }
  walk(value, prefix)
  return (
    <div className="cn-scroll">
      <table className="table cn-table">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td className="muted mono small">{k}</td>
              <td>
                <Val v={v} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** A flat object as one-row table (its keys as the header). */
function OneRow({ o }: { o: Obj }) {
  return <RecordsTable rows={[o]} />
}

function Section({ k, v }: { k: string; v: unknown }) {
  let body: ReactNode
  if (Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number'))
    body = (
      <ul className="cn-list">
        {v.map((x, i) => (
          <li key={i}>
            <Val v={x} />
          </li>
        ))}
      </ul>
    )
  else if (Array.isArray(v) && v.every(isObj)) body = <RecordsTable rows={v} />
  else if (isObj(v) && Object.values(v).every(isScalar)) body = <OneRow o={v} />
  else body = <PathTable value={v} prefix={k} />
  return (
    <div className="cn-section" data-basis-key={k}>
      <div className="cn-h">{humanize(k)}</div>
      {body}
    </div>
  )
}

/**
 * The full `basis`: an object (primary_anchor / price_distance as one-row tables, cross_checks as a table,
 * limitations as a list, anything else by shape) or the older array form of {source, summary, time, url?}.
 */
export function BasisView({ basis, omit = [] }: { basis: OracleRecord['basis'] | undefined; omit?: string[] }) {
  if (basis == null) return <div className="muted small">No evidence returned.</div>
  if (Array.isArray(basis)) return basis.length ? <RecordsTable rows={basis} /> : <div className="muted small">No evidence returned.</div>
  if (!isObj(basis)) return <PathTable value={basis} prefix="basis" />
  const entries = Object.entries(basis).filter(([k]) => !omit.includes(k))
  if (!entries.length) return <div className="muted small">No evidence returned.</div>
  return (
    <div className="cn-basis">
      {entries.map(([k, v]) => (
        <Section key={k} k={k} v={v} />
      ))}
    </div>
  )
}

/** `basis.limitations` when it is a list (the documented shape), else []. */
export function limitationsOf(basis: OracleRecord['basis'] | undefined): unknown[] {
  return isObj(basis) && Array.isArray(basis.limitations) ? basis.limitations : []
}

export function SourceBadge({ source }: { source: OracleSource | string | null | undefined }) {
  if (source === 'mock')
    return (
      <span className="cn-badge mock" title="COURNOT_MODE=mock: no Cournot probability call was made">
        Simulated oracle
      </span>
    )
  if (!source) return null
  return <span className="cn-badge live">{source === 'cournot-live' ? 'Cournot live' : source}</span>
}

const fetched = (r: OracleRecord) => {
  const t = toUnixSec(r.fetchedAt)
  return Number.isFinite(t) ? settleLabel(t) : '—'
}

/** Preview of a probability record (create form): headline %, `result` fields, full basis, source badge. */
export function OracleRecordView({ r }: { r: OracleRecord }) {
  return (
    <div className="cn-record" data-testid="oracle-record">
      <div className="cn-headline">
        <span className="cn-pct">{pct(r.probability)}</span>
        <span className="muted small">YES probability</span>
        <SourceBadge source={r.source} />
      </div>
      <div className="muted small">
        Claim sent: <q>{r.claim}</q> · fetched {fetched(r)}
      </div>
      {r.error && <div className="field-err">{r.error}</div>}
      {r.result && Object.keys(r.result).length > 0 && (
        <div className="cn-section">
          <div className="cn-h">Result</div>
          <PathTable value={r.result} />
        </div>
      )}
      <div className="cn-section">
        <div className="cn-h">Basis</div>
        <BasisView basis={r.basis} />
      </div>
    </div>
  )
}

export function MarketRow({ m, on, onPick }: { m: CournotMarket; on: boolean; onPick: () => void }) {
  const end = toUnixSec(m.endTime)
  return (
    <label className={`cn-market ${on ? 'on' : ''}`}>
      <input type="radio" name="cn-market" checked={on} onChange={onPick} />
      <div className="cn-market-body">
        <div className="cn-market-title">{m.title}</div>
        <div className="muted small">
          #{String(m.id)} · ends {Number.isFinite(end) ? settleLabel(end) : '—'} · YES {m.yesPrice != null ? `${Math.round(m.yesPrice * 100)}¢` : '—'} ·
          confidence {pct(m.matchingConfidence, 0)}
        </div>
      </div>
    </label>
  )
}

/** Launch page, in place of the price chart: exact claim, probability, evidence, limitations, fetched at, gap vs the book. */
export function CournotPanel({ question, oracle, probability, source, bookYes }: {
  question: string
  oracle: LaunchOracle | null
  /** LaunchSummary.oracleProbability (used while /oracle has not loaded) */
  probability?: number | null
  source?: OracleSource | null
  /** YES mid on the book, cents */
  bookYes: number | null
}) {
  const r = oracle?.opening ?? null
  const p = r?.probability ?? probability ?? null
  const gap = p != null && bookYes != null ? bookYes - Math.round(p * 100) : null
  const lims = limitationsOf(r?.basis)
  const last = oracle?.prices?.length ? oracle.prices[oracle.prices.length - 1] : null
  return (
    <div className="panel section cn-panel" data-testid="cournot-panel">
      <div className="cn-panel-head">
        <h3>Cournot oracle</h3>
        <SourceBadge source={r?.source ?? source} />
      </div>
      <div className="cn-claim">
        <div className="muted small">Exact claim</div>
        <q>{r?.claim ?? question}</q>
      </div>
      <div className="cn-stats">
        <div>
          <div className="muted small">Opening probability (YES)</div>
          <div className="cn-pct">{pct(p)}</div>
        </div>
        <div>
          <div className="muted small">Book YES mid</div>
          <div className="cn-pct">{bookYes != null ? `${bookYes}¢` : '—'}</div>
        </div>
        <div>
          <div className="muted small">Oracle vs book</div>
          <div className={`cn-pct ${gap == null ? '' : gap > 0 ? 'up' : gap < 0 ? 'down' : ''}`} data-testid="oracle-gap">
            {gap == null ? '—' : `${gap > 0 ? '+' : ''}${gap}¢`}
          </div>
        </div>
        {last && (
          <div>
            <div className="muted small">Market YES now</div>
            <div className="cn-pct">{Math.round(last.price * 100)}¢</div>
          </div>
        )}
      </div>
      {r ? (
        <>
          <div className="muted small">
            Market #{String(r.marketId)} · fetched {fetched(r)}
          </div>
          {r.error && <div className="field-err">{r.error}</div>}
          <div className="cn-section">
            <div className="cn-h">Evidence</div>
            <BasisView basis={r.basis} omit={['limitations']} />
          </div>
          {lims.length > 0 && (
            <div className="cn-section">
              <div className="cn-h">Limitations</div>
              <ul className="cn-list">
                {lims.map((x, i) => (
                  <li key={i}>
                    <Val v={x} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      ) : (
        <div className="muted small">{oracle ? 'No opening oracle record yet.' : 'Loading oracle record…'}</div>
      )}
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
  const ev = oracle?.settlement ?? null
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
      {ev && (
        <div className="cn-section">
          <div className="cn-h">
            Settlement evidence <SourceBadge source={ev.source} />
          </div>
          <div className="muted small">
            {pct(ev.probability)} YES · fetched {fetched(ev)}
          </div>
          <BasisView basis={ev.basis} />
        </div>
      )}
      {!pr?.proposed && !resolved && now >= settleTime && (
        <div className="muted small">
          The resolver proposes YES/NO once the market's YES price is ≥ 97¢ or ≤ 3¢; otherwise the owner settles it.
        </div>
      )}
    </div>
  )
}
