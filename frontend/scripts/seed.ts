// Local demo seeding on the BSC-testnet fork (LOCAL ONLY: public anvil dev keys).
//
//   node --experimental-strip-types scripts/seed.ts --api http://127.0.0.1:8787 \
//     --rpc http://127.0.0.1:8545 --deploy ../.dev/deploy.json [--live]
//
// Creates 2 launches through Portal.newLauncher + our factory (anvil #4 is the creator):
//   BTCB: strike = current price, settles in 15 min, cut 10%, target 2.15 BNB
//   BNB:  strike = current price + 1%, settles in 30 min, cut 30%, target 3 BNB
// Funds 3 bots (anvil #5 maker, #6 and #7 takers), deposits, authorizes one trading key each, and
// seeds the books. --live keeps going: the maker re-quotes both sides around
// pUp = Φ((price − strike) / (σ·price·sqrt(timeLeft))) every few seconds and the takers cross it, so
// open interest passes each target before settlement. When no launch is tradable any more, a new
// pair of launches is created so the demo never goes quiet.

import { privateKeyToAccount } from 'viem/accounts'
import { parseEther } from 'viem'
import { ANVIL_KEYS, E18, FEEDS, UNIT, arg, fairUpCents, setup, sleep, type Bot } from './lib.ts'

const RPC = arg('rpc', 'http://127.0.0.1:8545')!
const API = arg('api', 'http://127.0.0.1:8787')!
const LIVE = process.argv.includes('--live')
const S = setup(RPC, API, arg('deploy', '../.dev/deploy.json')!)

const CREATOR = privateKeyToAccount(ANVIL_KEYS[4])
const rnd = (a: number, b: number) => a + Math.random() * (b - a)
const shares = (x: number) => (BigInt(Math.round(x * 100)) * UNIT) // x shares, 0.01 granularity

interface Mkt {
  id: bigint
  strike: bigint
  settleTime: bigint
  feed: `0x${string}`
  target: bigint
  cutBps: number
}

async function createPair(): Promise<Mkt[]> {
  const now = await S.chainNow()
  const btc = await S.feedPrice(FEEDS.BTCB)
  const bnb = await S.feedPrice(FEEDS.BNB)
  const defs = [
    { name: 'Bitcoin Believer', symbol: 'BELIEVE', feed: FEEDS.BTCB, strike: btc, settleTime: now + 15n * 60n, cutBps: 1000, target: parseEther('2.15') },
    { name: 'BNB Moon', symbol: 'BMOON', feed: FEEDS.BNB, strike: (bnb * 101n) / 100n, settleTime: now + 30n * 60n, cutBps: 3000, target: parseEther('3') },
  ]
  const out: Mkt[] = []
  for (const d of defs) {
    const { id, token } = await S.createLaunch(CREATOR, { ...d, imageURI: '' })
    console.log(`seed: launch #${id} ${d.symbol} token ${token} strike ${Number(d.strike) / 1e18} settles in ${Number(d.settleTime - now)} s`)
    out.push({ id, strike: d.strike, settleTime: d.settleTime, feed: d.feed, target: d.target, cutBps: d.cutBps })
  }
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

async function fair(m: Mkt): Promise<number> {
  const [price, now] = await Promise.all([S.feedPrice(m.feed), S.chainNow()])
  return fairUpCents(price, m.strike, Number(m.settleTime - now))
}

async function main() {
  console.log('seed: creating launches')
  let mkts = await createPair()
  console.log('seed: funding bots #5 #6 #7 and authorizing trading keys')
  const [maker, t1, t2] = await Promise.all([5, 6, 7].map((i) => S.makeBot(privateKeyToAccount(ANVIL_KEYS[i]), 300n * E18)))
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
          console.log('seed: every launch settled; creating a new pair')
          mkts = await createPair()
        }
        continue
      }
      tick++
      for (const m of open) {
        const f = await fair(m)
        if (tick % 3 === 0) await quote(maker, m, f)
        if (Math.random() < 0.7) await take(takers[tick % 2], m, f)
      }
      if (tick % 10 === 0) {
        const ls = await S.get<{ id: number; symbol: string; pairs: string; projectedRaised: string; target: string; upPrice: number | null }[]>('/api/launches')
        for (const l of ls.filter((l) => open.some((m) => Number(m.id) === Number(l.id))))
          console.log(`seed: #${l.id} ${l.symbol} pairs ${Number(BigInt(l.pairs)) / 1e18} projected ${Number(BigInt(l.projectedRaised)) / 1e18}/${Number(BigInt(l.target)) / 1e18} BNB up ${l.upPrice}`)
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
