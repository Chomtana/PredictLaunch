import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { App } from './App.tsx'
import { AppProvider } from './state.tsx'

afterEach(() => {
  vi.unstubAllGlobals()
  window.location.hash = ''
})

const ZERO = '0x0000000000000000000000000000000000000000'
const E18 = 10n ** 18n
const now = Math.floor(Date.now() / 1000)
const Q = 'Will it rain in Boston on Nov 27, 2026?'

const config = {
  chainId: 97,
  rpc: 'http://127.0.0.1:8545',
  exchange: '0x00000000000000000000000000000000000e8C4A',
  factory: '0x00000000000000000000000000000000000fac70',
  portal: '0x000042108465206185A077Edc3F3fd2b49060000',
  saltLockFee: '5000000000000000',
  minTarget: (215n * 10n ** 16n).toString(),
  cuts: [1000, 1500, 2000, 2500, 3000],
  feeds: [{ address: '0xb3d1614bf894e68add1ea50ca250c152bad5256f', symbol: 'BNB/USD' }],
  minDuration: 300,
  maxDuration: 30 * 86400,
  batchMs: 2000,
  cournotMode: 'mock',
  challengeWindow: 120,
  questionDeadline: 7 * 86400,
}
const launch = {
  id: 1, creator: ZERO, rail: ZERO, feed: ZERO, strike: '0', settleTime: now + 1200, createdAt: now - 60, cutBps: 1000,
  target: (215n * 10n ** 16n).toString(), pairs: (5n * E18).toString(), raised: '0', status: 0, outcome: 0, settlePrice: '0',
  settleUpdatedAt: 0, snapped: false, resolved: false, token: ZERO, totalLoserShares: '0', name: 'Boston Rain', symbol: 'RAIN',
  imageURI: '', upPrice: 64, projectedRaised: (5n * 10n ** 17n).toString(), progress: 0.23,
  kind: 'question', question: Q, marketId: 2851234, oracleProbability: 0.6, oracleSource: 'mock', currentPrice: null, lastTrades: [],
}
const oracle = {
  opening: {
    launchId: 1, claim: Q, marketId: 2851234, market: null, probability: 0.6, result: { point_estimate: 0.6, mock: true },
    basis: { primary_anchor: { source: 'mock', summary: `${Q} trades at 0.6`, market_id: 2851234 }, limitations: ['Simulated oracle (COURNOT_MODE=mock): no Cournot probability call was made.'] },
    source: 'mock', fetchedAt: now - 30, error: null, raw: null,
  },
  prices: [{ t: now - 30, price: 0.6 }],
  settlement: null,
  proposal: null,
}

function stubSequencer() {
  const seen: string[] = []
  const json = (b: unknown) => new Response(JSON.stringify(b))
  vi.stubGlobal('WebSocket', class { close() {} send() {} })
  vi.stubGlobal('fetch', vi.fn(async (u: string) => {
    seen.push(u)
    if (u === '/api/config') return json(config)
    if (u === '/api/launches') return json([launch])
    if (u === '/api/launch/1') return json(launch)
    if (u === '/api/launch/1/oracle') return json(oracle)
    if (u.startsWith('/api/book/1')) return json({ bids: [{ price: 62, amount: E18.toString() }], asks: [{ price: 66, amount: E18.toString() }] })
    if (u.startsWith('/api/trades/1')) return json([])
    if (u.startsWith('/api/prices/')) return json([])
    return new Response('{}', { status: 404 })
  }))
  return seen
}

describe('question launch pages', () => {
  it('launch page: question title, YES/NO, Cournot and settlement panels, no price chart', async () => {
    const seen = stubSequencer()
    window.location.hash = '#/launch/1'
    render(
      <AppProvider>
        <App />
      </AppProvider>,
    )
    expect(await screen.findByRole('heading', { level: 1, name: Q })).toBeTruthy()
    const panel = await screen.findByTestId('cournot-panel')
    expect(panel.textContent).toContain('Resolved by Cournot')
    // the oracle's answer and its mode never reach the page before settlement
    expect(document.body.textContent).not.toMatch(/simulated|mock|60(\.0)?%|oracle \d|Cournot opening/i)
    expect(screen.getByTestId('settlement-panel').textContent).toContain('Settles')
    expect(screen.getByRole('button', { name: /^YES 66¢/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^NO 38¢/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Trade YES' })).toBeTruthy()
    expect(screen.queryByText(/Price to beat/)).toBeNull()
    expect(seen.some((u) => u.startsWith(`/api/prices/${ZERO}`))).toBe(false)
  })

  it('card: the question and "YES x¢"', async () => {
    stubSequencer()
    window.location.hash = '#/'
    render(
      <AppProvider>
        <App />
      </AppProvider>,
    )
    expect(await screen.findByText(Q)).toBeTruthy()
    expect(screen.getByText('YES 64¢')).toBeTruthy()
    expect(screen.getByText('NO 36¢')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/simulated|60%|oracle \d/i)
  })
})
