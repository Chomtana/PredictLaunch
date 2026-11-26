// Local demo seeding on the BSC-testnet fork (LOCAL ONLY: public anvil dev keys).
//
//   node --experimental-strip-types scripts/seed.ts --api http://127.0.0.1:8787 \
//     --rpc http://127.0.0.1:8545 --deploy ../.dev/deploy.json [--live]
//
// Each round creates 2-3 price launches and 1-2 Cournot question launches on Flap (Portal.newLauncher + our
// factory) and, when the sequencer has an OpenFour rail, one more price launch and one more question launch
// on Four.meme (FourRail.createLaunch). Anvil #3 is the creator; everything is picked at random from
// src/lib/catalog.ts:
//   price:    a random BTC/BNB/ETH meme (name, symbol, coin icon), strike = live price -0.3%..+0.5% rounded
//             to a nice number, settles in 10-30 min, random cut 10-30%, target 2.15-4 BNB (x1000 USDT)
//   question: a random real-world theme (weather, Fed, Starship, football...) searched on Cournot through
//             /api/cournot/resolve; the best market's exact title becomes the question, with a meme name and
//             a matching photo. Settles in 15-30 min. A theme with no market is skipped (logged).
// Question bots quote around the Cournot opening probability (round(p x 100), clamped 3..97); until the
// sequencer has it, around the market's live yes price from resolve, else 50.
// With a USDT quote (deploy.json quoteToken) every amount is x1000 (S.K) and bots mint their USDT.
// Funds 3 bots (anvil #5 maker, #6 and #7 takers), deposits, authorizes one trading key each, and
// seeds the books. --live keeps going on EVERY tradable launch the sequencer lists (ours or a user's): the
// maker always keeps a two-sided book around pUp = Φ((price − strike) / (σ·price·sqrt(timeLeft))) (question
// launches: the Cournot opening), and the takers are paced so each launch fills linearly and reaches its
// target at 80% of its life (creation -> settlement), never much earlier. One failing launch no longer
// stops the tick for the others. When no launch is tradable any more, a new round is created so the demo
// never goes quiet.

import { parseEther, type Address } from 'viem'
import { NATIVE } from '../src/lib/chain.ts'
import { E18, FEEDS, UNIT, arg, fairUpCents, niceStrike, oracleCents, roleAccount, setup, sleep, tomorrowLabel, type Bot } from './lib.ts'
import { ICONS, PRICE_MEMES, QUESTIONS, STRIKE_STEP, isPriceMarket, pick, shuffle, type Asset, type Meme } from '../src/lib/catalog.ts'

const RPC = arg('rpc', 'http://127.0.0.1:8545')!
const API = arg('api', 'http://127.0.0.1:8787')!
const LIVE = process.argv.includes('--live')
const S = setup(RPC, API, arg('deploy', '../.dev/deploy.json')!)

// Accounts from MNEMONIC (.env; default anvil's public one): 3 creator, 5 maker, 6/7 takers (scripts/keys.sh).
const CREATOR = roleAccount(3)
const DEPLOYER = roleAccount(0)

/** tBNB each seed account needs for gas (as in scripts/wallets.sh). Kept between 1x and 2x, refilled from the
 *  deployer at start and every GAS_CHECK_MS. */
const GAS_NEED: [number, string, bigint][] = [
  [3, 'creator', parseEther('0.1')],
  [5, 'maker', parseEther('0.02')],
  [6, 'taker1', parseEther('0.02')],
  [7, 'taker2', parseEther('0.02')],
]
const GAS_CHECK_MS = 15 * 60_000
let lastGasCheck = 0

