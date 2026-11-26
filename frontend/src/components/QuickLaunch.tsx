// Create page, Quick tab: ten ready-made launches (two rows of five), one click each. Every page load
// picks fresh meme names and logos (src/lib/catalog.ts); the predictions follow a fixed lineup:
//   BNB 1 min · BTC 1 min · event · event · ETH 1 h
//   BNB 1 day · event · event · BTC 1 h · event
// Event cards find a live Cournot market in the background (one resolve every ~2 s, the sequencer's
// per-IP limit); its exact title becomes the onchain question. Nothing the oracle answered is shown.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Address } from 'viem'
import { parseEther } from 'viem'
import { toUnixSec, type Config, type CournotMarket } from '../lib/api.ts'
import { NATIVE } from '../lib/chain.ts'
import { duration, settleLabel } from '../lib/format.ts'
import { fmtPrice } from '../lib/units.ts'
import { ICONS, PRICE_MEMES, QUESTIONS, STRIKE_STEP, isPriceMarket, niceStrike, pick, searchText, shuffle, type Asset, type Meme, type QuestionTheme } from '../lib/catalog.ts'
import type { CournotClient, LaunchDraft } from './CreateLaunch.tsx'
import { CoinAvatar, Spinner } from './ui.tsx'

/** Wallet confirmation + inclusion time added to the shortest settlements so they stay above the
 *  contract's 60 s minimum (the settle time is fixed right before the wallet prompt). */
export const QUICK_SLACK = 30
const HOUR = 3600
const DAY = 86400
const QUICK_CUT = 1000

type PriceSlot = { kind: 'price'; asset: Asset; seconds: number; fast?: boolean }
type EventSlot = { kind: 'event' }
const LINEUP: (PriceSlot | EventSlot)[] = [
  { kind: 'price', asset: 'BNB', seconds: 60, fast: true },
  { kind: 'price', asset: 'BTC', seconds: 60, fast: true },
  { kind: 'event' },
  { kind: 'event' },
  { kind: 'price', asset: 'ETH', seconds: HOUR },
  { kind: 'price', asset: 'BNB', seconds: DAY },
  { kind: 'event' },
  { kind: 'event' },
  { kind: 'price', asset: 'BTC', seconds: HOUR },
  { kind: 'event' },
]

export type QuickCard =
  | ({ key: string; meme: Meme; image: string } & PriceSlot)
  | { key: string; kind: 'event'; meme: Meme; image: string; theme: QuestionTheme; spare: QuestionTheme[] }

/** The lineup with random memes and logos; no name repeats on the page. Event cards get distinct themes
 *  (questions only, so the card reads as one) plus spares to fall back on when Cournot has no market. */
export function quickCards(): QuickCard[] {
  const used = new Set<string>()
  const meme = (ms: Meme[]) => {
    const m = pick(ms.filter((x) => !used.has(x.symbol)).length ? ms.filter((x) => !used.has(x.symbol)) : ms)
    used.add(m.symbol)
    return m
  }
  const themes = shuffle(QUESTIONS.filter((q) => q.search.trim().endsWith('?')))
  const n = LINEUP.filter((s) => s.kind === 'event').length
  const events = themes.slice(0, n)
  const spares = themes.slice(n)
  let e = 0
  return LINEUP.map((s, i) => {
    if (s.kind === 'price') return { key: `p${i}`, ...s, meme: meme(PRICE_MEMES[s.asset]), image: ICONS[s.asset] }
    const theme = events[e++]
    return { key: `e${i}`, kind: 'event', theme, spare: spares, meme: meme(theme.memes), image: pick(theme.images) }
  })
}

const span = (s: number) => (s < HOUR ? `${Math.round(s / 60)} min` : s < DAY ? `${Math.round(s / HOUR)} h` : `${Math.round(s / DAY)} day`)

/** Settlement for an event launch: the market's end, kept inside [1 h, the contract max]; 1 day if unknown. */
export function eventSettle(m: CournotMarket | null, nowSec: number, maxDuration: number): number {
  const end = m ? toUnixSec(m.endTime) : NaN
  if (!Number.isFinite(end)) return nowSec + DAY
  return Math.floor(Math.min(Math.max(end, nowSec + HOUR), nowSec + maxDuration))
}

type Found = { market: CournotMarket; theme: QuestionTheme; meme: Meme; image: string } | 'none' | undefined

interface Props {
  config: Config
  priceOf: (feed: Address) => bigint | null
  connected: boolean
  busy?: string | null
  cournot: CournotClient
  onSubmit: (cfg: LaunchDraft | (() => LaunchDraft)) => Promise<unknown> | void
  /** Gap between resolve calls (the sequencer allows one per IP every 2 s). */
  gapMs?: number
}

