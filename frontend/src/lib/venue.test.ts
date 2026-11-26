import { describe, expect, it } from 'vitest'
import { fourEnabled, venueOf } from './venue.ts'

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
})
