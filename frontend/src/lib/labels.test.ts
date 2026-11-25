import { describe, expect, it } from 'vitest'
import { kindOf, labelsFor, outcomeName, PRICE_LABELS, QUESTION_LABELS } from './labels.ts'

const ZERO = '0x0000000000000000000000000000000000000000'
const BTC = '0xe20536bc715aac6560394e33deb66ed205aeec33'

describe('outcome labels', () => {
  it('kind: the sequencer field wins, else feed 0 marks a question launch', () => {
    expect(kindOf({ kind: 'question', feed: BTC })).toBe('question')
    expect(kindOf({ kind: 'price', feed: ZERO })).toBe('price')
    expect(kindOf({ feed: ZERO })).toBe('question')
    expect(kindOf({ feed: BTC })).toBe('price')
    expect(kindOf(null)).toBe('price')
  })

  it('Up/Down for price launches, YES/NO for question launches', () => {
    expect(labelsFor({ feed: BTC }).names).toEqual(['Up', 'Down'])
    expect(labelsFor({ feed: ZERO }).names).toEqual(['YES', 'NO'])
    expect(labelsFor('question')).toBe(QUESTION_LABELS)
    expect(labelsFor('price')).toBe(PRICE_LABELS)
    expect(PRICE_LABELS.marks).toEqual(['Up ▲', 'Down ▼'])
    expect(outcomeName(QUESTION_LABELS, 0)).toBe('YES')
    expect(outcomeName(QUESTION_LABELS, 1)).toBe('NO')
    expect(outcomeName(PRICE_LABELS, 2)).toBe('Void')
  })
})
