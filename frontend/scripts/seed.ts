// Local demo seeding on the BSC-testnet fork (LOCAL ONLY: public anvil dev keys).
//
//   node --experimental-strip-types scripts/seed.ts --api http://127.0.0.1:8787 \
//     --rpc http://127.0.0.1:8545 --deploy ../.dev/deploy.json [--live]
//
// Creates 2 launches through Portal.newLauncher + our factory (anvil #3 is the creator):
//   BTC: strike = current price, settles in 15 min, cut 10%, target 2.15 BNB (2,150 USDT)
//   BNB:  strike = current price + 1%, settles in 30 min, cut 30%, target 3 BNB (3,000 USDT)
// Plus one question launch (SPEC "Question launches"): resolves "Will it rain in Boston on <tomorrow>?"
// through /api/cournot/resolve, takes the first market, settles in 20 min, cut 10%, target 2.15 BNB;
// skipped (logged) when resolve fails or finds nothing. Its bots quote around the Cournot opening
// probability (round(p × 100), clamped 3..97; 50 until the sequencer has one) instead of fairUpCents.
// With a USDT quote (deploy.json quoteToken) every amount is x1000 (S.K) and bots mint their USDT.
// Funds 3 bots (anvil #5 maker, #6 and #7 takers), deposits, authorizes one trading key each, and
// seeds the books. --live keeps going: the maker re-quotes both sides around
// pUp = Φ((price − strike) / (σ·price·sqrt(timeLeft))) every few seconds and the takers cross it, so
// open interest passes each target before settlement. When no launch is tradable any more, a new
// pair of launches is created so the demo never goes quiet.

import { privateKeyToAccount } from 'viem/accounts'
import { parseEther } from 'viem'
import { NATIVE } from '../src/lib/chain.ts'
import { ANVIL_KEYS, E18, FEEDS, UNIT, arg, fairUpCents, oracleCents, setup, sleep, tomorrowLabel, type Bot } from './lib.ts'

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
}

async function createPair(): Promise<Mkt[]> {
  const now = await S.chainNow()
  const btc = await S.feedPrice(FEEDS.BTC)
  const bnb = await S.feedPrice(FEEDS.BNB)
  const defs = [
    { name: 'Bitcoin Believer', symbol: 'BELIEVE', feed: FEEDS.BTC, strike: btc, settleTime: now + 15n * 60n, cutBps: 1000, target: parseEther('2.15') * K },
    { name: 'BNB Moon', symbol: 'BMOON', feed: FEEDS.BNB, strike: (bnb * 101n) / 100n, settleTime: now + 30n * 60n, cutBps: 3000, target: parseEther('3') * K },
  ]
  const out: Mkt[] = []
  for (const d of defs) {
    const { id, token, rail } = await S.createLaunch(CREATOR, { ...d, imageURI: '', question: '', marketId: 0n })
    console.log(`seed: launch #${id} ${d.symbol} token ${token} strike ${Number(d.strike) / 1e18} settles in ${Number(d.settleTime - now)} s`)
    out.push({ id, rail, strike: d.strike, settleTime: d.settleTime, feed: d.feed, target: d.target, cutBps: d.cutBps })
  }
  return out
}

/** One question launch on tomorrow's Boston rain market, or null (logged) when Cournot has none. */
async function createQuestion(): Promise<Mkt | null> {
  const question = `Will it rain in Boston on ${tomorrowLabel()}?`
  let marketId: bigint
  try {
    const r = await S.post<{ markets?: { id: number | string; title: string }[] }>('/api/cournot/resolve', { message: question })
    const first = r.markets?.[0]
    if (!first) {
      console.log(`seed: no Cournot market for "${question}"; skipping the question launch`)
      return null
    }
    marketId = BigInt(first.id)
    console.log(`seed: Cournot market #${first.id} "${first.title}"`)
  } catch (e) {
    console.log(`seed: Cournot resolve failed (${(e as Error).message.split('\n')[0]}); skipping the question launch`)
    return null
  }
  const now = await S.chainNow()
  const d = { name: 'Boston Rain', symbol: 'RAIN', feed: NATIVE, strike: 0n, settleTime: now + 20n * 60n, cutBps: 1000, target: parseEther('2.15') * K }
  try {
    const { id, token, rail } = await S.createLaunch(CREATOR, { ...d, imageURI: '', question, marketId })
    console.log(`seed: question launch #${id} ${d.symbol} token ${token} market ${marketId} settles in ${Number(d.settleTime - now)} s`)
    return { id, rail, strike: 0n, settleTime: d.settleTime, feed: NATIVE, target: d.target, cutBps: d.cutBps, oracleCents: null }
  } catch (e) {
    console.log(`seed: question launch failed: ${(e as Error).message.split('\n')[0]}`)
    return null
  }
}

/** Price pair + the question launch (if Cournot has a market). */
async function createAll(): Promise<Mkt[]> {
  const out = await createPair()
  const q = await createQuestion()
  if (q) out.push(q)
  return out
}

/** Maker ladder: 3 levels on each side around the fair price (Up bids + Down bids = Up asks). */
async function quote(maker: Bot, m: Mkt, fair: number) {
  await S.cancelAll(maker, m.id)
  for (let i = 0; i < 3; i++) {
    const bid = fair - 1 - i * 2
    const ask = fair + 1 + i * 2
    const size = shares(rnd(2, 5))
    if (bid >= 1) await S.place(maker, m.id, 0, 0, bid, size, { expiry: m.settleTime })
    if (ask <= 99) await S.place(maker, m.id, 1, 0, 100 - ask, size, { expiry: m.settleTime })
  }
}

/** A taker crosses the maker's quote: buying Up or Down mints new pairs. */
async function take(taker: Bot, m: Mkt, fair: number) {
  const up = Math.random() < 0.5
  const px = up ? Math.min(99, fair + 3) : Math.min(99, 100 - fair + 3)
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
  if (p == null) return 50
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
          console.log('seed: every launch settled; creating a new set')
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
