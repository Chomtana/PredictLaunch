import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import type { LaunchOracle, OracleRecord } from '../lib/api.ts'
import { BasisView, CournotPanel, OracleRecordView, SettlementPanel, SourceBadge } from './Cournot.tsx'

const rec = (over: Partial<OracleRecord> = {}): OracleRecord => ({
  launchId: 3,
  claim: 'Will it rain in Boston on Nov 27, 2026?',
  marketId: 2851234,
  market: null,
  probability: 0.62,
  result: { point_estimate: 0.62 },
  basis: null,
  source: 'cournot-live',
  fetchedAt: 1_795_000_000,
  error: null,
  raw: null,
  ...over,
})

describe('BasisView', () => {
  it('object form: one-row tables, cross_checks table with the union of keys, limitations list, nested path rows', () => {
    const basis = {
      primary_anchor: { source: 'NWS forecast', summary: '70% chance of rain', url: 'https://weather.example/boston' },
      price_distance: { market_price: 0.6, model: 0.62 },
      cross_checks: [
        { source: 'A', summary: 'agrees' },
        { source: 'B', delta: 0.03 },
      ],
      limitations: ['Forecast can change', 'One city only'],
      extra: { nested: { depth: 2 }, list: [{ a: 1 }] },
    }
    const { container } = render(<BasisView basis={basis} />)
    const anchor = container.querySelector('[data-basis-key="primary_anchor"]') as HTMLElement
    expect(within(anchor).getAllByRole('row')).toHaveLength(2) // header + one row
    expect(within(anchor).getByRole('columnheader', { name: 'Source' })).toBeTruthy()
    // url makes the summary a link (no url column)
    const link = within(anchor).getByRole('link', { name: '70% chance of rain' }) as HTMLAnchorElement
    expect(link.href).toBe('https://weather.example/boston')
    expect(within(anchor).queryByRole('columnheader', { name: 'Url' })).toBeNull()

    const pd = container.querySelector('[data-basis-key="price_distance"]') as HTMLElement
    expect(within(pd).getByRole('columnheader', { name: 'Market price' })).toBeTruthy()
    expect(pd.textContent).toContain('0.62')

    const cc = container.querySelector('[data-basis-key="cross_checks"]') as HTMLElement
    const heads = within(cc).getAllByRole('columnheader').map((h) => h.textContent)
    expect(heads).toEqual(['Source', 'Summary', 'Delta'])
    expect(within(cc).getAllByRole('row')).toHaveLength(3)

    const lim = container.querySelector('[data-basis-key="limitations"]') as HTMLElement
    expect(within(lim).getAllByRole('listitem').map((x) => x.textContent)).toEqual(['Forecast can change', 'One city only'])

    const extra = container.querySelector('[data-basis-key="extra"]') as HTMLElement
    expect(extra.textContent).toContain('extra.nested.depth')
    expect(extra.textContent).toContain('extra.list[0].a')
  })

  it('older array form of {source, summary, time} with optional url links', () => {
    const basis = [
      { source: 'Reuters', summary: 'Fed signals a hike', time: '2026-11-20', url: 'https://news.example/fed' },
      { source: 'CME', summary: 'FedWatch 93%', time: '2026-11-25' },
    ]
    render(<BasisView basis={basis} />)
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Source', 'Summary', 'Time'])
    expect((screen.getByRole('link', { name: 'Fed signals a hike' }) as HTMLAnchorElement).href).toBe('https://news.example/fed')
    expect(screen.getByText('FedWatch 93%')).toBeTruthy()
  })

  it('null or empty basis', () => {
    render(<BasisView basis={null} />)
    expect(screen.getByText('No evidence returned.')).toBeTruthy()
  })
})

describe('source badge', () => {
  it('"Simulated oracle" for mock, Cournot live otherwise', () => {
    const { rerender } = render(<SourceBadge source="mock" />)
    expect(screen.getByText('Simulated oracle')).toBeTruthy()
    rerender(<SourceBadge source="cournot-live" />)
    expect(screen.queryByText('Simulated oracle')).toBeNull()
    expect(screen.getByText('Cournot live')).toBeTruthy()
  })

  it('the preview shows the headline %, result fields and the mock badge', () => {
    render(<OracleRecordView r={rec({ source: 'mock', probability: 0.9336, result: { point_estimate: 0.9336, mock: true } })} />)
    const box = screen.getByTestId('oracle-record')
    expect(box.textContent).toContain('93.4%')
    expect(box.textContent).toContain('Simulated oracle')
    expect(box.textContent).toContain('mock')
  })
})

describe('CournotPanel', () => {
  it('claim, probability, oracle-vs-book gap, evidence without limitations, limitations list', () => {
    const oracle: LaunchOracle = {
      opening: rec({ basis: { primary_anchor: { source: 'NWS', summary: 'rain likely' }, limitations: ['Single source'] } }),
      prices: [{ t: 1, price: 0.58 }],
      settlement: null,
      proposal: null,
    }
    render(<CournotPanel question="ignored when the record has a claim" oracle={oracle} bookYes={70} />)
    const p = screen.getByTestId('cournot-panel')
    expect(p.textContent).toContain('Will it rain in Boston on Nov 27, 2026?')
    expect(p.textContent).toContain('62.0%')
    expect(screen.getByTestId('oracle-gap').textContent).toBe('+8¢')
    expect(p.textContent).toContain('Cournot live')
    expect(p.textContent).toContain('Market YES now58¢')
    expect(screen.getAllByText('Single source')).toHaveLength(1)
  })
})

describe('SettlementPanel', () => {
  it('a proposal shows outcome, countdown and the evidence hash', () => {
    const hash = '0x' + 'ab'.repeat(32)
    const oracle: LaunchOracle = {
      opening: null,
      prices: [],
      settlement: rec({ source: 'mock' }),
      proposal: { proposed: true, outcome: 1, proposedAt: 1000, evidenceHash: hash as `0x${string}`, final: false, challengeEndsAt: 1120 },
    }
    render(<SettlementPanel oracle={oracle} settleTime={900} now={1030} resolved={false} outcome={0} />)
    const p = screen.getByTestId('settlement-panel')
    expect(p.textContent).toContain('challenge window open')
    expect(p.textContent).toContain('NO')
    expect(screen.getByTestId('challenge-countdown').textContent).toBe('1m 30s left')
    expect(p.textContent).toContain(hash)
    expect(p.textContent).toContain('Simulated oracle')
  })
})
