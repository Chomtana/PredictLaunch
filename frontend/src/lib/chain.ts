// Onchain side: Exchange + Flap Portal + FourRail ABIs (SPEC "Contract Exchange"), public client, writers.

import {
  createPublicClient,
  defineChain,
  encodeAbiParameters,
  http,
  parseAbi,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem'

export const exchangeAbi = parseAbi([
  'function deposit(uint256 amount) payable',
  'function quoteToken() view returns (address)',
  'function requestWithdraw(uint256 amount) returns (uint64 idx)',
  'function forceWithdraw(uint64 idx)',
  'function claimPayout()',
  'function claimTokens(uint256 launchId)',
  'function authorizeKey(address key, uint64 expiry)',
  'function revokeKey(address key)',
  'function balanceOf(address u) view returns (uint256)',
  'function launchCount() view returns (uint256)',
  'function projectedRaised(uint256 id) view returns (uint256)',
  'function position(uint256 id, address u) view returns (uint128 up, uint128 down)',
  'function withdrawQueueLength() view returns (uint64)',
  'function withdrawProcessed() view returns (uint64)',
  'function isQuestion(uint256 id) view returns (bool)',
  'function getQuestion(uint256 id) view returns ((string question, uint256 marketId, bool proposed, uint8 proposedOutcome, uint64 proposedAt, bytes32 evidenceHash, bool final_))',
  'function overrideOutcome(uint256 id, uint8 outcome, bytes32 evidenceHash)',
  'function resolver() view returns (address)',
  'function challengeWindow() view returns (uint64)',
])

export const erc20Abi = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address who) view returns (uint256)',
])

export const NATIVE: Address = '0x0000000000000000000000000000000000000000'
export const isNative = (quote: Address | null | undefined) => !quote || /^0x0{40}$/i.test(quote)

export const portalAbi = parseAbi([
  'function newLauncher(address launcherFactory, bytes data) payable returns (address launcher)',
  'function SALT_LOCK_FEE() view returns (uint256)',
])

/** abi.encode(LaunchConfig) — SPEC: (name, symbol, imageURI, feed, strike, settleTime, cutBps, target, salt, question, marketId). */
export const LAUNCH_CONFIG_ABI = [
  {
    type: 'tuple',
    components: [
      { name: 'name', type: 'string' },
      { name: 'symbol', type: 'string' },
      { name: 'imageURI', type: 'string' },
      { name: 'feed', type: 'address' },
      { name: 'strike', type: 'uint256' },
      { name: 'settleTime', type: 'uint64' },
      { name: 'cutBps', type: 'uint16' },
      { name: 'target', type: 'uint256' },
      { name: 'salt', type: 'bytes32' },
      { name: 'question', type: 'string' },
      { name: 'marketId', type: 'uint256' },
    ],
  },
] as const

export interface LaunchConfig {
  name: string
  symbol: string
  imageURI: string
  feed: Address
  /** 18-dec, same units as the feed answer */
  strike: bigint
  /** unix seconds */
  settleTime: bigint
  cutBps: number
  /** wei */
  target: bigint
  salt: Hex
  /** Question launch: the exact claim (1–280 bytes); "" for a price launch. */
  question: string
  /** Cournot market id; 0n = no match, and always 0n for a price launch. */
  marketId: bigint
}

/** Price launches pass these; question launches pass feed 0 and strike 0 instead (SPEC "Question launches"). */
export const PRICE_LAUNCH_EXTRA = { question: '', marketId: 0n } as const

export const encodeLaunchConfig = (c: LaunchConfig): Hex => encodeAbiParameters(LAUNCH_CONFIG_ABI, [c])

type Who = Account | Address

export const fourRailAbi = [
  { type: 'function', name: 'createLaunch', stateMutability: 'nonpayable', inputs: [{ name: 'c', ...LAUNCH_CONFIG_ABI[0] }], outputs: [{ name: 'launchId', type: 'uint256' }] },
] as const

export const ZERO_SALT: Hex = `0x${'0'.repeat(64)}`

/** FourRail.createLaunch(cfg): a Four.meme launch (no salt, no fee; the token is created at graduation). */
export function createFourLaunch(wallet: WalletClient, account: Who, rail: Address, cfg: LaunchConfig): Promise<Hex> {
  return wallet.writeContract({
    address: rail,
    abi: fourRailAbi,
    functionName: 'createLaunch',
    args: [cfg],
    account,
    chain: wallet.chain,
  })
}

/** Portal.newLauncher{value: saltLockFee}(factory, abi.encode(cfg)). Returns the tx hash. */
export function createLaunch(
  wallet: WalletClient,
  account: Who,
  addrs: { portal: Address; factory: Address; saltLockFee: bigint },
  cfg: LaunchConfig,
): Promise<Hex> {
  return wallet.writeContract({
    address: addrs.portal,
    abi: portalAbi,
    functionName: 'newLauncher',
    args: [addrs.factory, encodeLaunchConfig(cfg)],
    value: addrs.saltLockFee,
    account,
    chain: wallet.chain,
  })
}

