import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { LaunchOracle, OracleRecord } from '../lib/api.ts'
import { CournotPanel, MarketRow, SettlementPanel } from './Cournot.tsx'

const rec = (over: Partial<OracleRecord> = {}): OracleRecord => ({
  launchId: 3,
  claim: 'Will it rain in Boston on Nov 27, 2026?',
  marketId: 2851234,
  market: { title: 'Will it rain in Boston on Nov 27, 2026?', end_time: '2026-11-28T05:00:00Z', market_outcome_price: 0.58 },
  probability: 0.62,
  result: { point_estimate: 0.62, mock: true },
  basis: { primary_anchor: { source: 'mock', summary: 'trades at 0.62' }, limitations: ['Simulated oracle (COURNOT_MODE=mock)'] },
  source: 'mock',
  fetchedAt: 1_795_000_000,
  error: null,
  raw: null,
  ...over,
})

/** Nothing the oracle answered (or its mode) may reach the page before settlement. */
function expectNoLeak(text: string) {
  expect(text).not.toMatch(/simulated|mock/i)
  expect(text).not.toMatch(/62(\.0)?%|0\.62|58¢|0\.58|trades at/)
}

describe('MarketRow', () => {
  it('shows the title and end, not the live YES price or confidence', () => {
    render(
      <MarketRow
        m={{ matchingConfidence: 0.85, id: 1, title: 'Will it rain in Boston?', description: '', startTime: null, endTime: null, yesPrice: 0.58 }}
        on={false}
        onPick={() => {}}
      />,
    )
    expect(screen.getByText('Will it rain in Boston?')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/58|85%|YES/)
  })
})

describe('CournotPanel', () => {
  it('shows the exact question and the linked market, never the probability, evidence or oracle mode', () => {
    const oracle: LaunchOracle = { opening: rec(), prices: [{ t: 1, price: 0.58 }], settlement: null, proposal: null }
    render(<CournotPanel question="ignored when the record has a claim" oracle={oracle} />)
    const p = screen.getByTestId('cournot-panel')
    expect(p.textContent).toContain('Resolved by Cournot')
    expect(p.textContent).toContain('Will it rain in Boston on Nov 27, 2026?')
    expect(p.textContent).toContain('Cournot market')
    expectNoLeak(p.textContent ?? '')
  })

  it('falls back to the launch question before the record loads', () => {
    render(<CournotPanel question="Will SpaceX launch another Starship?" oracle={null} />)
    expect(screen.getByTestId('cournot-panel').textContent).toContain('Will SpaceX launch another Starship?')
  })
})

describe('SettlementPanel', () => {
  it('a proposal shows outcome, countdown and the evidence hash, but not the evidence or oracle mode', () => {
    const hash = '0x' + 'ab'.repeat(32)
    const oracle: LaunchOracle = {
      opening: null,
      prices: [],
      settlement: rec(),
      proposal: { proposed: true, outcome: 1, proposedAt: 1000, evidenceHash: hash as `0x${string}`, final: false, challengeEndsAt: 1120 },
    }
    render(<SettlementPanel oracle={oracle} settleTime={900} now={1030} resolved={false} outcome={0} />)
    const p = screen.getByTestId('settlement-panel')
    expect(p.textContent).toContain('challenge window open')
    expect(p.textContent).toContain('NO')
    expect(screen.getByTestId('challenge-countdown').textContent).toBe('1m 30s left')
    expect(p.textContent).toContain(hash)
    expectNoLeak(p.textContent ?? '')
  })
})
