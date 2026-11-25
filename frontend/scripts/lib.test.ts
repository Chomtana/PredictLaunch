import { describe, expect, it } from 'vitest'
import { oracleCents, tomorrowLabel } from './lib.ts'

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