export function QuickLaunches({ config, priceOf, connected, busy, cournot, onSubmit, gapMs = 2200 }: Props) {
  const cards = useMemo(quickCards, [])
  const [found, setFound] = useState<Record<string, Found>>({})
  const [active, setActive] = useState<string | null>(null)
  const latestPrice = useRef(priceOf)
  latestPrice.current = priceOf
  const feedOf = (a: Asset) => config.feeds.find((f) => f.symbol.toUpperCase() === `${a}/USD`)?.address ?? null
  const minTarget = BigInt(config.minTarget)
  const q = config.quoteSymbol ?? 'BNB'

  // Find a Cournot market for each event card, one resolve at a time; a theme without a usable market
  // is swapped for a spare (with a fresh meme and photo).
  useEffect(() => {
    let alive = true
    const taken = new Set(cards.flatMap((c) => (c.kind === 'event' ? [c.theme.search] : [])))
    void (async () => {
      let last = 0
      for (const c of cards) {
        if (c.kind !== 'event') continue
        let result: Found = 'none'
        for (const theme of [c.theme, ...c.spare.filter((t) => !taken.has(t.search))].slice(0, 3)) {
          taken.add(theme.search)
          const wait = last + gapMs - Date.now()
          if (wait > 0) await new Promise((r) => setTimeout(r, wait))
          if (!alive) return
          last = Date.now()
          try {
            const { markets } = await cournot.resolve(searchText(theme))
            const m = (markets ?? []).find((x) => x.title && new TextEncoder().encode(x.title).length <= 280 && !isPriceMarket(x.title))
            if (m) {
              result = theme === c.theme ? { market: m, theme, meme: c.meme, image: c.image } : { market: m, theme, meme: pick(theme.memes), image: pick(theme.images) }
              break
            }
          } catch {
            /* try the next theme */
          }
        }
        if (!alive) return
        setFound((f) => ({ ...f, [c.key]: result }))
      }
    })()
    return () => {
      alive = false
    }
  }, [cards, cournot, gapMs])

  const launch = async (c: QuickCard) => {
    if (!connected || busy || active) return
    setActive(c.key)
    try {
      if (c.kind === 'price') {
        const feed = feedOf(c.asset)!
        const step = parseEther(String(STRIKE_STEP[c.asset]))
        await onSubmit(() => {
          const now = Math.floor(Date.now() / 1000)
          const price = latestPrice.current(feed)
          return {
            name: c.meme.name,
            symbol: c.meme.symbol,
            imageURI: c.image,
            feed,
            strike: niceStrike(price ?? 0n, 0, step),
            settleTime: BigInt(now + c.seconds + (c.fast ? QUICK_SLACK : 0)),
            cutBps: QUICK_CUT,
            target: minTarget,
            question: '',
            marketId: 0n,
          }
        })
        return
      }
      const f = found[c.key]
      if (!f || f === 'none') return
      // Tell the sequencer which market this is (matched by title + end time); the answer is not shown.
      try {
        await cournot.probability(f.market.title, String(f.market.id), { title: f.market.title, endTime: f.market.endTime })
      } catch {
        /* the sequencer still finds the market by the question text */
      }
      await onSubmit(() => ({
        name: f.meme.name,
        symbol: f.meme.symbol,
        imageURI: f.image,
        feed: NATIVE,
        strike: 0n,
        settleTime: BigInt(eventSettle(f.market, Math.floor(Date.now() / 1000), config.maxDuration)),
        cutBps: QUICK_CUT,
        target: minTarget,
        question: f.market.title,
        marketId: BigInt(f.market.id),
      }))
    } finally {
      setActive(null)
    }
  }

  return (
    <div className="quick">
      <p className="muted lead">
        Pick one and launch in a click. Each launch raises {fmtTarget(minTarget)} {q} with a 10% cut; names and logos are fresh on every visit.
      </p>
      <div className="quick-grid" data-testid="quick-grid">
        {cards.map((c) => {
          const f = c.kind === 'event' ? found[c.key] : undefined
          const meme = f && f !== 'none' ? f.meme : c.meme
          const image = f && f !== 'none' ? f.image : c.image
          let title: string
          let when: string
          let ready: boolean
          let tag: string | null = null
          if (c.kind === 'price') {
            const feed = feedOf(c.asset)
            const price = feed ? priceOf(feed) : null
            title = `${c.asset} ≥ ${price != null ? fmtPrice(niceStrike(price, 0, parseEther(String(STRIKE_STEP[c.asset])))) : '…'} in ${span(c.seconds)}?`
            when = `Settles in ${span(c.seconds)}`
            ready = !!feed && price != null
            tag = c.fast ? 'Fast demo' : null
          } else if (!f) {
            title = searchText(c.theme)
            when = 'Finding a Cournot market…'
            ready = false
          } else if (f === 'none') {
            title = searchText(c.theme)
            when = 'No live Cournot market right now'
            ready = false
          } else {
            title = f.market.title
            const end = eventSettle(f.market, Math.floor(Date.now() / 1000), config.maxDuration)
            when = `Settles ${settleLabel(end)} (in ${duration(end - Math.floor(Date.now() / 1000))})`
            ready = true
            tag = 'Cournot'
          }
          const mine = active === c.key
          return (
            <div key={c.key} className="panel quick-card" data-testid="quick-card">
              <div className="lc-head">
                <CoinAvatar name={meme.name} image={image} size={44} />
                <div className="quick-id">
                  <div className="lc-name">{meme.name}</div>
                  <div className="muted mono">${meme.symbol}</div>
                </div>
                {tag && <span className={`quick-tag ${c.kind === 'price' && c.fast ? 'fast' : ''}`}>{tag}</span>}
              </div>
              <div className="lc-question quick-q">{title}</div>
              <div className="muted small">{when}</div>
              <button
                type="button"
                className="btn primary"
                disabled={!connected || !ready || !!busy || !!active}
                title={connected ? undefined : 'Connect a wallet first'}
                onClick={() => void launch(c)}
              >
                {mine && busy ? (
                  <>
                    <Spinner /> {busy}
                  </>
                ) : mine ? (
                  <>
                    <Spinner /> Preparing…
                  </>
                ) : c.kind === 'event' && !f ? (
                  <>
                    <Spinner size={11} /> Launch
                  </>
                ) : (
                  'Launch'
                )}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const fmtTarget = (wei: bigint) => (Number(wei / 10n ** 16n) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })
