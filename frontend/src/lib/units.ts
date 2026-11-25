// Share / price arithmetic (SPEC "Constants"). Every amount is wei (18 decimals). Prices are whole
// cents 1..99 in the order's own outcome terms. Share amounts are multiples of SHARE_UNIT, which
// keeps every cost and payout exact.

import { formatUnits, parseUnits } from 'viem'

export const E18 = 10n ** 18n
export const SHARE_UNIT = 10n ** 16n
export const LOSER_SUPPLY = 500_000_000n * E18
export const POOL_TOKENS = 500_000_000n * E18

export type Outcome = 0 | 1 // 0 Up, 1 Down
export type Side = 0 | 1 // 0 Buy, 1 Sell
export type BookSide = 'bid' | 'ask'

/** BNB paid for `amount` shares at `price` cents. */
export const cost = (amount: bigint, price: number): bigint => (amount * BigInt(price)) / 100n

/** BNB credited for `amount` winning shares after the launch's cut. */
export const payout = (amount: bigint, cutBps: number): bigint => (amount * BigInt(10000 - cutBps)) / 10000n

/** Shares a BNB stake buys at `price` cents, floored to a multiple of SHARE_UNIT. */
export function toShares(stake: bigint, price: number): bigint {
  if (price <= 0 || stake <= 0n) return 0n
  const raw = (stake * 100n) / BigInt(price)
  return (raw / SHARE_UNIT) * SHARE_UNIT
}

export const floorShares = (amount: bigint) => (amount / SHARE_UNIT) * SHARE_UNIT
export const isShareAmount = (a: bigint) => a > 0n && a % SHARE_UNIT === 0n

/** Where an order sits in the single Up-terms book. Buy Down @p ≡ Sell Up @(100 − p). */
export function upTerms(outcome: Outcome, side: Side, price: number): { side: BookSide; price: number } {
  const buyUp = (outcome === 0) === (side === 0)
  return { side: buyUp ? 'bid' : 'ask', price: outcome === 0 ? price : 100 - price }
}

/** The Up-terms book side a taker order consumes. */
export const bookSide = (outcome: Outcome, side: Side): BookSide => (upTerms(outcome, side, 50).side === 'bid' ? 'ask' : 'bid')

/** Convert an Up-terms price into `outcome` terms. */
export const inOutcome = (upPrice: number, outcome: Outcome) => (outcome === 0 ? upPrice : 100 - upPrice)

// ------------------------------------------------------------------ formatting

function group(intPart: string) {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** Fixed-dp BNB (floored), with thousands grouping. */
export function fmtBnb(wei: bigint | string | null | undefined, dp = 4): string {
  if (wei == null || wei === '') return '—'
  const v = BigInt(wei)
  const neg = v < 0n
  const abs = neg ? -v : v
  const scale = 10n ** BigInt(18 - dp)
  const q = abs / scale
  const s = q.toString().padStart(dp + 1, '0')
  const int = s.slice(0, s.length - dp)
  const frac = dp ? '.' + s.slice(s.length - dp) : ''
  return (neg ? '-' : '') + group(int) + frac
}

/** Shares, shown with up to 2 dp. */
export const fmtShares = (wei: bigint | string) => fmtBnb(wei, 2)

export function parseBnb(s: string): bigint | null {
  const t = s.trim()
  if (!/^\d*\.?\d*$/.test(t) || t === '' || t === '.') return null
  try {
    return parseUnits(t, 18)
  } catch {
    return null
  }
}

/** Plain number of an 18-dec value (for charts / USD only, never for money math). */
export const num18 = (v: bigint | string) => Number(formatUnits(BigInt(v), 18))

export function fmtUsd(n: number, maxDp?: number): string {
  const dp = maxDp ?? (n >= 1000 ? 2 : n >= 1 ? 2 : n >= 0.01 ? 4 : 6)
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: Math.min(2, dp), maximumFractionDigits: dp })
}

/** "$1,200.00" from a BNB amount and an 18-dec BNB/USD price; '' when the price is unknown. */
export function usd(bnbWei: bigint, bnbUsd: bigint | null | undefined): string {
  if (bnbUsd == null || bnbUsd <= 0n) return ''
  return fmtUsd(num18((bnbWei * bnbUsd) / E18), 2)
}

/** An 18-dec feed price as USD text. */
export function fmtPrice(p: bigint | string | null | undefined): string {
  if (p == null) return '—'
  const v = num18(p)
  return fmtUsd(v, v >= 1000 && Number.isInteger(v) ? 0 : undefined)
}
