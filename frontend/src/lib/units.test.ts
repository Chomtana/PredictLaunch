import { describe, expect, it } from 'vitest'
import { bookSide, cost, fmtBnb, isShareAmount, parseBnb, payout, SHARE_UNIT, toShares, upTerms, usd } from './units.ts'

const E18 = 10n ** 18n

describe('units', () => {
  it('cost = amount × price / 100', () => {
    expect(cost(E18, 60)).toBe(6n * 10n ** 17n)
    expect(cost(SHARE_UNIT, 1)).toBe(10n ** 14n)
  })

  it('payout = amount × (10000 − cut) / 10000', () => {
    expect(payout(2n * E18, 2500)).toBe(15n * 10n ** 17n)
    expect(payout(E18, 1000)).toBe(9n * 10n ** 17n)
  })

  it('toShares floors to a multiple of 1e16', () => {
    expect(toShares(E18, 60)).toBe(166n * 10n ** 16n)
    expect(toShares(E18, 60) % SHARE_UNIT).toBe(0n)
    expect(toShares(E18, 50)).toBe(2n * E18)
    expect(toShares(0n, 50)).toBe(0n)
    expect(toShares(10n ** 14n - 1n, 1)).toBe(0n)
  })

  it('upTerms maps every order onto the Up-terms book', () => {
    expect(upTerms(1, 0, 30)).toEqual({ side: 'ask', price: 70 })
    expect(upTerms(0, 0, 30)).toEqual({ side: 'bid', price: 30 })
    expect(upTerms(0, 1, 55)).toEqual({ side: 'ask', price: 55 })
    expect(upTerms(1, 1, 55)).toEqual({ side: 'bid', price: 45 })
  })

  it('bookSide: buying Up lifts the asks, buying Down hits the bids', () => {
    expect(bookSide(0, 0)).toBe('ask')
    expect(bookSide(1, 0)).toBe('bid')
    expect(bookSide(0, 1)).toBe('bid')
    expect(bookSide(1, 1)).toBe('ask')
  })

  it('formats and parses BNB', () => {
    expect(fmtBnb(1494n * 10n ** 15n, 2)).toBe('1.49')
    expect(fmtBnb(2n * E18, 2)).toBe('2.00')
    expect(fmtBnb(0n)).toBe('0.0000')
    expect(parseBnb('1.5')).toBe(15n * 10n ** 17n)
    expect(parseBnb('')).toBeNull()
    expect(parseBnb('abc')).toBeNull()
    expect(isShareAmount(SHARE_UNIT * 3n)).toBe(true)
    expect(isShareAmount(SHARE_UNIT + 1n)).toBe(false)
    expect(isShareAmount(0n)).toBe(false)
  })

  it('usd estimate from an 18-dec BNB/USD price', () => {
    expect(usd(2n * E18, 600n * E18)).toBe('$1,200.00')
    expect(usd(E18, null)).toBe('')
  })
})
