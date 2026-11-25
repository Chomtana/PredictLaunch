import { describe, expect, it } from 'vitest'
import { decodeSlot32 } from './feed-relay.ts'

describe('decodeSlot32', () => {
  it('decodes the live BTCB sample word', () => {
    expect(decodeSlot32('0x0000000000000000000000006b06acdc00006b06acdb0c7761a96bd5c96d58f0')).toEqual({
      answer: 58870597613665873910000n,
      startedAt: 1795599579,
      updatedAt: 1795599580,
    })
  })
  it('decodes zero', () => {
    expect(decodeSlot32(`0x${'0'.repeat(64)}`)).toEqual({ answer: 0n, startedAt: 0, updatedAt: 0 })
  })
})
