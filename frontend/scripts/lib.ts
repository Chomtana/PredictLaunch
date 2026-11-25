// Shared helpers for the local-fork scripts (seed.ts, e2e.ts). LOCAL ONLY: public anvil dev keys.

import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, decodeEventLog, http, parseAbi, parseEther, type Address, type Hex, type LocalAccount } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { chainFor, encodeLaunchConfig, exchangeAbi, portalAbi, type LaunchConfig } from '../src/lib/chain.ts'
import { authorizeKeyMsg, cancelTyped, randomNonce, signAuthorizeKey, signOrder, type Domain, type Msg, type Order } from '../src/lib/eip712.ts'
import { PORTAL, mineSaltSync, predictToken, randomSeed } from '../src/lib/salt.ts'

export const E18 = 10n ** 18n
export const UNIT = 10n ** 16n

export function arg(k: string, d?: string): string | undefined {
  const i = process.argv.indexOf(`--${k}`)
  return i >= 0 ? process.argv[i + 1] : d
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Public anvil dev keys #0..#9. */
export const ANVIL_KEYS: Hex[] = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
  '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
  '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',
  '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97',
  '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6',
]

export const FEEDS = {
  BTCB: '0xe20536bc715aac6560394e33deb66ed205aeec33' as Address,
  BNB: '0xb3d1614bf894e68add1ea50ca250c152bad5256f' as Address,
}

export const feedAbi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
])

export const exchangeExtraAbi = parseAbi([
  'event LaunchCreated(uint256 launchId, address creator, address rail, address token, address feed, uint256 strike, uint64 settleTime, uint16 cutBps, uint256 target, string name, string symbol, string imageURI)',
  'function claimableTokens(uint256 id, address user) view returns (uint256)',
  'function loserShares(uint256 id, address user) view returns (uint256)',
])

export interface Deploy {
  exchange: Address
  factory: Address
  chainId: number
}

