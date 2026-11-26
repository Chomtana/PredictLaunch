import { useEffect, useState } from 'react'
import type { Book, MsgResult } from '../lib/api.ts'
import { bestPrice, levelsFor, walkBuy, walkSell } from '../lib/market.ts'
import { cost, floorShares, fmtBnb, fmtShares, parseBnb, payout, type Outcome } from '../lib/units.ts'
import { useQuote, type OrderParams } from '../state.tsx'
import { Spinner } from './ui.tsx'
import { PRICE_LABELS, type OutcomeLabels } from '../lib/labels.ts'

export interface TradePanelProps {
  launchId: number
  title: string
  symbol: string
  cutBps: number
  settleTime: number
  tradable: boolean
  book: Book | null
  position: { up: bigint; down: bigint } | null
  /** available to trade (ERC20: wallet funds; assumes the approve, which trading requires anyway) */
  balance: bigint | null
  keyReady: boolean
  connected: boolean
  onEnable: () => void
  onConnect: () => void
  onOrder: (p: OrderParams) => Promise<MsgResult | null>
  /** Up/Down (price launch) or YES/NO (question launch); default Up/Down. */
  labels?: OutcomeLabels
}

// Stake presets in the quote token: BNB-sized amounts for native BNB, dollar amounts for a USD token.
const E18 = 10n ** 18n
const BNB_PRESETS: [string, bigint][] = [
  ['0.05', 5n * 10n ** 16n],
  ['0.25', 25n * 10n ** 16n],
  ['1', E18],
]
const USD_PRESETS: [string, bigint][] = [
  ['5', 5n * E18],
  ['10', 10n * E18],
  ['50', 50n * E18],
]
export function TradePanel(p: TradePanelProps) {
  const NAME = (p.labels ?? PRICE_LABELS).names
  const { symbol: q } = useQuote()
  const PRESETS = q.toUpperCase() === 'BNB' ? BNB_PRESETS : USD_PRESETS
  const [side, setSide] = useState<0 | 1>(0)
  const [outcome, setOutcome] = useState<Outcome>(0)
  const [mode, setMode] = useState<'market' | 'limit'>('market')
  const [stake, setStake] = useState('')
  const [shares, setShares] = useState('')
  const [limitPrice, setLimitPrice] = useState('')
  const [busy, setBusy] = useState(false)
  const [last, setLast] = useState<string | null>(null)

  const now = Date.now() / 1000
  const held = p.position ? (outcome === 0 ? p.position.up : p.position.down) : 0n
  const priceUp = bestPrice(p.book, 0, side)
  const priceDown = bestPrice(p.book, 1, side)
  const best = outcome === 0 ? priceUp : priceDown
  const levels = levelsFor(p.book, outcome, side)

  // Limit price follows the best price until edited.
  useEffect(() => {
    setLimitPrice((v) => (v === '' && best != null ? String(best) : v))
  }, [best])
  useEffect(() => setLast(null), [side, outcome, mode])
  // Selling defaults to the whole position.
  useEffect(() => {
    if (side === 1) setShares(held > 0n ? fmtShares(held).replace(/,/g, '') : '')
  }, [side, outcome, held])

  const stakeWei = parseBnb(stake) ?? 0n
  const sharesWei = floorShares(parseBnb(shares) ?? 0n)
  const lp = Number(limitPrice)
  const lpOk = Number.isInteger(lp) && lp >= 1 && lp <= 99

  // ---- previews
  let amount = 0n
  let price: number | null = null
  let spend = 0n
  let receive = 0n
  if (mode === 'market') {
    if (side === 0) {
      const w = walkBuy(levels, stakeWei)
      amount = w.shares
      price = w.worst
      spend = w.cost
    } else {
      const w = walkSell(levels, sharesWei)
      amount = w.filled
      price = w.worst
      receive = w.proceeds
    }
  } else if (lpOk) {
    price = lp
    amount = sharesWei
    if (side === 0) spend = cost(amount, lp)
    else receive = cost(amount, lp)
  }
  const win = side === 0 ? payout(amount, p.cutBps) : 0n

  let problem: string | null = null
  if (side === 1 && held === 0n) problem = `You have no ${NAME[outcome]} shares to sell`
  else if (side === 1 && sharesWei > held) problem = `You hold ${fmtShares(held)} ${NAME[outcome]} shares`
  else if (mode === 'limit' && !lpOk) problem = 'Price must be 1–99¢'
  else if (side === 0 && p.balance != null && spend > p.balance) problem = `Not enough ${q} available to trade`
  else if (mode === 'market' && levels.length === 0) problem = 'No liquidity on this side yet: try a limit order'
  const canSubmit = !problem && amount > 0n && price != null && p.tradable && !busy

  const submit = async () => {
    if (!canSubmit || price == null) return
    setBusy(true)
    try {
      const r = await p.onOrder({
        launchId: p.launchId,
        outcome,
        side,
        price,
        amount,
        market: mode === 'market',
        expiry: BigInt(p.settleTime),
      })
      if (r) {
        const filled = r.fills.reduce((s, f) => s + BigInt(f.amount), 0n)
        setLast(
          filled > 0n
            ? `Filled ${fmtShares(filled)} ${NAME[outcome]}${BigInt(r.resting || '0') > 0n ? `, ${fmtShares(r.resting)} resting` : ''}`
            : BigInt(r.resting || '0') > 0n
              ? `Order resting: ${fmtShares(r.resting)} @ ${price}¢`
              : 'No fill',
        )
        setStake('')
        setShares('')
      }
    } finally {
      setBusy(false)
    }
  }

  const closed = !p.tradable
  return (
    <div className="panel trade-panel">
      <div className="tp-head">
        <div>
          <div className="q">{p.title}</div>
          <div className={`o ${outcome === 0 ? 'up' : 'down'}`}>
            {side === 0 ? 'Buy' : 'Sell'} {NAME[outcome]}
          </div>
        </div>
      </div>
      <div className="tp-tabs">
        <button className={side === 0 ? 'on' : ''} onClick={() => setSide(0)}>
          Buy
        </button>
        <button className={side === 1 ? 'on' : ''} onClick={() => setSide(1)}>
          Sell
        </button>
        <select className="mode" aria-label="Order type" value={mode} onChange={(e) => setMode(e.target.value as 'market' | 'limit')}>
          <option value="market">Market</option>
          <option value="limit">Limit</option>
        </select>
      </div>

      {closed ? (
        <div className="closed-note">{now >= p.settleTime ? 'Settling… trading is closed' : 'Trading closed'}</div>
      ) : (
        <>
          <div className="outcome-btns">
            <button className={`outcome-btn up ${outcome === 0 ? 'on' : ''}`} onClick={() => setOutcome(0)}>
              {NAME[0]} {priceUp != null ? `${priceUp}¢` : '--'}
            </button>
            <button className={`outcome-btn down ${outcome === 1 ? 'on' : ''}`} onClick={() => setOutcome(1)}>
              {NAME[1]} {priceDown != null ? `${priceDown}¢` : '--'}
            </button>
          </div>

          {mode === 'market' && side === 0 && (
            <>
              <div className="presets">
                {PRESETS.map(([label, v]) => {
                  const w = walkBuy(levels, v)
                  return (
                    <button key={label} className={`preset ${stakeWei === v ? 'on' : ''}`} onClick={() => setStake(label)}>
                      <span className="amt">{label} {q}</span>
                      <span className="win">
                        win <b>{fmtBnb(payout(w.shares, p.cutBps), 2)} {q}</b>
                      </span>
                    </button>
                  )
                })}
              </div>
              <div className="tp-input">
                <label htmlFor="tp-stake">Amount ({q})</label>
                <input id="tp-stake" inputMode="decimal" placeholder="0.0" value={stake} onChange={(e) => setStake(e.target.value)} />
              </div>
            </>
          )}

          {(mode === 'limit' || side === 1) && (
            <>
              {mode === 'limit' && (
                <div className="tp-input">
                  <label htmlFor="tp-price">Limit price (¢)</label>
                  <input id="tp-price" inputMode="numeric" value={limitPrice} onChange={(e) => setLimitPrice(e.target.value.replace(/[^\d]/g, ''))} />
                </div>
              )}
              <div className="tp-input">
                <label htmlFor="tp-shares">
                  Shares{' '}
                  {side === 1 && (
                    <span className="muted">
                      · you hold {fmtShares(held)}{' '}
                      {held > 0n && (
                        <button className="link" onClick={() => setShares(fmtShares(held).replace(/,/g, ''))}>
                          Max
                        </button>
                      )}
                    </span>
                  )}
                </label>
                <input id="tp-shares" inputMode="decimal" placeholder="0" value={shares} onChange={(e) => setShares(e.target.value)} />
              </div>
            </>
          )}

          {side === 0 ? (
            <div className="to-win" data-testid="to-win">
              <div>
                <div className="muted small">To win</div>
                <div className="muted small">
                  {fmtShares(amount)} shares · cost {fmtBnb(spend, 4)} {q}
                </div>
              </div>
              <span className="big">{fmtBnb(win, 2)} {q}</span>
            </div>
          ) : (
            <div className="to-win">
              <div>
                <div className="muted small">You receive</div>
                <div className="muted small">{fmtShares(amount)} shares</div>
              </div>
              <span className="big">{fmtBnb(receive, 4)} {q}</span>
            </div>
          )}

          {problem && (amount > 0n || side === 1 || mode === 'limit') && <div className="field-err" style={{ marginTop: 10 }}>{problem}</div>}

          {!p.connected ? (
            <button className="btn primary submit" onClick={p.onConnect}>
              Connect wallet
            </button>
          ) : !p.keyReady ? (
            <button className="btn primary submit" onClick={p.onEnable}>
              Enable trading
            </button>
          ) : (
            <button className={`submit ${outcome === 0 ? 'up' : 'down'}`} disabled={!canSubmit} onClick={submit}>
              {busy ? <Spinner /> : null} {side === 0 ? 'Buy' : 'Sell'} {NAME[outcome]}
              {price != null && amount > 0n ? ` @ ${mode === 'market' ? '≤' : ''}${price}¢` : ''}
            </button>
          )}
          {last && <div className="muted small center" style={{ marginTop: 8 }}>{last}</div>}
        </>
      )}

      <div className="tp-row">
        <span className="cut-badge">{p.cutBps / 100}% cut</span>
        <span className="muted small">
          winners get {(10000 - p.cutBps) / 100}¢ · available {p.balance != null ? fmtBnb(p.balance, 2) : '—'} {q}
        </span>
      </div>
    </div>
  )
}
