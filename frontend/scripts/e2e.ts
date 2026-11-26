// End-to-end smoke on the local fork (run by scripts/e2e.sh; LOCAL ONLY, public anvil dev keys).
//
//   node --experimental-strip-types scripts/e2e.ts --api ... --rpc ... --deploy ../.dev/deploy.json
//
// One BTCB launch settling 10 min out (strike = current price, cut 10%, target = minTarget: 4.3 BNB,
// or 3,000 USDT with a USDT quote). Bot UP (anvil #1) buys only Up and bot DOWN (anvil #2) buys only
// Down, minting ~1.2x the pairs the target needs (55 BNB; 36,000 USDT) before
// settlement. Then, with real time (no shortcuts), the keeper snapshots, resolves, redeems and
// graduates. Asserts: token ends in 7777, a PancakeSwap pair exists, the loser claims > 0 tokens,
// the winner's balance (Exchange for native, wallet for an ERC20 quote) rose by exactly (1 − cut) per winning share, softReversals == 0.

import { erc20Abi, parseAbi, zeroAddress, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { exchangeAbi } from '../src/lib/chain.ts'
import { ANVIL_KEYS, E18, FEEDS, arg, setup, sleep, type Bot } from './lib.ts'

const S = setup(arg('rpc', 'http://127.0.0.1:8545')!, arg('api', 'http://127.0.0.1:8787')!, arg('deploy', '../.dev/deploy.json')!)
const SETTLE_IN = BigInt(arg('settle-in', '600')!)
const K = BigInt(S.K)
const CUT = 1000

const ROUTER: Address = '0xc9D63ddCB9549578057EAB6A83a543DdFEE2b8c3'
const WBNB: Address = '0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd'
const pancake = parseAbi(['function factory() view returns (address)', 'function getPair(address, address) view returns (address)'])
const extra = parseAbi(['function claimTokens(uint256 launchId)'])

const t0 = Date.now()
const log = (s: string) => console.log(`e2e [${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${s}`)
function check(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`E2E FAIL: ${msg}`)
    process.exit(1)
  }
  log(`ok: ${msg}`)
}

// Native quote: payouts land in the Exchange balance. ERC20 quote (approve-only): in the wallet.
const bal = (u: Address) => S.tradable(u)
const pos = (id: bigint, u: Address) => S.pc.readContract({ address: S.deploy.exchange, abi: exchangeAbi, functionName: 'position', args: [id, u] })

async function idle() {
  for (let i = 0; i < 120; i++) {
    const s = await S.get<{ pendingFills: number; inflight: boolean }>('/api/status')
    if (s.pendingFills === 0 && !s.inflight) return
    await sleep(500)
  }
  throw new Error('sequencer never went idle')
}