/** Every GAS_CHECK_MS (or now with `force`): refill any seed account below its need to 2x its need. */
async function checkGas(force = false) {
  if (!force && Date.now() - lastGasCheck < GAS_CHECK_MS) return
  lastGasCheck = Date.now()
  try {
    const sent = await S.refillGas(DEPLOYER, GAS_NEED.map(([i, label, need]) => ({ acct: roleAccount(i), need, label })))
    for (const s of sent) console.log(`seed: gas refill ${s.label} ${s.address} +${Number(s.amount) / 1e18} BNB (back to 2x its need)`)
  } catch (e) {
    console.log(`seed: gas check failed: ${(e as Error).message.split('\n')[0]}`)
  }
}
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
  /** question launches whose oracle price is outside the band: a random fair price inside it, picked once */
  randomCents?: number
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

/** A question launch on a random catalog theme, or null (logged) when Cournot has no market for it.
 *  `four`: create it on Four.meme through the OpenFour rail instead of Flap. */
async function createQuestion(four: Address | null = null): Promise<Mkt | null> {
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
      const c = { ...d, imageURI: pick(theme.images), question: market.title, marketId: BigInt(market.id) }
      const { id, token, rail } = four ? await S.createFourLaunch(CREATOR, four, c) : await S.createLaunch(CREATOR, c)
      console.log(`seed: question launch #${id} on ${four ? 'Four.meme' : 'Flap'} $${d.symbol} "${d.name}": "${market.title}" in ${minutes} min, token ${token}`)
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

/** One round. Flap: 2-3 price launches on distinct assets + 1-2 question launches. Four.meme (when the
 *  sequencer has an OpenFour rail): one more price launch and one more question launch on top. */
async function createAll(): Promise<Mkt[]> {
  const out: Mkt[] = []
  const assets = shuffle<Asset>(['BTC', 'BNB', 'ETH']).slice(0, pick([2, 3]))
  for (const asset of assets) out.push(await createPrice(asset))
  for (let i = pick([1, 2]); i > 0; i--) {
    const q = await createQuestion()
    if (q) out.push(q)
  }
  const four = await S.fourRail()
  if (!four) {
    console.log('seed: the sequencer has no OpenFour rail; Flap launches only')
    return out
  }
  try {
    out.push(await createPrice(pick<Asset>(['BTC', 'BNB', 'ETH']), four))
  } catch (e) {
    console.log(`seed: Four.meme price launch failed: ${(e as Error).message.split('\n')[0]}`)
  }
  const q = await createQuestion(four)
  if (q) out.push(q)
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

/**
 * The quoting centre: the fair price pulled inside the band far enough for the whole 3-level ladder (±5¢).
 * A fair price past the band (a 4% or 97% Cournot market with a 20% cut) would otherwise drop every level and
 * leave the launch with no liquidity at all.
 */
function center(m: Mkt, fair: number): number {
  const [lo, hi] = band(m)
  return Math.min(hi - 5, Math.max(lo + 5, fair))
}

/** Maker ladder: 3 levels on each side around the fair price (Up bids + Down bids = Up asks), inside the band. */
async function quote(maker: Bot, m: Mkt, fairPx: number) {
  await S.cancelAll(maker, m.id)
  const [lo, hi] = band(m)
  const fair = center(m, fairPx)
  for (let i = 0; i < 3; i++) {
    const bid = fair - 1 - i * 2
    const ask = fair + 1 + i * 2
    const size = shares(rnd(2, 5))
    if (bid >= lo && bid <= hi) await S.place(maker, m.id, 0, 0, bid, size, { expiry: m.settleTime })
    if (ask >= lo && ask <= hi) await S.place(maker, m.id, 1, 0, 100 - ask, size, { expiry: m.settleTime })
  }
}

/** A taker crosses the maker's quote: buying Up or Down mints new pairs. */
async function take(taker: Bot, m: Mkt, fairPx: number, size = shares(rnd(0.5, 2.5))) {
  const fair = center(m, fairPx)
  const up = Math.random() < 0.5
  const hi = band(m)[1]
  const px = Math.min(hi, up ? fair + 3 : 100 - fair + 3)
  const r = await S.place(taker, m.id, up ? 0 : 1, 0, px, size, { ioc: true })
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
  if (isQuestion(m)) {
    // An oracle price the band cannot hold (4% or 97% with a 20% cut): quote a random fair price inside the
    // band instead, kept for the launch's life so its book does not jump around.
    const p = await questionFair(m)
    const [lo, hi] = band(m)
    if (p >= lo + 5 && p <= hi - 5) return p
    if (m.randomCents == null) {
      m.randomCents = Math.round(rnd(lo + 5, hi - 5))
      console.log(`seed: #${m.id} oracle ${p}¢ is outside the ${lo}..${hi}¢ band -> quoting around a random ${m.randomCents}¢`)
    }
    return m.randomCents
  }
  const [price, now] = await Promise.all([S.feedPrice(m.feed), S.chainNow()])
  return fairUpCents(price, m.strike, Number(m.settleTime - now))
}

/** What the live loop needs from /api/launches. */
interface Summary {
  id: number
  rail: `0x${string}`
  feed: `0x${string}`
  strike: string
  settleTime: number
  createdAt: number
  cutBps: number
  target: string
  pairs: string
  projectedRaised: string
  symbol: string
  upPrice: number | null
  tradable: boolean
  kind: 'price' | 'question'
  oracleProbability?: number | null
}

/** The target is reached at this fraction of a launch's life (creation -> settlement), not earlier. */
const PACE = 0.8

/**
 * Pairs still missing to be on schedule: the target should fill linearly so it is reached at PACE of the
 * launch's life. 0 when on or ahead of schedule (also once the target is reached).
 */
function behindPairs(l: Summary, now: number): bigint {
  const life = l.settleTime - l.createdAt
  if (life <= 0 || l.cutBps === 0) return 0n
  const want = Math.min(1, Math.max(0, (now - l.createdAt) / (PACE * life)))
  // projectedRaised = pairs x cut: the target needs target / cut pairs
  const wantPairs = (BigInt(Math.round(want * 1e6)) * BigInt(l.target) * 10_000n) / (BigInt(l.cutBps) * 1_000_000n)
  const gap = wantPairs - BigInt(l.pairs)
  return gap > 0n ? gap : 0n
}

/** A Mkt for any launch the sequencer lists, ours or anyone's. Question launches quote around its oracle price. */
function toMkt(l: Summary, known?: Mkt): Mkt {
  const m: Mkt = known ?? {
    id: BigInt(l.id),
    rail: l.rail,
    strike: BigInt(l.strike),
    settleTime: BigInt(l.settleTime),
    feed: l.feed,
    target: BigInt(l.target),
    cutBps: l.cutBps,
    oracleCents: null,
    resolveCents: null,
  }
  if (m.oracleCents == null && l.kind === 'question' && l.oracleProbability != null) m.oracleCents = oracleCents(l.oracleProbability)
  return m
}

async function main() {
  await checkGas(true)
  console.log('seed: creating launches')
  const created = await createAll()
  console.log(`seed: warmed the fork for graduation in ${await S.warmGraduation(created[0].rail, created[0].id, created[0].target)} ms`)
  console.log('seed: funding bots #5 #6 #7 and authorizing trading keys')
  const [maker, t1, t2] = await Promise.all([5, 6, 7].map((i) => S.makeBot(roleAccount(i), 300n * E18 * K)))
  const takers = [t1, t2]

  for (const m of created) await quote(maker, m, await fair(m))
  if (!LIVE) {
    // One-shot seed: a little volume so the books are not empty; the live loop paces itself instead.
    for (let i = 0; i < 4; i++) for (const m of created) await take(takers[i % 2], m, await fair(m))
    for (const m of created) await quote(maker, m, await fair(m))
    console.log('seed: done')
    return
  }
  console.log('seed: done')

  // Every launch the sequencer lists, not only ours: user launches get the same maker and pace.
  const mkts = new Map<number, Mkt>(created.map((m) => [Number(m.id), m]))
  console.log(`seed: live loop on every tradable launch, paced to reach each target at ${PACE * 100}% of its life (Ctrl-C to stop)`)
  let tick = 0
  for (;;) {
    await sleep(rnd(2000, 4000))
    let open: Summary[]
    let now: number
    try {
      now = Number(await S.chainNow())
      open = (await S.get<Summary[]>('/api/launches')).filter((l) => l.tradable && l.settleTime > now + 3)
    } catch (e) {
      console.log('seed: tick failed:', (e as Error).message.split('\n')[0])
      continue
    }
    if (open.length === 0) {
      await checkGas()
      console.log('seed: no tradable launch left; creating a new round')
      try {
        for (const m of await createAll()) mkts.set(Number(m.id), m)
      } catch (e) {
        console.log('seed: new round failed:', (e as Error).message.split('\n')[0])
      }
      continue
    }
    tick++
    let reauthorized = false
    await checkGas()
    if (tick % 10 === 0) await topUpAll([maker, ...takers])
    // One market failing (settled mid-tick, a reverted order...) must not starve the others.
    for (const l of shuffle(open)) {
      const m = toMkt(l, mkts.get(l.id))
      mkts.set(l.id, m)
      try {
        const f = await fair(m)
        // The maker is never paced: every tradable launch has two-sided liquidity, whatever its settle time.
        if (tick % 3 === 0 || ![...maker.resting.values()].includes(m.id)) await quote(maker, m, f)
        const gap = behindPairs(l, now)
        if (gap > 0n) {
          // Close the gap in steps: at most ~5 (x K) pairs a tick so the chart moves smoothly.
          const size = gap < shares(0.1) ? shares(0.1) : gap > shares(5) ? shares(rnd(2.5, 5)) : gap
          await take(takers[(tick + l.id) % 2], m, f, size)
          // Refill what the take ate: every launch keeps a full book for real users at all times.
          await quote(maker, m, f)
        }
      } catch (e) {
        const msg = (e as Error).message.split('\n')[0]
        console.log(`seed: #${l.id} ${l.symbol} failed: ${msg}`)
        // A bot ran out of quote mid-tick: mint more right away instead of waiting for the periodic top-up.
        if (/insufficient_balance|not enough free/i.test(msg)) await topUpAll([maker, ...takers])
        // The sequencer lost our trading keys (a refused batch reverses the keys it authorized): new keys, once a tick.
        if (/bad_signature|key_expired/i.test(msg) && !reauthorized) {
          reauthorized = true
          for (const b of [maker, ...takers]) {
            try {
              await S.authorize(b)
              console.log(`seed: re-authorized a trading key for ${b.owner}`)
            } catch (err) {
              console.log(`seed: re-authorizing ${b.owner} failed: ${(err as Error).message.split('\n')[0]}`)
            }
          }
        }
      }
    }
    if (tick % 10 === 0) {
      for (const l of open) {
        const life = l.settleTime - l.createdAt
        const t = life > 0 ? Math.round(((now - l.createdAt) / life) * 100) : 100
        const pct = Math.round((Number(BigInt(l.projectedRaised)) / Number(BigInt(l.target))) * 100)
        console.log(`seed: #${l.id} ${l.symbol} ${t}% of life, ${pct}% of target (${Number(BigInt(l.projectedRaised)) / 1e18}/${Number(BigInt(l.target)) / 1e18} ${S.Q}) up ${l.upPrice}`)
      }
    }
    // Forget launches that are gone.
    for (const id of mkts.keys()) if (!open.some((l) => l.id === id)) mkts.delete(id)
  }
}

async function topUpAll(bots: Bot[]) {
  for (const b of bots) {
    try {
      if (await S.topUp(b, 100n * E18 * K, 200n * E18 * K)) console.log(`seed: topped up ${b.owner}`)
    } catch (err) {
      console.log(`seed: top-up of ${b.owner} failed: ${(err as Error).message.split('\n')[0]}`)
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
