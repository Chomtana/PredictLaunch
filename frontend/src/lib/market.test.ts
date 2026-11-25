import { describe, expect, it } from 'vitest'
import { bestPrice, levelsFor, mirror, walkBuy, walkSell } from './market.ts'

const E18 = 10n ** 18n
const book = {
  asks: [
    { price: 60, amount: (1n * E18).toString() },
    { price: 62, amount: (10n * E18).toString() },
  ],
  bids: [
    { price: 55, amount: (2n * E18).toString() },
    { price: 50, amount: (5n * E18).toString() },
  ],
}

describe('market', () => {
  it('levelsFor maps the taker side into outcome terms', () => {
    expect(levelsFor(book, 0, 0).map((l) => l.price)).toEqual([60, 62]) // buy Up lifts asks
    expect(levelsFor(book, 1, 0).map((l) => l.price)).toEqual([45, 50]) // buy Down hits bids
    expect(levelsFor(book, 0, 1).map((l) => l.price)).toEqual([55, 50]) // sell Up hits bids
    expect(levelsFor(book, 1, 1).map((l) => l.price)).toEqual([40, 38]) // sell Down lifts asks
    expect(bestPrice(book, 0, 0)).toBe(60)
    expect(bestPrice({ asks: [], bids: [] }, 0, 0)).toBeNull()
  })

  it('walkBuy spends at most the stake across levels', () => {
    const w = walkBuy(levelsFor(book, 0, 0), 2n * E18)
    // 1 share @60 = 0.6, then 1.4 / 0.62 = 2.258 → 2.25 shares @62 = 1.395
    expect(w.shares).toBe(325n * 10n ** 16n)
    expect(w.cost).toBe(6n * 10n ** 17n + 1395n * 10n ** 15n)
    expect(w.worst).toBe(62)
    expect(w.cost <= 2n * E18).toBe(true)
  })

  it('walkSell sums proceeds', () => {
    const w = walkSell(levelsFor(book, 0, 1), 3n * E18)
    expect(w.filled).toBe(3n * E18)
    expect(w.proceeds).toBe(11n * 10n ** 17n + 5n * 10n ** 17n)
    expect(w.worst).toBe(50)
  })

  it('mirror flips the book into Down terms', () => {
    const m = mirror(book)
    expect(m.asks.map((l) => l.price)).toEqual([45, 50])
    expect(m.bids.map((l) => l.price)).toEqual([40, 38])
  })
})
