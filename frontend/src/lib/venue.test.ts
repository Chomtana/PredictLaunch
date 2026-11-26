import { describe, expect, it } from 'vitest'
import { fourEnabled, venueLead, venueOf } from './venue.ts'

const RAIL = '0x00000000000000000000000000000000000F0047'
const FLAP_LAUNCHER = '0x00000000000000000000000000000000000AAAAA'

describe('venue', () => {
  it('is Flap when no OpenFour rail is configured', () => {
    expect(fourEnabled({})).toBe(false)
    expect(fourEnabled({ fourRail: `0x${'0'.repeat(40)}` })).toBe(false)
    expect(venueOf(RAIL, {})).toBe('flap')
    expect(venueOf(RAIL, null)).toBe('flap')
  })
  it('is Four for launches on the configured rail (any case), Flap otherwise', () => {
    const c = { fourRail: RAIL as `0x${string}` }
    expect(fourEnabled(c)).toBe(true)
    expect(venueOf(RAIL.toLowerCase(), c)).toBe('four')
    expect(venueOf(FLAP_LAUNCHER, c)).toBe('flap')
    expect(venueOf(null, c)).toBe('flap')
  })
  it('leads with Flap price + question, then Four price + question, the rest in order', () => {
    const c = { fourRail: RAIL as `0x${string}` }
    const F = (id: number, kind = 'price') => ({ id, rail: FLAP_LAUNCHER, kind })
    const R = (id: number, kind = 'price') => ({ id, rail: RAIL, kind })
    const ids = (xs: { id: number }[]) => xs.map((x) => x.id)
    // newest-first input: questions come before prices, yet each pair is price then question
    expect(ids(venueLead([R(1, 'question'), F(2, 'question'), R(3), F(4), F(5), R(6)], c))).toEqual([4, 2, 3, 1, 5, 6])
    // a venue missing one kind fills with its next launch
    expect(ids(venueLead([R(1), F(2), R(3), F(4), F(5, 'question')], c))).toEqual([2, 5, 1, 3, 4])
    expect(ids(venueLead([R(1), F(2), R(3)], c))).toEqual([2, 1, 3])
    expect(ids(venueLead([R(1), F(2), R(3)], {}))).toEqual([1, 2, 3])
  })
})
