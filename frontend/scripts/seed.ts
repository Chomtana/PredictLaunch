// Local demo seeding on the BSC-testnet fork (LOCAL ONLY: public anvil dev keys).
//
//   node --experimental-strip-types scripts/seed.ts --api http://127.0.0.1:8787 \
//     --rpc http://127.0.0.1:8545 --deploy ../.dev/deploy.json [--live]
//
// Each round creates 2-3 price launches and 1-2 Cournot question launches through Portal.newLauncher +
// our factory (anvil #3 is the creator), picked at random from src/lib/catalog.ts:
//   price:    a random BTC/BNB/ETH meme (name, symbol, coin icon), strike = live price -0.3%..+0.5% rounded
//             to a nice number, settles in 10-30 min, random cut 10-30%, target 2.15-4 BNB (x1000 USDT)
//   question: a random real-world theme (weather, Fed, Starship, football...) searched on Cournot through
//             /api/cournot/resolve; the best market's exact title becomes the question, with a meme name and
//             a matching photo. Settles in 15-30 min. A theme with no market is skipped (logged).
// Question bots quote around the Cournot opening probability (round(p x 100), clamped 3..97); until the
// sequencer has it, around the market's live yes price from resolve, else 50.
// With a USDT quote (deploy.json quoteToken) every amount is x1000 (S.K) and bots mint their USDT.
// Funds 3 bots (anvil #5 maker, #6 and #7 takers), deposits, authorizes one trading key each, and
// seeds the books. --live keeps going: the maker re-quotes both sides around
// pUp = Φ((price − strike) / (σ·price·sqrt(timeLeft))) every few seconds and the takers cross it, so
// open interest passes each target before settlement. When no launch is tradable any more, a new
// round is created so the demo never goes quiet.

import { privateKeyToAccount } from 'viem/accounts'
import { parseEther, type Address } from 'viem'
import { NATIVE } from '../src/lib/chain.ts'
import { ANVIL_KEYS, E18, FEEDS, UNIT, arg, fairUpCents, niceStrike, oracleCents, setup, sleep, tomorrowLabel, type Bot } from './lib.ts'
import { ICONS, PRICE_MEMES, QUESTIONS, STRIKE_STEP, isPriceMarket, pick, shuffle, type Asset, type Meme } from '../src/lib/catalog.ts'

const RPC = arg('rpc', 'http://127.0.0.1:8545')!
const API = arg('api', 'http://127.0.0.1:8787')!
const LIVE = process.argv.includes('--live')
const S = setup(RPC, API, arg('deploy', '../.dev/deploy.json')!)

const CREATOR = privateKeyToAccount(ANVIL_KEYS[3])
const rnd = (a: number, b: number) => a + Math.random() * (b - a)
const shares = (x: number) => (BigInt(Math.round(x * S.K * 100)) * UNIT) // x (x K) shares, 0.01 granularity
const K = BigInt(S.K)

interface Mkt {
  id: bigint
  rail: `0x${string}`
  strike: bigint
  settleTime: bigint
  feed: `0x${string}`
  target: bigint
  cutBps: number
  /** question launches: the Cournot opening price in cents, once the sequencer has it */
  oracleCents?: number | null
  /** question launches: the market's live yes price (cents) from resolve, quoted until the opening is known */
  resolveCents?: number | null
}

/** Symbols already launched this session; a meme is reused only once its list runs out. */
const used = new Set<string>()
function freshMeme(memes: Meme[]): Meme {
  const fresh = memes.filter((m) => !used.has(m.symbol))
  const m = pick(fresh.length ? fresh : memes)
  used.add(m.symbol)
  return m
}

const CUTS = [1000, 1500, 2000, 2500, 3000]
/** Strike vs the live price, in bps: mostly near the money so both sides trade. */
const STRIKE_OFFSETS = [-30, -15, 0, 0, 10, 20, 35, 50]

/** `four`: create on Four.meme through the OpenFour rail instead of Flap. */
async function createPrice(asset: Asset, four: Address | null = null): Promise<Mkt> {
  const now = await S.chainNow()
  const feed = FEEDS[asset]
  const minutes = pick([10, 12, 15, 20, 25, 30])
  const d = {
    ...freshMeme(PRICE_MEMES[asset]),
    feed,
    strike: niceStrike(await S.feedPrice(feed), pick(STRIKE_OFFSETS), parseEther(String(STRIKE_STEP[asset]))),
    settleTime: now + BigInt(minutes * 60),
    cutBps: pick(CUTS),
    // bigger raises only when there is time to fill them
    target: parseEther(pick(minutes >= 20 ? ['2.15', '2.5', '3', '3.5', '4'] : ['2.15', '2.5', '3'])) * K,
  }
  const c = { ...d, imageURI: ICONS[asset], question: '', marketId: 0n }
  const { id, token, rail } = four ? await S.createFourLaunch(CREATOR, four, c) : await S.createLaunch(CREATOR, c)
  console.log(`seed: launch #${id} on ${four ? 'Four.meme' : 'Flap'} $${d.symbol} "${d.name}" ${asset} >= ${Number(d.strike) / 1e18} in ${minutes} min, cut ${d.cutBps / 100}%, token ${token}`)
  return { id, rail, strike: d.strike, settleTime: d.settleTime, feed, target: d.target, cutBps: d.cutBps }
}

