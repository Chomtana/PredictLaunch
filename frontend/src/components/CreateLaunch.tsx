import { useEffect, useMemo, useState } from 'react'
import type { Address } from 'viem'
import type { Config } from '../lib/api.ts'
import type { LaunchConfig } from '../lib/chain.ts'
import { asset, duration, settleLabel } from '../lib/format.ts'
import { fmtBnb, fmtPrice, num18, parseBnb, usd } from '../lib/units.ts'
import { useApp } from '../state.tsx'
import { CoinAvatar, Spinner } from './ui.tsx'

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

interface FormProps {
  config: Config
  priceOf: (feed: Address) => bigint | null
  bnbUsd: bigint | null
  connected: boolean
  onSubmit: (cfg: LaunchDraft) => Promise<unknown> | void
  busy?: string | null
}

export function CreateLaunchForm({ config, priceOf, bnbUsd, connected, onSubmit, busy }: FormProps) {
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
    if (!strikeWei || strikeWei <= 0n) e.strike = 'Enter a price above 0'
    if (!Number.isFinite(settleSec)) e.settle = 'Pick a date and time'
    else if (dur < config.minDuration) e.settle = `At least ${duration(config.minDuration)} from now`
    else if (dur > config.maxDuration) e.settle = `At most ${duration(config.maxDuration)} from now`
    if (!targetWei || targetWei < minTarget) e.target = `Must be at least ${fmtBnb(minTarget, 2)} BNB (Flap's pool floor)`
    return e
  }, [name, symbol, strikeWei, settleSec, dur, config, targetWei, minTarget])
  const valid = Object.keys(errors).length === 0

  const delta = current && strikeWei ? (num18(strikeWei) / num18(current) - 1) * 100 : null

  const submit = () => {
    if (!valid || !connected || busy) return
    void onSubmit({
      name: name.trim(),
      symbol: symbol.trim(),
      imageURI: image.trim(),
      feed,
      strike: strikeWei!,
      settleTime: BigInt(settleSec),
      cutBps: cut,
      target: targetWei!,
    })
  }

  const setStrikeFromCurrent = (pct: number) => {
    if (current == null) return
    setStrikeTouched(true)
    setStrike(strikeText((current * BigInt(10000 + pct * 100)) / 10000n))
  }

  return (
    <div className="create-grid">
      <form
        className="panel create-form"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <h2>Create a launch</h2>
        <p className="muted lead">
          Launch a memecoin on a price prediction. Traders bet Up or Down; the cut from winners fills your coin's pool. If the pool reaches the target at
          settlement, the coin launches on Flap and losers get the tokens.
        </p>

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
        <Field label="Settlement time" id="cl-settle" err={errors.settle} hint={!errors.settle ? `in ${duration(dur)}` : undefined}>
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
          label="Target (BNB)"
          id="cl-target"
          err={errors.target}
          hint={!errors.target && targetWei ? `≈ ${usd(targetWei, bnbUsd) || '…'} · pool needed to graduate` : undefined}
        >
          <input id="cl-target" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} />
        </Field>

        <button type="submit" className="btn primary big" disabled={!valid || !connected || !!busy}>
          {busy ? (
            <>
              <Spinner /> {busy}
            </>
          ) : connected ? (
            'Create launch'
          ) : (
            'Connect a wallet to create launch'
          )}
        </button>
        <div className="muted small center">
          Costs the Flap salt-lock fee ({fmtBnb(BigInt(config.saltLockFee), 3)} BNB) plus gas. The token address is mined to end in …7777.
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
            {coin} ≥ {strikeWei ? fmtPrice(strikeWei) : '$…'} by {Number.isFinite(settleSec) ? settleLabel(settleSec) : '…'}?
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
              <b>{targetWei ? fmtBnb(targetWei, 2) : '…'} BNB</b>
            </div>
            <div>
              <span className="muted">Open pairs needed</span>
              <b>{targetWei ? fmtBnb((targetWei * 10000n) / BigInt(cut), 0) : '…'}</b>
            </div>
          </div>
        </div>
        <ol className="how">
          <li>
            <b>Trade.</b> Up and Down shares trade 1¢–99¢ until settlement. A pair (1 Up + 1 Down) is backed by 1 BNB.
          </li>
          <li>
            <b>Settle.</b> At settlement the oracle decides. Winners redeem {(10000 - cut) / 100}¢; the {cut / 100}% cut goes to the pool.
          </li>
          <li>
            <b>Graduate.</b> Pool ≥ target: 1B tokens are minted through Flap, 500M + the pool seed PancakeSwap, losers claim the other 500M.
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
  const { config, configError, priceOf, bnbUsd, wallet, createLaunch, setAccountOpen } = useApp()
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
        config={config}
        priceOf={priceOf}
        bnbUsd={bnbUsd}
        connected={!!wallet}
        busy={busy}
        onSubmit={async (cfg) => {
          setBusy('Mining salt…')
          try {
            const ok = await createLaunch(cfg, setBusy)
            if (ok) window.location.hash = '#/'
          } finally {
            setBusy(null)
          }
        }}
      />
    </div>
  )
}
