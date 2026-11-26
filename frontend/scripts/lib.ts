// Shared helpers for the local-fork scripts (seed.ts, e2e.ts). LOCAL ONLY: public anvil dev keys.

import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, decodeEventLog, encodeAbiParameters, encodeFunctionData, http, keccak256, parseAbi, parseEther, toHex, type Address, type Hex, type LocalAccount } from 'viem'
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from 'viem/accounts'
import { approveTrading, chainFor, deposit as depositTx, encodeLaunchConfig, erc20Abi, exchangeAbi, fourRailAbi, isNative, NATIVE, portalAbi, ZERO_SALT, withFixedGas, type LaunchConfig } from '../src/lib/chain.ts'
import { authorizeKeyMsg, cancelTyped, randomNonce, signAuthorizeKey, signOrder, type Domain, type Msg, type Order } from '../src/lib/eip712.ts'
import { PORTAL, mineSaltSync, predictToken, randomSeed } from '../src/lib/salt.ts'

export { niceStrike, tomorrowLabel } from '../src/lib/catalog.ts'

export const E18 = 10n ** 18n
export const UNIT = 10n ** 16n

export function arg(k: string, d?: string): string | undefined {
  const i = process.argv.indexOf(`--${k}`)
  return i >= 0 ? process.argv[i + 1] : d
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** anvil's public test mnemonic: its accounts #0..#9 are ANVIL_KEYS. */
export const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk'

/** Account `index` of MNEMONIC (.env; default: anvil's public one), path m/44'/60'/0'/0/index. The roles are
 *  fixed in scripts/keys.sh: 0 deployer, 9 operator, 3 creator, 5 maker, 6/7 takers. */
export function roleAccount(index: number) {
  return mnemonicToAccount(process.env.MNEMONIC?.trim() || ANVIL_MNEMONIC, { addressIndex: index })
}

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
  BNB: '0x3957d289ee9c38272377786787ea34f9dd29788d' as Address,
  BTC: '0x83b2f2c20df36f166cf5b3f017204cbb7babcad0' as Address,
  ETH: '0x35369decd8c662954b3d24acc2a862c708a34fd2' as Address,
}

export const feedAbi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
])

export const railAbi = parseAbi(['function launch(uint256 launchId, uint256 quoteAmount) payable returns (address token, address pool)'])

/** Flap's testnet faucet USDT (on-chain "USD", 18 decimals, permissionless mint; balances mapping at slot 0). */
export const FLAP_USDT: Address = '0x190C989D5665a0e404B444b53CAE9AbCfb600157'
const mintAbi = parseAbi(['function mint(address to, uint256 amount)'])
/** Storage slot of `balanceOf[who]` for an OZ ERC20 whose `_balances` is slot 0 (FLAP_USDT). */
const balanceSlot = (who: Address) => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [who, 0n]))

export const exchangeExtraAbi = parseAbi([
  'event LaunchCreated(uint256 launchId, address creator, address rail, address token, address feed, uint256 strike, uint64 settleTime, uint16 cutBps, uint256 target, string name, string symbol, string imageURI)',
  'event QuestionSet(uint256 launchId, string question, uint256 marketId)',
  'event OutcomeProposed(uint256 launchId, uint8 outcome, bytes32 evidenceHash, address by, bool final_)',
  'function claimableTokens(uint256 id, address user) view returns (uint256)',
  'function loserShares(uint256 id, address user) view returns (uint256)',
])

export interface Deploy {
  exchange: Address
  factory: Address
  chainId: number
  /** Exchange collateral; absent or zero = native BNB. */
  quoteToken?: Address
}

