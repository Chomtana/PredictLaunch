import { useEffect, useMemo, useState } from 'react'
import type { Address } from 'viem'
import { api, cournotError, toUnixSec, type Config, type CournotMarket, type OracleRecord } from '../lib/api.ts'
import { NATIVE, type LaunchConfig } from '../lib/chain.ts'
import { asset, duration, settleLabel } from '../lib/format.ts'
import { fmtBnb, fmtPrice, num18, parseBnb, usd, fmtAmt } from '../lib/units.ts'
import { PRICE_LABELS, QUESTION_LABELS } from '../lib/labels.ts'
import { useApp } from '../state.tsx'
import { CoinAvatar, Spinner } from './ui.tsx'
import { MarketRow } from './Cournot.tsx'
import { QuickLaunches } from './QuickLaunch.tsx'
import { fourEnabled, VENUE_NAME, type Venue } from '../lib/venue.ts'

export type LaunchDraft = Omit<LaunchConfig, 'salt'>

/** Date → value for <input type="datetime-local"> (local time, minute precision). */
export function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** A feed price as an editable strike string (no grouping, sensible precision). */
export function strikeText(price: bigint): string {
  const n = num18(price)
  const dp = n >= 1000 ? 0 : n >= 1 ? 2 : 6
  return String(Number(n.toFixed(dp)))
}

const trimZeros = (s: string) => (s.includes('.') ? s.replace(/\.?0+$/, '') : s)

const defaultSettle = () => {
  const t = Date.now() + 3600_000
  return new Date(Math.ceil(t / 300_000) * 300_000)
}

const PRESETS: [string, number][] = [
  ['15m', 900],
  ['1h', 3600],
  ['6h', 6 * 3600],
  ['1d', 86400],
  ['1w', 7 * 86400],
]

export const QUESTION_MAX_BYTES = 280
const bytes = (s: string) => new TextEncoder().encode(s).length

/** The two Cournot calls the form makes (injectable for tests). */
export interface CournotClient {
  resolve: (message: string) => Promise<{ markets: CournotMarket[] }>
  probability: (message: string, marketId: number | string, market?: { title: string; endTime: CournotMarket['endTime'] }) => Promise<OracleRecord>
}
const defaultCournot: CournotClient = { resolve: (m) => api.cournotResolve(m), probability: (m, id, mk) => api.cournotProbability(m, id, mk) }

/** id "none" = the creator chose "No matching market" (marketId 0). */
type Choice = { id: string; market: CournotMarket | null } | null

interface FormProps {
  config: Config
  priceOf: (feed: Address) => bigint | null
  /** USD price of the quote token (BNB/USD, or 1 for a USD token). */
  quoteUsd: bigint | null
  connected: boolean
  /** A function draft is evaluated right before the wallet prompt (see AppState.createLaunch). */
  onSubmit: (cfg: LaunchDraft | (() => LaunchDraft)) => Promise<unknown> | void
  busy?: string | null
  cournot?: CournotClient
  /** Where the coin graduates (default Flap). */
  venue?: Venue
  /** Shows the "Launch on" Flap / Four.meme picker under the tabs (when the sequencer has a Four rail). */
  onVenue?: (v: Venue) => void
}

