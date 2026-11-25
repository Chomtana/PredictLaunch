// Market-order maths over the single Up-terms book (SPEC: /api/book prices are Up terms, best first).

import type { Book, Level } from './api.ts'
import { bookSide, cost, floorShares, inOutcome, type Outcome, type Side } from './units.ts'

export interface OLevel {
  /** cents, in the order's outcome terms */
  price: number
  amount: bigint
}

/** The levels a taker (outcome, side) consumes, best first, priced in outcome terms. */
export function levelsFor(book: Book | null | undefined, outcome: Outcome, side: Side): OLevel[] {
  if (!book) return []
  const src: Level[] = bookSide(outcome, side) === 'ask' ? book.asks : book.bids
  return src.map((l) => ({ price: inOutcome(l.price, outcome), amount: BigInt(l.amount) }))
}

export function bestPrice(book: Book | null | undefined, outcome: Outcome, side: Side): number | null {
  const l = levelsFor(book, outcome, side)
  return l.length ? l[0].price : null
}

/** Buy with a BNB stake: shares you get (multiple of 1e16), BNB spent, worst price touched. */
export function walkBuy(levels: OLevel[], stake: bigint): { shares: bigint; cost: bigint; worst: number | null } {
  let left = stake
  let shares = 0n
  let spent = 0n
  let worst: number | null = null
  for (const l of levels) {
    const affordable = floorShares((left * 100n) / BigInt(l.price))
    const take = affordable < l.amount ? affordable : floorShares(l.amount)
    if (take <= 0n) break
    shares += take
    const c = cost(take, l.price)
    spent += c
    left -= c
    worst = l.price
    if (take < l.amount) break
  }
  return { shares, cost: spent, worst }
}

/** Sell `shares`: how many fill, BNB received, worst price touched. */
export function walkSell(levels: OLevel[], shares: bigint): { filled: bigint; proceeds: bigint; worst: number | null } {
  let left = shares
  let proceeds = 0n
  let worst: number | null = null
  for (const l of levels) {
    if (left <= 0n) break
    const take = left < l.amount ? left : l.amount
    proceeds += cost(take, l.price)
    left -= take
    worst = l.price
  }
  return { filled: shares - left, proceeds, worst }
}

/** The Up-terms book seen in Down terms (Down asks = Up bids mirrored). */
export function mirror(book: Book): Book {
  return {
    asks: book.bids.map((l) => ({ price: 100 - l.price, amount: l.amount })),
    bids: book.asks.map((l) => ({ price: 100 - l.price, amount: l.amount })),
  }
}

/** Up mid price in cents (or the one side present). */
export function midUp(book: Book | null | undefined): number | null {
  if (!book) return null
  const a = book.asks[0]?.price
  const b = book.bids[0]?.price
  if (a != null && b != null) return Math.round((a + b) / 2)
  return a ?? b ?? null
}
