import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseEther } from 'viem'
import { describe, expect, it } from 'vitest'
import { niceStrike, oracleCents, tomorrowLabel } from './lib.ts'
import { allImages, isPriceMarket, PRICE_MEMES, QUESTIONS } from './seed-catalog.ts'

describe('seed helpers for the question launch', () => {
  it('tomorrow as Cournot names daily markets', () => {
    expect(tomorrowLabel(Date.UTC(2026, 10, 26, 15))).toBe('Nov 27, 2026')
    expect(tomorrowLabel(Date.UTC(2026, 11, 31, 15))).toBe('Jan 1, 2027')
  })

  it('quotes around round(p × 100), clamped 3..97, 50 when unknown', () => {
    expect(oracleCents(0.9336)).toBe(93)
    expect(oracleCents(0.995)).toBe(97)
    expect(oracleCents(0.001)).toBe(3)
    expect(oracleCents(null)).toBe(50)
    expect(oracleCents(undefined)).toBe(50)
  })
})

describe('seed strikes', () => {
  const e = (x: string) => parseEther(x)
  it('moves by bps and rounds to the step', () => {
    expect(niceStrike(e('97233.18'), 0, e('50'))).toBe(e('97250'))
    expect(niceStrike(e('97233.18'), 50, e('50'))).toBe(e('97700'))
    expect(niceStrike(e('612.34'), -30, e('0.5'))).toBe(e('610.5'))
    expect(niceStrike(e('3012'), 10, e('5'))).toBe(e('3015'))
  })
  it('never returns zero', () => {
    expect(niceStrike(e('0.1'), 0, e('5'))).toBe(e('5'))
  })
})

describe('seed catalog', () => {
  const memes = [...Object.values(PRICE_MEMES).flat(), ...QUESTIONS.flatMap((q) => q.memes)]
  it('fits the contract limits (name <= 32 bytes, symbol <= 10)', () => {
    for (const m of memes) {
      expect(Buffer.byteLength(m.name), m.name).toBeLessThanOrEqual(32)
      expect(Buffer.byteLength(m.symbol), m.symbol).toBeLessThanOrEqual(10)
    }
  })
  it('has unique symbols and a meme + image for every theme', () => {
    const syms = memes.map((m) => m.symbol)
    expect(new Set(syms).size).toBe(syms.length)
    for (const q of QUESTIONS) {
      expect(q.memes.length, q.search).toBeGreaterThan(0)
      expect(q.images.length, q.search).toBeGreaterThan(0)
    }
  })
  it('serves every image from public/', () => {
    // vitest runs from frontend/ (import.meta.url is not a file: URL under jsdom)
    for (const p of allImages()) expect(existsSync(join(process.cwd(), 'public', p)), p).toBe(true)
  })
})

describe('seed question themes are real-world events', () => {
  it('flags asset-price markets', () => {
    for (const t of [
      'Bitcoin price above $150,000 at any time before 2027-01-01 04:59 UTC',
      'Will Bitcoin dip to $55,000 by December 31, 2026?',
      'Ethereum price above $5,000 at 2027-01-01 05:00 UTC',
      'Will Gold (XAUUSD) hit (HIGH) $3,800 Week of November 23 2026?',
      'Will Apple (AAPL) close above $340 end of November?',
      "Will Apple's market capitalization be less than $3.50T at the end of 2026?",
    ])
      expect(isPriceMarket(t), t).toBe(true)
  })
  it('keeps event markets', () => {
    for (const t of [
      'Will it rain in Chicago on Nov 26, 2026?',
      'Will the Federal Reserve Cut rates by 25bps at their December 2026 meeting?',
      'Will SpaceX launch another Starship before Dec 15, 2026?',
      'Will Elon Musk post 1400+ tweets in December 2026?',
      'Will OpenAI release GPT-7 before Mar 1, 2027? (Yes: Before March, 2027)',
      'Buffalo wins',
      'Will Inter win the Champions League?',
    ])
      expect(isPriceMarket(t), t).toBe(false)
  })
  it('no catalog theme searches for a price', () => {
    for (const q of QUESTIONS) expect(isPriceMarket(q.search), q.search).toBe(false)
  })
})