interface ResolvedMarket {
  id: number | string
  title: string
  yesPrice?: number | null
}

let lastResolve = 0
/** /api/cournot/resolve, spaced past the sequencer's per-IP limit (one call every 2 s). */
async function resolve(message: string): Promise<ResolvedMarket[]> {
  const wait = lastResolve + 2200 - Date.now()
  if (wait > 0) await sleep(wait)
  lastResolve = Date.now()
  const r = await S.post<{ markets?: ResolvedMarket[] }>('/api/cournot/resolve', { message })
  return r.markets ?? []
}

/** A question launch on a random catalog theme, or null (logged) when Cournot has no market for it. */
async function createQuestion(): Promise<Mkt | null> {
  for (const theme of shuffle(QUESTIONS).slice(0, 4)) {
    const search = theme.search.replace('{tomorrow}', tomorrowLabel())
    let market: ResolvedMarket | undefined
    try {
      market = (await resolve(search)).find((m) => m.title && Buffer.byteLength(m.title) <= 280 && !isPriceMarket(m.title))
    } catch (e) {
      console.log(`seed: Cournot resolve failed for "${search}" (${(e as Error).message.split('\n')[0]})`)
      continue
    }
    if (!market) {
      console.log(`seed: no Cournot market for "${search}"; trying another theme`)
      continue
    }
    const now = await S.chainNow()
    const minutes = pick([15, 20, 25, 30])
    const d = {
      ...freshMeme(theme.memes),
      feed: NATIVE,
      strike: 0n,
      settleTime: now + BigInt(minutes * 60),
      cutBps: pick(CUTS),
      target: parseEther(pick(['2.15', '2.5', '3'])) * K,
    }
    try {
      const { id, token, rail } = await S.createLaunch(CREATOR, { ...d, imageURI: pick(theme.images), question: market.title, marketId: BigInt(market.id) })
      console.log(`seed: question launch #${id} $${d.symbol} "${d.name}": "${market.title}" in ${minutes} min, token ${token}`)
      const resolveCents = market.yesPrice == null ? null : oracleCents(market.yesPrice)
      return { id, rail, strike: 0n, settleTime: d.settleTime, feed: NATIVE, target: d.target, cutBps: d.cutBps, oracleCents: null, resolveCents }
    } catch (e) {
      console.log(`seed: question launch failed: ${(e as Error).message.split('\n')[0]}`)
      return null
    }
  }
  console.log('seed: no Cournot theme matched a market; this round has no question launch')
  return null
}

/** One round: 2-3 price launches on distinct assets + 1-2 question launches. */
async function createAll(): Promise<Mkt[]> {
  const out: Mkt[] = []
  // Flap by default; when the sequencer has an OpenFour rail, one price launch per round goes to Four.meme.
  const four = await S.fourRail()
  const assets = shuffle<Asset>(['BTC', 'BNB', 'ETH']).slice(0, pick([2, 3]))
  for (const [i, asset] of assets.entries()) out.push(await createPrice(asset, i === 0 ? four : null))
  for (let i = pick([1, 2]); i > 0; i--) {
    const q = await createQuestion()
    if (q) out.push(q)
  }
  return out
}

/**
 * A winning share pays 1 − cut, so neither side is worth more than (100 − cut)¢: an Up price p is a Down
 * price 100 − p, which keeps every quote inside [cut, 100 − cut]¢.
 */
function band(m: Mkt): [number, number] {
  const lo = Math.ceil(m.cutBps / 100)
  return [lo, 100 - lo]
}

/** Maker ladder: 3 levels on each side around the fair price (Up bids + Down bids = Up asks), inside the band. */
async function quote(maker: Bot, m: Mkt, fair: number) {
  await S.cancelAll(maker, m.id)
  const [lo, hi] = band(m)
  for (let i = 0; i < 3; i++) {
    const bid = fair - 1 - i * 2
    const ask = fair + 1 + i * 2
    const size = shares(rnd(2, 5))
    if (bid >= lo && bid <= hi) await S.place(maker, m.id, 0, 0, bid, size, { expiry: m.settleTime })
    if (ask >= lo && ask <= hi) await S.place(maker, m.id, 1, 0, 100 - ask, size, { expiry: m.settleTime })
  }
}

