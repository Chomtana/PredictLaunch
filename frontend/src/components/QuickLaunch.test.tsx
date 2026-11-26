import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Address } from 'viem'
import type { Config, CournotMarket } from '../lib/api.ts'
import type { LaunchDraft } from './CreateLaunch.tsx'
import { QUICK_SLACK, QuickLaunches, eventSettle, quickCards } from './QuickLaunch.tsx'

const E18 = 10n ** 18n
const BNB = '0x3957d289ee9c38272377786787ea34f9dd29788d' as Address
const BTC = '0x83b2f2c20df36f166cf5b3f017204cbb7babcad0' as Address
const ETH = '0x35369decd8c662954b3d24acc2a862c708a34fd2' as Address
const ZERO = '0x0000000000000000000000000000000000000000'

const config: Config = {
  chainId: 97,
  rpc: 'http://127.0.0.1:8545',
  exchange: '0x00000000000000000000000000000000000e8C4A',
  factory: '0x00000000000000000000000000000000000fac70',
  portal: '0x000042108465206185A077Edc3F3fd2b49060000',
  saltLockFee: (5n * 10n ** 15n).toString(),
  minTarget: (215n * 10n ** 16n).toString(),
  cuts: [1000, 1500, 2000, 2500, 3000],
  feeds: [
    { address: BNB, symbol: 'BNB/USD' },
    { address: BTC, symbol: 'BTC/USD' },
    { address: ETH, symbol: 'ETH/USD' },
  ],
  minDuration: 60,
  maxDuration: 30 * 86400,
  batchMs: 2000,
}
const prices: Record<string, bigint> = { [BNB]: 612_340n * 10n ** 15n, [BTC]: 97_233n * E18, [ETH]: 3_012n * E18 }
const priceOf = (f: Address) => prices[f] ?? null

const end = new Date(Date.now() + 3 * 86400_000).toISOString()
const market = (title: string, yesPrice = 0.93): CournotMarket => ({ matchingConfidence: 0.9, id: 4242, title, description: '', startTime: null, endTime: end, yesPrice })

function setup(resolve = vi.fn(async (q: string) => ({ markets: [market(`Market for: ${q}`)] }))) {
  const onSubmit = vi.fn(async (_cfg: LaunchDraft | (() => LaunchDraft)) => {})
  const cournot = { resolve, probability: vi.fn(async () => ({}) as never) }
  render(<QuickLaunches config={config} priceOf={priceOf} connected cournot={cournot} onSubmit={onSubmit} gapMs={0} />)
  return { onSubmit, cournot }
}
const draftOf = (onSubmit: ReturnType<typeof setup>['onSubmit']) => {
  const d = onSubmit.mock.calls[0][0]
  return typeof d === 'function' ? d() : d
}

describe('quickCards', () => {
  it('ten cards: the fixed prediction lineup with distinct random memes', () => {
    const cs = quickCards()
    expect(cs.map((c) => (c.kind === 'price' ? `${c.asset}:${c.seconds}` : 'event'))).toEqual([
      'BNB:60', 'BTC:60', 'event', 'event', 'ETH:3600',
      'BNB:86400', 'event', 'event', 'BTC:3600', 'event',
    ])
    expect(new Set(cs.map((c) => c.meme.symbol)).size).toBe(10)
    const themes = cs.flatMap((c) => (c.kind === 'event' ? [c.theme.search] : []))
    expect(new Set(themes).size).toBe(5)
    for (const c of cs) if (c.kind === 'price') expect(c.image).toBe(`/seed/${c.asset.toLowerCase()}.svg`)
  })
})

describe('eventSettle', () => {
  it("uses the market's end, at least 1 h out and at most the contract max", () => {
    const now = 1_800_000_000
    const at = (s: number) => market('x').endTime && { ...market('x'), endTime: s }
    expect(eventSettle(at(now + 86400) as CournotMarket, now, 30 * 86400)).toBe(now + 86400)
    expect(eventSettle(at(now + 60) as CournotMarket, now, 30 * 86400)).toBe(now + 3600)
    expect(eventSettle(at(now + 90 * 86400) as CournotMarket, now, 30 * 86400)).toBe(now + 30 * 86400)
    expect(eventSettle(null, now, 30 * 86400)).toBe(now + 86400)
  })
})

describe('QuickLaunches', () => {
  it('a 1-minute BNB card launches with a rounded strike, settling 1 min + slack after the wallet prompt', async () => {
    const { onSubmit } = setup()
    const first = screen.getAllByTestId('quick-card')[0]
    expect(first.textContent).toContain('BNB ≥ $612 in 1 min?')
    fireEvent.click(within(first).getByRole('button', { name: 'Launch' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    const before = Math.floor(Date.now() / 1000)
    const d = draftOf(onSubmit)
    expect(d.feed).toBe(BNB)
    expect(d.strike).toBe(612n * E18)
    expect(Number(d.settleTime) - before).toBeGreaterThanOrEqual(60 + QUICK_SLACK - 1)
    expect(Number(d.settleTime) - before).toBeLessThanOrEqual(60 + QUICK_SLACK + 1)
    expect(d.cutBps).toBe(1000)
    expect(d.target).toBe(BigInt(config.minTarget))
    expect(d.question).toBe('')
    expect(d.imageURI).toBe('/seed/bnb.svg')
  })

  it("event cards show the Cournot market's title (never its price) and launch it as the question", async () => {
    const { onSubmit, cournot } = setup()
    await waitFor(() => expect(screen.getAllByText(/^Market for: /)).toHaveLength(5))
    expect(document.body.textContent).not.toMatch(/93|simulated|mock/i)
    const card = screen.getAllByTestId('quick-card')[2]
    const title = within(card).getByText(/^Market for: /).textContent!
    fireEvent.click(within(card).getByRole('button', { name: 'Launch' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(cournot.probability).toHaveBeenCalledWith(title, '4242', { title, endTime: end })
    const d = draftOf(onSubmit)
    expect(d.feed).toBe(ZERO)
    expect(d.strike).toBe(0n)
    expect(d.question).toBe(title)
    expect(d.marketId).toBe(4242n)
    expect(d.settleTime).toBe(BigInt(Math.floor(Date.parse(end) / 1000)))
    expect(d.imageURI).toMatch(/^\/seed\/.+\.jpg$/)
  })

  it('skips asset-price markets and falls back to a spare theme', async () => {
    let n = 0
    const resolve = vi.fn(async (q: string) => ({ markets: [n++ === 0 ? market('Bitcoin price above $150,000 by Dec 31?') : market(`Market for: ${q}`)] }))
    setup(resolve)
    await waitFor(() => expect(screen.getAllByText(/^Market for: /)).toHaveLength(5))
    expect(screen.queryByText(/Bitcoin price/)).toBeNull()
    expect(resolve).toHaveBeenCalledTimes(6)
  })
})