/** Exchange.deposit(amount). Native quote: `amount` as value. ERC20 quote: approve first when the allowance is short
 *  (waiting for that receipt), then deposit with no value. */
export async function deposit(wallet: WalletClient, pc: PublicClient, account: Who, exchange: Address, quote: Address, amount: bigint): Promise<Hex> {
  if (isNative(quote)) {
    return wallet.writeContract({ address: exchange, abi: exchangeAbi, functionName: 'deposit', args: [amount], value: amount, account, chain: wallet.chain })
  }
  const owner = typeof account === 'string' ? account : account.address
  const allowance = await pc.readContract({ address: quote, abi: erc20Abi, functionName: 'allowance', args: [owner, exchange] })
  if (allowance < amount) {
    const h = await wallet.writeContract({ address: quote, abi: erc20Abi, functionName: 'approve', args: [exchange, amount], account, chain: wallet.chain })
    const rc = await pc.waitForTransactionReceipt({ hash: h })
    if (rc.status !== 'success') throw new Error('Approve reverted')
  }
  return wallet.writeContract({ address: exchange, abi: exchangeAbi, functionName: 'deposit', args: [amount], account, chain: wallet.chain })
}

/** An allowance at least this large counts as "approved" for approve-only trading. */
export const APPROVED_MIN = 2n ** 128n
const MAX_UINT = 2n ** 256n - 1n

/** The Exchange's allowance on `owner`'s quote tokens (null for a native quote: nothing to approve). */
export const quoteAllowance = (pc: PublicClient, quote: Address, owner: Address, exchange: Address): Promise<bigint | null> =>
  isNative(quote) ? Promise.resolve(null) : pc.readContract({ address: quote, abi: erc20Abi, functionName: 'allowance', args: [owner, exchange] })

/** Approve-only trading: one unlimited approve so batches pull the quote token straight from the wallet. Waits for
 *  the receipt. No-op (returns false) for a native quote or when already approved. */
export async function approveTrading(wallet: WalletClient, pc: PublicClient, account: Who, exchange: Address, quote: Address): Promise<boolean> {
  if (isNative(quote)) return false
  const owner = typeof account === 'string' ? account : account.address
  const a = await quoteAllowance(pc, quote, owner, exchange)
  if (a != null && a >= APPROVED_MIN) return false
  const h = await wallet.writeContract({ address: quote, abi: erc20Abi, functionName: 'approve', args: [exchange, MAX_UINT], account, chain: wallet.chain })
  const rc = await pc.waitForTransactionReceipt({ hash: h })
  if (rc.status !== 'success') throw new Error('Approve reverted')
  return true
}

/** Wallet balance of the quote token (native balance for a native quote). */
export const quoteBalance = (pc: PublicClient, quote: Address, who: Address) =>
  isNative(quote) ? pc.getBalance({ address: who }) : pc.readContract({ address: quote, abi: erc20Abi, functionName: 'balanceOf', args: [who] })

export const requestWithdraw = (wallet: WalletClient, account: Who, exchange: Address, amount: bigint) =>
  wallet.writeContract({ address: exchange, abi: exchangeAbi, functionName: 'requestWithdraw', args: [amount], account, chain: wallet.chain })

export const claimTokens = (wallet: WalletClient, account: Who, exchange: Address, launchId: bigint) =>
  wallet.writeContract({ address: exchange, abi: exchangeAbi, functionName: 'claimTokens', args: [launchId], account, chain: wallet.chain })

export const claimPayout = (wallet: WalletClient, account: Who, exchange: Address) =>
  wallet.writeContract({ address: exchange, abi: exchangeAbi, functionName: 'claimPayout', account, chain: wallet.chain })

export function chainFor(chainId: number, rpcUrl: string): Chain {
  return defineChain({
    id: chainId,
    name: chainId === 97 ? 'BSC testnet (local fork)' : `chain ${chainId}`,
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  })
}

export function publicClientFor(chain: Chain): PublicClient {
  return createPublicClient({ chain, transport: http(), pollingInterval: 1000 }) as PublicClient
}

/** Human message for a failed tx / call. */
export function errMsg(e: unknown): string {
  const any = e as { shortMessage?: string; message?: string; cause?: { data?: { errorName?: string } } }
  const name = any?.cause?.data?.errorName
  if (name) return name.replace(/([a-z])([A-Z])/g, '$1 $2')
  const s = any?.shortMessage ?? any?.message ?? String(e)
  if (/User rejected|denied/i.test(s)) return 'Rejected in wallet'
  return s.split('\n')[0].slice(0, 160)
}
