// Onchain side: Exchange + Flap Portal ABIs (SPEC "Contract Exchange"), public client, writers.

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
  'function deposit() payable',
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
])

export const portalAbi = parseAbi([
  'function newLauncher(address launcherFactory, bytes data) payable returns (address launcher)',
  'function SALT_LOCK_FEE() view returns (uint256)',
])

/** abi.encode(LaunchConfig) — SPEC: (name, symbol, imageURI, feed, strike, settleTime, cutBps, target, salt). */
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
}

export const encodeLaunchConfig = (c: LaunchConfig): Hex => encodeAbiParameters(LAUNCH_CONFIG_ABI, [c])

type Who = Account | Address

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

export const deposit = (wallet: WalletClient, account: Who, exchange: Address, amount: bigint) =>
  wallet.writeContract({ address: exchange, abi: exchangeAbi, functionName: 'deposit', value: amount, account, chain: wallet.chain })

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