export function setup(rpc: string, api: string, deployPath: string) {
  const deploy = JSON.parse(readFileSync(deployPath, 'utf8')) as Deploy
  const chain = chainFor(97, rpc)
  const pc = createPublicClient({ chain, transport: http(rpc), pollingInterval: 500 })
  const D: Domain = { chainId: 97, exchange: deploy.exchange }

  async function get<T = any>(path: string): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const r = await fetch(api + path)
    const t = await r.text()
    if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${t.slice(0, 200)}`)
    return JSON.parse(t) as T
  }
  async function post<T = any>(path: string, body?: unknown): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const r = await fetch(api + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const t = await r.text()
    let j: { error?: string; message?: string; index?: number } = {}
    try {
      j = JSON.parse(t)
    } catch {
      /* not json */
    }
    if (!r.ok) {
      const e = new Error(`${j.error ?? r.status}: ${j.message ?? t.slice(0, 200)}`) as Error & { code?: string }
      e.code = j.error
      throw e
    }
    return j as T
  }

  const wallet = (acct: LocalAccount) => createWalletClient({ chain, transport: http(rpc), account: acct })

  async function send(acct: LocalAccount, req: { address: Address; abi: unknown; functionName: string; args?: unknown[]; value?: bigint }) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hash = await wallet(acct).writeContract({ ...(req as any), account: acct, chain })
    const rc = await pc.waitForTransactionReceipt({ hash })
    if (rc.status !== 'success') throw new Error(`${req.functionName} reverted (${hash})`)
    return rc
  }

  async function chainNow(): Promise<bigint> {
    return (await pc.getBlock()).timestamp
  }

  async function feedPrice(feed: Address): Promise<bigint> {
    const [, answer] = await pc.readContract({ address: feed, abi: feedAbi, functionName: 'latestRoundData' })
    return answer
  }

  /** Portal.newLauncher(factory, LaunchConfig) with a mined ...7777 salt. Returns the launch id. */
  async function createLaunch(acct: LocalAccount, c: Omit<LaunchConfig, 'salt'>): Promise<{ id: bigint; token: Address }> {
    const salt = mineSaltSync(randomSeed())
    const token = predictToken(salt)
    const fee = await pc.readContract({ address: PORTAL, abi: portalAbi, functionName: 'SALT_LOCK_FEE' })
    const rc = await send(acct, { address: PORTAL, abi: portalAbi, functionName: 'newLauncher', args: [deploy.factory, encodeLaunchConfig({ ...c, salt })], value: fee })
    for (const log of rc.logs) {
      if (log.address.toLowerCase() !== deploy.exchange.toLowerCase()) continue
      try {
        const ev = decodeEventLog({ abi: exchangeExtraAbi, data: log.data, topics: log.topics })
        if (ev.eventName === 'LaunchCreated') {
          if (ev.args.token.toLowerCase() !== token.toLowerCase()) throw new Error(`token ${ev.args.token} != predicted ${token}`)
          return { id: ev.args.launchId, token: ev.args.token }
        }
      } catch (e) {
        if ((e as Error).message.startsWith('token')) throw e
      }
    }
    throw new Error('no LaunchCreated event in the newLauncher receipt')
  }

  /** Fund (dev faucet, else anvil_setBalance), deposit into the Exchange, authorize a trading key. */
  async function makeBot(acct: LocalAccount, depositBnb: bigint): Promise<Bot> {
    try {
      await post('/api/faucet', { address: acct.address })
    } catch {
      await pc.request({ method: 'anvil_setBalance' as never, params: [acct.address, '0x' + parseEther('1000').toString(16)] as never })
    }
    const have = await pc.readContract({ address: deploy.exchange, abi: exchangeAbi, functionName: 'balanceOf', args: [acct.address] })
    if (have < depositBnb) await send(acct, { address: deploy.exchange, abi: exchangeAbi, functionName: 'deposit', value: depositBnb - have })
    await post('/api/poke')
    const key = privateKeyToAccount(generatePrivateKey())
    const a = { owner: acct.address, key: key.address, expiry: (await chainNow()) + 7n * 86400n, nonce: randomNonce() }
    const sig = await signAuthorizeKey(D, acct, a)
    await post('/api/msgs', [authorizeKeyMsg(a, sig)])
    return { owner: acct.address, acct, key, resting: new Map() }
  }

  interface PlaceResult {
    orderHash?: Hex
    fills: { price: number; amount: string; kind: number | string }[]
    resting: string
  }

  /** Place a limit order (price in its own outcome terms, cents). IOC when `ioc`. */
  async function place(b: Bot, launchId: bigint, outcome: 0 | 1, side: 0 | 1, price: number, amount: bigint, opts: { ioc?: boolean; expiry?: bigint } = {}) {
    const o: Order = {
      owner: b.owner,
      launchId,
      round: 0,
      outcome,
      side,
      price,
      amount: (amount / UNIT) * UNIT,
      expiry: opts.expiry ?? BigInt(Math.floor(Date.now() / 1000) + 3600),
      nonce: randomNonce(),
    }
    const { orderHash, msg } = await signOrder(D, b.key, o)
    const msgs: Msg[] = [msg]
    if (opts.ioc) msgs.push(await cancelMsg(b, orderHash, true))
    const r = await post<{ results: PlaceResult[] }>('/api/msgs', msgs)
    const res = r.results[0]
    if (!opts.ioc && BigInt(res.resting) > 0n) b.resting.set(orderHash, launchId)
    return res
  }

  async function cancelMsg(b: Bot, orderHash: Hex, ifResting: boolean): Promise<Msg> {
    const c = { owner: b.owner, orderHash, nonce: randomNonce() }
    const sig = await b.key.signTypedData(cancelTyped(D, c))
    return { kind: 'cancel', owner: c.owner, orderHash, nonce: c.nonce.toString(), sig, ifResting }
  }

  async function cancelAll(b: Bot, launchId?: bigint) {
    const hashes = [...b.resting].filter(([, l]) => launchId === undefined || l === launchId).map(([h]) => h)
    for (let i = 0; i < hashes.length; i += 16) {
      const chunk = hashes.slice(i, i + 16)
      const msgs = await Promise.all(chunk.map((h) => cancelMsg(b, h, true)))
      try {
        await post('/api/msgs', msgs)
      } catch {
        /* launch settled: orders already dropped */
      }
      for (const h of chunk) b.resting.delete(h)
    }
  }

  return { deploy, chain, pc, D, get, post, send, chainNow, feedPrice, createLaunch, makeBot, place, cancelAll }
}

export interface Bot {
  owner: Address
  acct: LocalAccount
  key: LocalAccount
  resting: Map<Hex, bigint>
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26). */
export function phi(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2)
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2)
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2
}

/** Fair Up probability in cents (3..97): pUp = Φ((price − strike) / (σ·price·sqrt(timeLeft))). */
export function fairUpCents(price: bigint, strike: bigint, timeLeft: number, sigma = 1e-4): number {
  const p = Number(price) / 1e18
  const k = Number(strike) / 1e18
  const t = Math.max(timeLeft, 1)
  const z = (p - k) / (sigma * p * Math.sqrt(t))
  return Math.min(97, Math.max(3, Math.round(phi(z) * 100)))
}