async function main() {
  const creator = privateKeyToAccount(ANVIL_KEYS[4])
  const now = await S.chainNow()
  const strike = await S.feedPrice(FEEDS.BTC)
  const target = await S.minTarget()
  // ~1.2x the pairs the target needs at this cut, in whole multiples of 5 so the 5 rounds are equal
  const step = 5n * E18
  const PAIRS = (((target * 10000n * 12n) / (BigInt(CUT) * 10n) + step - 1n) / step) * step
  const settleTime = now + SETTLE_IN
  const { id, token, rail } = await S.createLaunch(creator, {
    name: 'E2E Coin', symbol: 'E2E', imageURI: '', feed: FEEDS.BTC, strike, settleTime, cutBps: CUT, target, question: '', marketId: 0n,
  })
  log(`launch #${id} token ${token}, strike ${Number(strike) / 1e18}, settles at ${settleTime} (in ${SETTLE_IN} s)`)
  check(token.toLowerCase().endsWith('7777'), `token ${token} ends in 7777`)
  log(`warmed the fork for graduation in ${await S.warmGraduation(rail, id, (PAIRS * BigInt(CUT)) / 10000n)} ms`)

  const up: Bot = await S.makeBot(privateKeyToAccount(ANVIL_KEYS[1]), 50n * E18 * K)
  const down: Bot = await S.makeBot(privateKeyToAccount(ANVIL_KEYS[2]), 50n * E18 * K)
  for (let i = 0; i < 60 && !(await S.get(`/api/launch/${id}`).then(() => true).catch(() => false)); i++) await sleep(500)

  // 5 rounds of: DOWN rests a Buy Down at 50, UP takes it with a Buy Up at 52 -> Mint at 50/50.
  let minted = 0n
  for (let i = 0; i < 5; i++) {
    const size = PAIRS / 5n
    await S.place(down, id, 1, 0, 50, size, { expiry: settleTime })
    const r = await S.place(up, id, 0, 0, 52, size, { ioc: true })
    minted += r.fills.reduce((s, f) => s + BigInt(f.amount), 0n)
  }
  check(minted === PAIRS, `minted ${Number(minted) / 1e18} pairs (soft)`)
  await idle()
  const [pu, pd] = await Promise.all([pos(id, up.owner), pos(id, down.owner)])
  check(pu[0] === PAIRS && pd[1] === PAIRS, `onchain positions: UP holds ${Number(pu[0]) / 1e18} Up, DOWN holds ${Number(pd[1]) / 1e18} Down`)
  const l0 = await S.get<{ pairs: string; projectedRaised: string }>(`/api/launch/${id}`)
  log(`projected raised ${Number(BigInt(l0.projectedRaised)) / 1e18} ${S.Q} of ${Number(target) / 1e18}`)
  const before = { up: await bal(up.owner), down: await bal(down.owner) }

  log('waiting for settlement, resolution and graduation (real time)...')
  let l: { status: number | string; outcome: number | string; settlePrice: string; raised: string; token: Address } = await S.get(`/api/launch/${id}`)
  let lastStatus = ''
  while (Number(l.status) !== 2) {
    const tnow = await S.chainNow()
    if (Number(l.status) === 3) {
      console.error('E2E FAIL: launch failed', JSON.stringify(l))
      process.exit(1)
    }
    if (tnow > settleTime + 300n) {
      console.error('E2E FAIL: not graduated 5 min after settlement', JSON.stringify(l))
      process.exit(1)
    }
    const st = `status ${l.status} snapped ${(l as { snapped?: boolean }).snapped} resolved ${(l as { resolved?: boolean }).resolved}`
    if (st !== lastStatus) {
      log(`${st} (settle ${tnow >= settleTime ? '+' : '-'}${tnow >= settleTime ? tnow - settleTime : settleTime - tnow} s)`)
      lastStatus = st
    }
    await sleep(3000)
    l = await S.get(`/api/launch/${id}`)
  }
  const outcome = Number(l.outcome)
  log(`graduated: outcome ${outcome === 0 ? 'Up' : outcome === 1 ? 'Down' : 'Void'}, settle price ${Number(BigInt(l.settlePrice)) / 1e18}, raised ${Number(BigInt(l.raised)) / 1e18} ${S.Q}`)
  check(outcome === 0 || outcome === 1, 'non-void outcome')
  check(BigInt(l.raised) === (PAIRS * BigInt(CUT)) / 10000n, `raised = pairs × cut = ${Number(BigInt(l.raised)) / 1e18} ${S.Q}`)
  check(l.token.toLowerCase() === token.toLowerCase(), 'graduated token is the registered token')

  const f = await S.pc.readContract({ address: ROUTER, abi: pancake, functionName: 'factory' })
  const pair = await S.pc.readContract({ address: f, abi: pancake, functionName: 'getPair', args: [token, S.native ? WBNB : S.quote] })
  check(pair !== zeroAddress, `PancakeSwap ${S.native ? 'WBNB' : 'USDT'} pair ${pair} exists`)
  if (!S.native) {
    const pq = await S.pc.readContract({ address: S.quote, abi: erc20Abi, functionName: 'balanceOf', args: [pair] })
    check(pq === BigInt(l.raised), `pair holds the ${Number(pq) / 1e18} USDT raise`)
  }

  const [winner, loser] = outcome === 0 ? [up, down] : [down, up]
  const wantRise = (PAIRS * BigInt(10000 - CUT)) / 10000n
  // The keeper redeems every holder; wait until the winner's position is cleared.
  for (let i = 0; i < 60; i++) {
    const p = await pos(id, winner.owner)
    if (p[0] === 0n && p[1] === 0n) break
    await sleep(1000)
  }
  const rise = (await bal(winner.owner)) - (outcome === 0 ? before.up : before.down)
  check(rise === wantRise, `winner balance rose by ${Number(rise) / 1e18} ${S.Q} = (1 − cut) × ${Number(PAIRS) / 1e18} winning shares`)

  const tb0 = await S.pc.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [loser.owner] })
  await S.send(loser.acct, { address: S.deploy.exchange, abi: extra, functionName: 'claimTokens', args: [id] })
  const tb1 = await S.pc.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [loser.owner] })
  check(tb1 - tb0 > 0n, `loser claimed ${Number(tb1 - tb0) / 1e18} tokens`)

  const status = await S.get<{ softReversals: number }>('/api/status')
  check(Number(status.softReversals) === 0, 'softReversals == 0')
  console.log('E2E OK')
  process.exit(0)
}

main().catch((e) => {
  console.error('E2E FAIL:', e)
  process.exit(1)
})