export function CreateLaunchForm({ config, priceOf, quoteUsd, connected, onSubmit, busy, cournot = defaultCournot, venue = 'flap', onVenue }: FormProps) {
  const vName = VENUE_NAME[venue]
  const [kind, setKind] = useState<'quick' | 'price' | 'question'>('quick')
  const isQ = kind === 'question'
  const q = config.quoteSymbol ?? 'BNB'
  const minTarget = BigInt(config.minTarget)
  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [image, setImage] = useState('')
  const [feed, setFeed] = useState<Address>(config.feeds[0]?.address ?? ('0x' as Address))
  const [strike, setStrike] = useState('')
  const [strikeTouched, setStrikeTouched] = useState(false)
  const [settle, setSettle] = useState(() => toLocalInput(defaultSettle()))
  const [cut, setCut] = useState(config.cuts.includes(1000) ? 1000 : (config.cuts[0] ?? 1000))
  const [target, setTarget] = useState(() => trimZeros(fmtBnb(minTarget, 4).replace(/,/g, '')))
  const [, tick] = useState(0)
  // question mode
  const [questionText, setQuestionText] = useState('')
  const [markets, setMarkets] = useState<CournotMarket[] | null>(null)
  const [finding, setFinding] = useState(false)
  const [pick, setPick] = useState<Choice>(null)
  const [linking, setLinking] = useState(false)
  const [cnErr, setCnErr] = useState<string | null>(null)
  const [settleNote, setSettleNote] = useState<string | null>(null)

  const current = priceOf(feed)
  // Prefill the strike with the feed's current price until the user edits it.
  useEffect(() => {
    if (!strikeTouched && current != null) setStrike(strikeText(current))
  }, [current, strikeTouched, feed])

  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 15_000)
    return () => clearInterval(t)
  }, [])

  const feedSym = config.feeds.find((f) => f.address === feed)?.symbol ?? ''
  const coin = asset(feedSym)
  const strikeWei = parseBnb(strike)
  const targetWei = parseBnb(target)
  const settleSec = Math.floor(new Date(settle).getTime() / 1000)
  const nowSec = Math.floor(Date.now() / 1000)
  const dur = settleSec - nowSec

  const errors = useMemo(() => {
    const e: Record<string, string> = {}
    const nb = new TextEncoder().encode(name.trim()).length
    const sb = new TextEncoder().encode(symbol.trim()).length
    if (nb === 0) e.name = 'Required'
    else if (nb > 32) e.name = 'At most 32 bytes'
    if (sb === 0) e.symbol = 'Required'
    else if (sb > 10) e.symbol = 'At most 10 bytes'
    if (isQ) {
      const qb = bytes(questionText.trim())
      if (qb === 0) e.question = 'Required'
      else if (qb > QUESTION_MAX_BYTES) e.question = `At most ${QUESTION_MAX_BYTES} bytes`
      if (!pick) e.market = 'Find markets, then pick one (or "No matching market")'
    } else if (!strikeWei || strikeWei <= 0n) e.strike = 'Enter a price above 0'
    if (!Number.isFinite(settleSec)) e.settle = 'Pick a date and time'
    else if (dur < config.minDuration) e.settle = `At least ${duration(config.minDuration)} from now`
    else if (dur > config.maxDuration) e.settle = `At most ${duration(config.maxDuration)} from now`
    if (!targetWei || targetWei < minTarget) e.target = `Must be at least ${fmtAmt(minTarget, 2)} ${q} (${venue === 'flap' ? "Flap's graduation floor" : 'the minimum target'})`
    return e
  }, [name, symbol, strikeWei, settleSec, dur, config, targetWei, minTarget, q, isQ, questionText, pick, venue])
  const valid = Object.keys(errors).length === 0

  const L = isQ ? QUESTION_LABELS.names : PRICE_LABELS.names
  const delta = current && strikeWei ? (num18(strikeWei) / num18(current) - 1) * 100 : null

  const submit = async () => {
    if (!valid || !connected || busy || linking) return
    if (isQ) {
      // Tell the sequencer which market the creator picked (Cournot ids change per call, so it matches
      // by title + end time). The answer is never shown: traders must not see the oracle beforehand.
      if (pick?.market) {
        setLinking(true)
        try {
          await cournot.probability(questionText.trim(), pick.id, { title: pick.market.title, endTime: pick.market.endTime })
        } catch {
          /* the sequencer still finds the market by the question text */
        } finally {
          setLinking(false)
        }
      }
      void onSubmit({
        name: name.trim(),
        symbol: symbol.trim(),
        imageURI: image.trim(),
        feed: NATIVE,
        strike: 0n,
        settleTime: BigInt(settleSec),
        cutBps: cut,
        target: targetWei!,
        question: questionText.trim(),
        marketId: pick && pick.id !== 'none' ? BigInt(pick.id) : 0n,
      })
      return
    }
    void onSubmit({
      name: name.trim(),
      symbol: symbol.trim(),
      imageURI: image.trim(),
      feed,
      strike: strikeWei!,
      settleTime: BigInt(settleSec),
      cutBps: cut,
      target: targetWei!,
      question: '',
      marketId: 0n,
    })
  }

  const claim = questionText.trim()
  const findMarkets = async () => {
    if (!claim || bytes(claim) > QUESTION_MAX_BYTES || finding) return
    setFinding(true)
    setCnErr(null)
    setPick(null)
    try {
      const r = await cournot.resolve(claim)
      setMarkets(r.markets ?? [])
    } catch (e) {
      setMarkets(null)
      setCnErr(cournotError(e))
    } finally {
      setFinding(false)
    }
  }
  const choose = (c: Choice) => {
    setPick(c)
    setCnErr(null)
    setSettleNote(null)
    const end = c?.market ? toUnixSec(c.market.endTime) : NaN
    if (!Number.isFinite(end)) return
    const d = end - Date.now() / 1000
    if (d >= config.minDuration && d <= config.maxDuration) {
      setSettle(toLocalInput(new Date(end * 1000)))
      setSettleNote(`prefilled with the market's end time (${settleLabel(end)})`)
    } else setSettleNote(`the market ends ${settleLabel(end)}, outside the ${duration(config.minDuration)} to ${duration(config.maxDuration)} limit: pick a time yourself`)
  }
  const setStrikeFromCurrent = (pct: number) => {
    if (current == null) return
    setStrikeTouched(true)
    setStrike(strikeText((current * BigInt(10000 + pct * 100)) / 10000n))
  }

  const tabs = (
    <div className="seg" role="group" aria-label="Launch kind" style={{ marginBottom: 10 }}>
      {(['quick', 'price', 'question'] as const).map((k) => (
        <button key={k} type="button" aria-pressed={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
          {k === 'quick' ? 'Quick' : k === 'price' ? 'Price' : 'Question'}
        </button>
      ))}
    </div>
  )
  const venuePick = onVenue && fourEnabled(config) && (
    <div className="field venue-pick">
      <span className="field-label">Launch on</span>
      <div className="seg" role="group" aria-label="Launch on">
        {(['flap', 'four'] as const).map((v) => (
          <button type="button" key={v} aria-pressed={venue === v} className={venue === v ? 'on' : ''} onClick={() => onVenue(v)}>
            {VENUE_NAME[v]}
          </button>
        ))}
      </div>
      <span className="field-hint">
        Same mechanism on both: at graduation the cut seeds a PancakeSwap pool with 500M tokens and losers claim the other 500M.
      </span>
    </div>
  )

  if (kind === 'quick')
    return (
      <div className="panel create-form quick-page">
        <h2>Create a launch</h2>
        {tabs}
        {venuePick}
        <QuickLaunches config={config} priceOf={priceOf} connected={connected} busy={busy} cournot={cournot} onSubmit={onSubmit} />
      </div>
    )

  return (
    <div className="create-grid">
      <form
        className="panel create-form"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <h2>Create a launch</h2>
        {tabs}
        {venuePick}
        {isQ ? (
          <p className="muted lead">
            Launch a memecoin on a yes/no question. Traders bet YES or NO; the Cournot oracle supplies the odds and the settlement evidence. If the pool
            reaches the target at settlement, the coin launches on {vName} and losers get the tokens.
          </p>
        ) : (
          <p className="muted lead">
            Launch a memecoin on a price prediction. Traders bet Up or Down; the cut from winners fills your coin's pool. If the pool reaches the target at
            settlement, the coin launches on {vName} and losers get the tokens.
          </p>
        )}

        <div className="section-label">Coin</div>
        <div className="row2">
          <Field label="Name" id="cl-name" err={name ? errors.name : undefined}>
            <input id="cl-name" value={name} maxLength={32} placeholder="Moon Dog" onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Symbol" id="cl-symbol" err={symbol ? errors.symbol : undefined}>
            <input id="cl-symbol" value={symbol} maxLength={10} placeholder="MDOG" onChange={(e) => setSymbol(e.target.value.toUpperCase())} />
          </Field>
        </div>
        <Field label="Image URL" id="cl-image" hint="Optional. Shown on the card and the launch page.">
          <input id="cl-image" value={image} placeholder="https://…/logo.png" onChange={(e) => setImage(e.target.value)} />
        </Field>

        <div className="section-label">Prediction</div>
        {isQ ? (
          <>
            <Field
              label="Question"
              id="cl-question"
              err={questionText ? errors.question : undefined}
              hint={`${bytes(claim)}/${QUESTION_MAX_BYTES} bytes · the exact claim sent to Cournot and stored onchain`}
            >
              <div className="input-with-chips">
                <textarea
                  id="cl-question"
                  rows={2}
                  value={questionText}
                  placeholder="Will it rain in Boston on Nov 27, 2026?"
                  onChange={(e) => {
                    setQuestionText(e.target.value)
                                  }}
                />
                <div className="chips">
                  <button type="button" className="chip" disabled={!claim || bytes(claim) > QUESTION_MAX_BYTES || finding} onClick={() => void findMarkets()}>
                    {finding ? <Spinner size={11} /> : null} Find markets
                  </button>
                </div>
              </div>
            </Field>
            {markets && (
              <div className="field">
                <span className="field-label">Cournot market</span>
                <span className="field-hint">Read the titles and pick the market that really is your question.</span>
                <div className="cn-markets" role="radiogroup" aria-label="Cournot market">
                  {markets.length === 0 && <div className="muted small">No open markets matched.</div>}
                  {markets.map((m) => (
                    <MarketRow key={String(m.id)} m={m} on={pick?.id === String(m.id)} onPick={() => choose({ id: String(m.id), market: m })} />
                  ))}
                  <label className={`cn-market ${pick?.id === 'none' ? 'on' : ''}`}>
                    <input type="radio" name="cn-market" checked={pick?.id === 'none'} onChange={() => choose({ id: 'none', market: null })} />
                    <div className="cn-market-body">
                      <div className="cn-market-title">No matching market</div>
                      <div className="muted small">Launch without a Cournot market (marketId 0).</div>
                    </div>
                  </label>
                </div>
              </div>
            )}
            {cnErr && (
              <div className="field-err" role="alert">
                {cnErr}
              </div>
            )}
          </>
        ) : (
          <>
        <Field label="Feed" id="cl-feed" hint={current != null ? `Now ${fmtPrice(current)} · Atlas oracle` : 'Atlas oracle price feed'}>
          <select
            id="cl-feed"
            value={feed}
            onChange={(e) => {
              setFeed(e.target.value as Address)
              setStrikeTouched(false)
              setStrike('')
            }}
          >
            {config.feeds.map((f) => (
              <option key={f.address} value={f.address}>
                {f.symbol}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Strike (price to beat, USD)"
          id="cl-strike"
          err={strike ? errors.strike : undefined}
          hint={delta != null ? `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}% vs now` : undefined}
        >
          <div className="input-with-chips">
            <input
              id="cl-strike"
              inputMode="decimal"
              value={strike}
              onChange={(e) => {
                setStrikeTouched(true)
                setStrike(e.target.value)
              }}
            />
            <div className="chips">
              {[-5, 0, 5, 10].map((p) => (
                <button type="button" key={p} className="chip" disabled={current == null} onClick={() => setStrikeFromCurrent(p)}>
                  {p === 0 ? 'now' : `${p > 0 ? '+' : ''}${p}%`}
                </button>
              ))}
            </div>
          </div>
        </Field>
          </>
        )}
        <Field
          label="Settlement time"
          id="cl-settle"
          err={errors.settle}
          hint={!errors.settle ? `in ${duration(dur)}${isQ && settleNote ? ` · ${settleNote}` : ''}` : undefined}
        >
          <div className="input-with-chips">
            <input id="cl-settle" type="datetime-local" value={settle} onChange={(e) => setSettle(e.target.value)} />
            <div className="chips">
              {PRESETS.map(([l, s]) => (
                <button type="button" key={l} className="chip" onClick={() => setSettle(toLocalInput(new Date(Math.ceil((Date.now() + s * 1000) / 60_000) * 60_000)))}>
                  {l}
                </button>
              ))}
            </div>
          </div>
        </Field>

        <div className="section-label">Pool</div>
        <div className="field">
          <span className="field-label">Cut to the pool</span>
          <div className="seg" role="group" aria-label="Cut">
            {config.cuts.map((c) => (
              <button type="button" key={c} aria-pressed={c === cut} className={c === cut ? 'on' : ''} onClick={() => setCut(c)}>
                {c / 100}%
              </button>
            ))}
          </div>
          <span className="field-hint">Winners are paid {(10000 - cut) / 100}¢ per share; the rest goes to the pool. Fixed for the launch.</span>
        </div>
        <Field
          label={`Target (${q})`}
          id="cl-target"
          err={errors.target}
          hint={!errors.target && targetWei ? `≈ ${usd(targetWei, quoteUsd) || '…'} · pool needed to graduate` : undefined}
        >
          <input id="cl-target" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} />
        </Field>

        <button type="submit" className="btn primary big" disabled={!valid || !connected || !!busy || linking}>
          {busy || linking ? (
            <>
              <Spinner /> {busy ?? 'Linking the Cournot market…'}
            </>
          ) : connected ? (
            'Create launch'
          ) : (
            'Connect a wallet to create launch'
          )}
        </button>
        <div className="muted small center">
          {venue === 'flap'
            ? `Costs the Flap salt-lock fee (${fmtAmt(BigInt(config.saltLockFee), 3)} BNB) plus gas. The token address is mined to end in …7777.`
            : 'Gas only. The coin is created on Four.meme (OpenFour) when the launch graduates.'}
        </div>
      </form>

      <aside className="create-preview">
        <div className="section-label">Preview</div>
        <div className="panel preview-card">
          <div className="lc-head">
            <CoinAvatar name={name || 'Coin'} image={image} size={52} />
            <div>
              <div className="lc-name">{name || 'Your coin'}</div>
              <div className="muted mono">${symbol || 'TICKER'}</div>
            </div>
          </div>
          <div className="lc-question">
            {isQ ? (
              claim || 'Your question?'
            ) : (
              <>
                {coin} ≥ {strikeWei ? fmtPrice(strikeWei) : '$…'} by {Number.isFinite(settleSec) ? settleLabel(settleSec) : '…'}?
              </>
            )}
          </div>
          <div className="preview-rows">
            <div>
              <span className="muted">Winners get</span>
              <b>{(10000 - cut) / 100}¢ / share</b>
            </div>
            <div>
              <span className="muted">Goes to pool</span>
              <b>{cut / 100}% of winning shares</b>
            </div>
            <div>
              <span className="muted">Graduates at</span>
              <b>{targetWei ? fmtAmt(targetWei, 2) : '…'} {q}</b>
            </div>
            <div>
              <span className="muted">Open pairs needed</span>
              <b>{targetWei ? fmtAmt((targetWei * 10000n) / BigInt(cut), 0) : '…'}</b>
            </div>
          </div>
        </div>
        <ol className="how">
          <li>
            <b>Trade.</b> {L[0]} and {L[1]} shares trade 1¢–99¢ until settlement. A pair (1 {L[0]} + 1 {L[1]}) is backed by 1 {q}.
          </li>
          <li>
            <b>Settle.</b>{' '}
            {isQ ? 'After settlement the resolver proposes the outcome from Cournot evidence; it is final after a challenge window.' : 'At settlement the oracle decides.'} Winners redeem {(10000 - cut) / 100}¢; the {cut / 100}% cut goes to the pool.
          </li>
          <li>
            <b>Graduate.</b> Pool ≥ target: 1B tokens are minted through {venue === 'flap' ? 'Flap' : 'Four.meme (OpenFour)'}, 500M + the pool seed PancakeSwap, losers claim the other 500M.
          </li>
          <li>
            <b>Or not.</b> Pool short of target: winners are paid the full 1.00 and no coin launches.
          </li>
        </ol>
      </aside>
    </div>
  )
}

function Field({ label, id, err, hint, children }: { label: string; id: string; err?: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className={`field ${err ? 'has-err' : ''}`}>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {children}
      {err ? <span className="field-err">{err}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  )
}

/** The #/create page, wired to app state. */
export function CreateLaunch() {
  const { config, configError, priceOf, quoteUsd, wallet, createLaunch, setAccountOpen } = useApp()
  const [venue, setVenue] = useState<Venue>('flap')
  const [busy, setBusy] = useState<string | null>(null)
  if (!config) {
    return (
      <div className="page">
        <div className="panel empty">
          <Spinner /> {configError ? 'Waiting for the sequencer…' : 'Loading…'}
        </div>
      </div>
    )
  }
  return (
    <div className="page">
      {!wallet && (
        <div className="banner info">
          Connect a wallet to create a launch.{' '}
          <button className="link" onClick={() => setAccountOpen(true)}>
            Connect
          </button>
        </div>
      )}
      <CreateLaunchForm
        venue={venue}
        onVenue={setVenue}
        config={config}
        priceOf={priceOf}
        quoteUsd={quoteUsd}
        connected={!!wallet}
        busy={busy}
        onSubmit={async (cfg) => {
          setBusy(venue === 'flap' ? 'Mining salt…' : 'Creating…')
          try {
            const ok = await createLaunch(cfg, setBusy, venue)
            if (ok) window.location.hash = '#/'
          } finally {
            setBusy(null)
          }
        }}
      />
    </div>
  )
}
