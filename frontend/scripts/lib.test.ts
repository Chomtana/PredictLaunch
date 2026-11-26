import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseEther } from 'viem'
import { describe, expect, it } from 'vitest'
import { niceStrike, oracleCents, tomorrowLabel } from './lib.ts'
import { allImages, PRICE_MEMES, QUESTIONS } from './seed-catalog.ts'

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