/** A taker crosses the maker's quote: buying Up or Down mints new pairs. */
async function take(taker: Bot, m: Mkt, fair: number) {
  const up = Math.random() < 0.5
  const hi = band(m)[1]
  const px = Math.min(hi, up ? fair + 3 : 100 - fair + 3)
  const r = await S.place(taker, m.id, up ? 0 : 1, 0, px, shares(rnd(0.5, 2.5)), { ioc: true })
  return r.fills.reduce((s, f) => s + BigInt(f.amount), 0n)
}

const isQuestion = (m: Mkt) => m.feed === NATIVE

/** The opening oracle probability: /api/launch/:id/oracle, else LaunchSummary.oracleProbability. Cached once known. */
async function questionFair(m: Mkt): Promise<number> {
  if (m.oracleCents != null) return m.oracleCents
  let p: number | null = null
  try {
    const o = await S.get<{ opening?: { probability?: number | null } | null }>(`/api/launch/${m.id}/oracle`)
    p = o.opening?.probability ?? null
  } catch {
    /* not served yet */
  }
  if (p == null) {
    try {
      p = (await S.get<{ oracleProbability?: number | null }>(`/api/launch/${m.id}`)).oracleProbability ?? null
    } catch {
      /* not indexed yet */
    }
  }
  if (p == null) return m.resolveCents ?? 50
  m.oracleCents = oracleCents(p)
  console.log(`seed: #${m.id} Cournot opening ${(p * 100).toFixed(1)}% -> quoting around ${m.oracleCents}¢`)
  return m.oracleCents
}

async function fair(m: Mkt): Promise<number> {
  if (isQuestion(m)) return questionFair(m)
  const [price, now] = await Promise.all([S.feedPrice(m.feed), S.chainNow()])
  return fairUpCents(price, m.strike, Number(m.settleTime - now))
}

async function main() {
  console.log('seed: creating launches')
  let mkts = await createAll()
  console.log(`seed: warmed the fork for graduation in ${await S.warmGraduation(mkts[0].rail, mkts[0].id, mkts[0].target)} ms`)
  console.log('seed: funding bots #5 #6 #7 and authorizing trading keys')
  const [maker, t1, t2] = await Promise.all([5, 6, 7].map((i) => S.makeBot(privateKeyToAccount(ANVIL_KEYS[i]), 300n * E18 * K)))
  const takers = [t1, t2]

  for (const m of mkts) await quote(maker, m, await fair(m))
  for (let i = 0; i < 4; i++) for (const m of mkts) await take(takers[i % 2], m, await fair(m))
  for (const m of mkts) await quote(maker, m, await fair(m))
  console.log('seed: done')
  if (!LIVE) return

  console.log('seed: live loop (Ctrl-C to stop)')
  let tick = 0
  for (;;) {
    await sleep(rnd(2000, 4000))
    try {
      const now = await S.chainNow()
      const open = mkts.filter((m) => m.settleTime > now + 3n)
      if (open.length === 0) {
        const anyActive = (await S.get<{ tradable?: boolean }[]>('/api/launches')).some((l) => l.tradable)
        if (!anyActive) {
          console.log('seed: every launch settled; creating a new round')
          mkts = await createAll()
        }
        continue
      }
      tick++
      if (tick % 10 === 0) for (const b of [maker, ...takers]) if (await S.topUp(b, 100n * E18 * K, 200n * E18 * K)) console.log(`seed: topped up ${b.owner}`)
      for (const m of open) {
        const f = await fair(m)
        if (tick % 3 === 0) await quote(maker, m, f)
        if (Math.random() < 0.7) await take(takers[tick % 2], m, f)
      }
      if (tick % 10 === 0) {
        const ls = await S.get<{ id: number; symbol: string; pairs: string; projectedRaised: string; target: string; upPrice: number | null }[]>('/api/launches')
        for (const l of ls.filter((l) => open.some((m) => Number(m.id) === Number(l.id))))
          console.log(`seed: #${l.id} ${l.symbol} pairs ${Number(BigInt(l.pairs)) / 1e18} projected ${Number(BigInt(l.projectedRaised)) / 1e18}/${Number(BigInt(l.target)) / 1e18} ${S.Q} up ${l.upPrice}`)
      }
    } catch (e) {
      console.log('seed: tick failed:', (e as Error).message.split('\n')[0])
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