export function setup(rpc: string, api: string, deployPath: string) {
  const deploy = JSON.parse(readFileSync(deployPath, 'utf8')) as Deploy
  const chain = chainFor(97, rpc)
  const pc = createPublicClient({ chain, transport: http(rpc), pollingInterval: 500 })
  const D: Domain = { chainId: 97, exchange: deploy.exchange }
  const quote: Address = deploy.quoteToken ?? NATIVE
  const native = isNative(quote)
  /** Display unit of every Exchange amount. */
  const Q = native ? 'BNB' : 'USDT'
  /** Size scale of the demo amounts: BNB amounts x1000 in USDT. Launch targets come from `minTarget()`. */
  const K = native ? 1 : 1000

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

  const wallet = (acct: LocalAccount) => withFixedGas(createWalletClient({ chain, transport: http(rpc), account: acct }))

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
  async function createLaunch(acct: LocalAccount, c: Omit<LaunchConfig, 'salt'>): Promise<{ id: bigint; token: Address; rail: Address }> {
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
          return { id: ev.args.launchId, token: ev.args.token, rail: ev.args.rail }
        }
      } catch (e) {
        if ((e as Error).message.startsWith('token')) throw e
      }
    }
    throw new Error('no LaunchCreated event in the newLauncher receipt')
  }

  /** The Exchange's minimum launch target (`/api/config` minTarget): Flap's graduated floor, ~$3000. */
  async function minTarget(): Promise<bigint> {
    return BigInt((await get<{ minTarget: string }>('/api/config')).minTarget)
  }

  /** The sequencer's OpenFour rail (`/api/config` fourRail), or null when it runs Flap only. */
  async function fourRail(): Promise<Address | null> {
    const c = await get<{ fourRail?: Address }>('/api/config')
    return c.fourRail && !/^0x0{40}$/i.test(c.fourRail) ? c.fourRail : null
  }

  /** FourRail.createLaunch(LaunchConfig): a Four.meme launch (no salt or fee; the token is created at graduation). */
  async function createFourLaunch(acct: LocalAccount, rail: Address, c: Omit<LaunchConfig, 'salt'>): Promise<{ id: bigint; token: Address; rail: Address }> {
    const rc = await send(acct, { address: rail, abi: fourRailAbi, functionName: 'createLaunch', args: [{ ...c, salt: ZERO_SALT }] })
    for (const log of rc.logs) {
      if (log.address.toLowerCase() !== deploy.exchange.toLowerCase()) continue
      try {
        const ev = decodeEventLog({ abi: exchangeExtraAbi, data: log.data, topics: log.topics })
        if (ev.eventName === 'LaunchCreated') return { id: ev.args.launchId, token: ev.args.token, rail: ev.args.rail }
      } catch {
        /* another event */
      }
    }
    throw new Error('no LaunchCreated event in the FourRail.createLaunch receipt')
  }

  /**
   * Fork only: pull the whole graduation path (Flap Portal, token implementation, PancakeSwap) into
   * anvil's fork cache before trading starts. The first graduation on a cold fork fetches so much
   * remote state that anvil stalls for ~30 s, long enough for an in-flight batch to time out
   * (soft reversal). This eth_calls rail.launch(id) as the Exchange (it reverts at the
   * end, in receiveLoserTokens, after touching everything) and changes no state.
   */
  async function warmGraduation(rail: Address, id: bigint, value: bigint) {
    const t = Date.now()
    try {
      await pc.call({
        account: deploy.exchange,
        to: rail,
        data: encodeFunctionData({ abi: railAbi, functionName: 'launch', args: [id, value] }),
        ...(native
          ? { value, stateOverride: [{ address: deploy.exchange, balance: value * 2n }] }
          : // ERC20: the Exchange would have transferred `value` to the rail first; fake that balance.
            { stateOverride: [{ address: deploy.exchange, balance: parseEther('1') }, { address: quote, stateDiff: [{ slot: balanceSlot(rail), value: toHex(value, { size: 32 }) }] }] }),
      })
    } catch {
      /* expected: receiveLoserTokens rejects a launch that is not Graduated */
    }
    return Date.now() - t
  }

  /** Gas (dev faucet, else anvil_setBalance) and, for an ERC20 quote, `quoteAmount` minted (the faucet's mint, plus a
   *  direct mint for the rest: FLAP_USDT's mint is public). */
  /** Gas below this on a real network (no faucet, no anvil cheats): warn, the owner tops it up by hand. */
  const LOW_GAS = parseEther('0.005')
  let gasWarned = false

  /** Make `acct` able to trade `quoteAmount` more. Fork: the dev faucet (or anvil_setBalance) for gas. Real
   *  network: gas is yours to send (warned once when low). ERC20 quote: whatever is still missing is minted
   *  from Flap's faucet USDT, whose `mint` is public, on any network. */
  async function fund(acct: LocalAccount, quoteAmount: bigint) {
    let fromFaucet = 0n
    try {
      const r = await post<{ quote?: string }>('/api/faucet', { address: acct.address })
      fromFaucet = BigInt(r.quote ?? '0')
    } catch {
      try {
        await pc.request({ method: 'anvil_setBalance' as never, params: [acct.address, '0x' + parseEther('1000').toString(16)] as never })
      } catch {
        const gas = await pc.getBalance({ address: acct.address })
        if (gas < LOW_GAS && !gasWarned) {
          gasWarned = true
          console.log(`seed: ${acct.address} has ${Number(gas) / 1e18} BNB for gas: send tBNB (see scripts/wallets.sh)`)
        }
      }
    }
    if (!native && quoteAmount > fromFaucet) await send(acct, { address: quote, abi: mintAbi, functionName: 'mint', args: [acct.address, quoteAmount - fromFaucet] })
  }

  /** Exchange.deposit of `amount` (approving first for an ERC20 quote). */
  async function depositQuote(acct: LocalAccount, amount: bigint) {
    const hash = await depositTx(wallet(acct), pc, acct, deploy.exchange, quote, amount)
    const rc = await pc.waitForTransactionReceipt({ hash })
    if (rc.status !== 'success') throw new Error(`deposit reverted (${hash})`)
  }

  /** Wallet quote balance + internal Exchange balance: everything a bot can trade with. */
  async function tradable(who: Address) {
    const internal = await pc.readContract({ address: deploy.exchange, abi: exchangeAbi, functionName: 'balanceOf', args: [who] })
    if (native) return internal
    return internal + (await pc.readContract({ address: quote, abi: erc20Abi, functionName: 'balanceOf', args: [who] }))
  }

  /** Fund and authorize a trading key. Native quote: deposit into the Exchange. ERC20 quote: approve-only
   *  (one unlimited approve; batches pull straight from the wallet). */
  async function makeBot(acct: LocalAccount, depositAmount: bigint): Promise<Bot> {
    if (native) {
      const have = await pc.readContract({ address: deploy.exchange, abi: exchangeAbi, functionName: 'balanceOf', args: [acct.address] })
      await fund(acct, depositAmount > have ? depositAmount - have : 0n)
      if (have < depositAmount) await depositQuote(acct, depositAmount - have)
    } else {
      const have = await tradable(acct.address)
      await fund(acct, depositAmount > have ? depositAmount - have : 0n)
      await approveTrading(wallet(acct), pc, acct, deploy.exchange, quote)
    }
    const b: Bot = { owner: acct.address, acct, key: acct, resting: new Map() }
    await authorize(b)
    // The user view watches the address; the poke reads its funds now.
    await get(`/api/user/${acct.address}`)
    await post('/api/poke')
    return b
  }

  /**
   * Give `b` a fresh trading key. Also the recovery path: a batch the chain refuses (e.g. Overfill) takes the
   * keys it was authorizing with it, after which every order signed by the old key is `bad_signature`.
   */
  async function authorize(b: Bot) {
    const key = privateKeyToAccount(generatePrivateKey())
    const a = { owner: b.owner, key: key.address, expiry: (await chainNow()) + 7n * 86400n, nonce: randomNonce() }
    const sig = await signAuthorizeKey(D, b.acct, a)
    await post('/api/msgs', [authorizeKeyMsg(a, sig)])
    b.key = key
    // Orders signed by the old key are gone with it.
    b.resting.clear()
  }

  /** Keep a bot trading: when its free Exchange balance drops below `min`, refill the wallet and deposit `amount`. */
  /** When `b` can spend less than `min`, add `amount`: USDT minted from Flap's faucet token (ERC20 quote), or
   *  deposited (native). The live loop calls it every few ticks, so a bot never runs dry of quote. */
  async function topUp(b: Bot, min = 100n * E18, amount = 200n * E18) {
    const u = await get<{ free?: string; balance: string }>(`/api/user/${b.owner}`)
    if (BigInt(u.free ?? u.balance) >= min) return false
    await fund(b.acct, amount)
    if (native) await depositQuote(b.acct, amount)
    await post('/api/poke')
    return true
  }

  /**
   * Keep each account's tBNB (gas) between `need` and 2 x `need`: below `need`, the deployer (`from`) sends what
   * brings it back to 2 x `need`. Returns what was sent per address. A deployer that cannot cover it is logged
   * and skipped (the bots keep running on what they have).
   */
  async function refillGas(from: LocalAccount, accounts: { acct: LocalAccount; need: bigint; label: string }[]) {
    const sent: { label: string; address: Address; amount: bigint }[] = []
    for (const { acct, need, label } of accounts) {
      if (acct.address.toLowerCase() === from.address.toLowerCase()) continue
      const bal = await pc.getBalance({ address: acct.address })
      if (bal >= need) continue
      const amount = 2n * need - bal
      const have = await pc.getBalance({ address: from.address })
      if (have < amount + parseEther('0.001')) {
        console.log(`seed: ${label} ${acct.address} is low on gas (${Number(bal) / 1e18} BNB) but the deployer ${from.address} has only ${Number(have) / 1e18}: send it tBNB (scripts/wallets.sh)`)
        continue
      }
      const hash = await wallet(from).sendTransaction({ account: from, chain, to: acct.address, value: amount })
      const rc = await pc.waitForTransactionReceipt({ hash })
      if (rc.status !== 'success') throw new Error(`gas refill of ${acct.address} reverted (${hash})`)
      sent.push({ label, address: acct.address, amount })
    }
    return sent
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

  return { deploy, chain, pc, D, quote, native, Q, K, get, post, send, chainNow, feedPrice, createLaunch, minTarget, fourRail, createFourLaunch, warmGraduation, fund, depositQuote, tradable, makeBot, authorize, topUp, refillGas, place, cancelAll }
}

export interface Bot {
  owner: Address
  acct: LocalAccount
  key: LocalAccount
  resting: Map<Hex, bigint>
}


/** Cournot probability (0..1) → a question launch's quoting centre in cents, clamped 3..97; 50 when unknown. */
export function oracleCents(p: number | null | undefined): number {
  if (p == null || !Number.isFinite(p)) return 50
  return Math.min(97, Math.max(3, Math.round(p * 100)))
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
