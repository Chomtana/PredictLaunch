import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { Address } from 'viem'
import { ApiError, type Config } from '../lib/api.ts'
import { CreateLaunchForm, toLocalInput } from './CreateLaunch.tsx'

const E18 = 10n ** 18n
const BTC = '0xe20536bc715aac6560394e33deb66ed205aeec33' as Address
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
  feeds: [{ address: BTC, symbol: 'BTCB/USD' }],
  minDuration: 300,
  maxDuration: 30 * 86400,
  batchMs: 2000,
  cournotMode: 'mock',
}
const priceOf = (f: Address) => (f === BTC ? 100_000n * E18 : null)

const Q = 'Will the Fed increase interest rates by 25 bps after the December 2026 meeting?'
// two days out, on a whole minute (the datetime-local input has minute precision)
const endMs = Math.ceil((Date.now() + 2 * 86400_000) / 60_000) * 60_000
const markets = [
  { matchingConfidence: 0.854, id: 2849008, title: Q, description: 'FOMC', startTime: '2026-11-01T00:00:00Z', endTime: new Date(endMs).toISOString(), yesPrice: 0.9336 },
  { matchingConfidence: 0.76, id: 77, title: 'Will it rain in Austin on Nov 27, 2026?', description: '', startTime: null, endTime: null, yesPrice: 0.2 },
]
const record = {
  launchId: null,
  claim: Q,
  marketId: 2849008,
  market: null,
  probability: 0.9336,
  result: { point_estimate: 0.9336, mock: true },
  basis: {
    primary_anchor: { source: 'mock', summary: `${Q} trades at 0.9336`, market_id: 2849008 },
    limitations: ['Simulated oracle (COURNOT_MODE=mock): no Cournot probability call was made.'],
  },
  source: 'mock' as const,
  fetchedAt: 1_795_000_000,
  error: null,
  raw: null,
}

const submit = () => screen.getByRole('button', { name: /create launch/i }) as HTMLButtonElement

function setup(cournot = { resolve: vi.fn(async () => ({ markets })), probability: vi.fn(async () => record) }) {
  const onSubmit = vi.fn(async () => {})
  render(<CreateLaunchForm config={config} priceOf={priceOf} quoteUsd={600n * E18} connected onSubmit={onSubmit} cournot={cournot} />)
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Fed Hike' } })
  fireEvent.change(screen.getByLabelText('Symbol'), { target: { value: 'HIKE' } })
  fireEvent.click(screen.getByRole('button', { name: 'Question' }))
  fireEvent.change(screen.getByLabelText('Question'), { target: { value: Q } })
  return { cournot, onSubmit }
}

describe('CreateLaunchForm question mode', () => {
  it('price mode is the default and has no question field', () => {
    render(<CreateLaunchForm config={config} priceOf={priceOf} quoteUsd={600n * E18} connected onSubmit={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Price' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByLabelText('Question')).toBeNull()
    expect(screen.getByLabelText(/Strike/)).toBeTruthy()
  })

  it('resolve → pick → preview → launch builds feed 0, strike 0, question, marketId', async () => {
    const { cournot, onSubmit } = setup()
    expect(screen.queryByLabelText(/Strike/)).toBeNull()
    expect(submit().disabled).toBe(true) // a market must be picked first
    fireEvent.click(screen.getByRole('button', { name: /Find markets/ }))
    await screen.findByText(markets[1].title)
    expect(cournot.resolve).toHaveBeenCalledWith(Q)
    expect(screen.getByText(/YES 93¢/)).toBeTruthy()
    expect(screen.getByText(/confidence 85%/)).toBeTruthy()
    expect(submit().disabled).toBe(true) // nothing preselected, even at high confidence
    fireEvent.click(screen.getAllByRole('radio')[0])
    expect((screen.getByLabelText(/Settlement/) as HTMLInputElement).value).toBe(toLocalInput(new Date(endMs)))
    expect(screen.getByText(/prefilled with the market's end time/)).toBeTruthy()
    expect(cournot.probability).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /Get Cournot odds/ }))
    const rec = await screen.findByTestId('oracle-record')
    expect(cournot.probability).toHaveBeenCalledTimes(1)
    expect(cournot.probability).toHaveBeenCalledWith(Q, '2849008')
    expect(rec.textContent).toContain('93.4%')
    expect(rec.textContent).toContain('Simulated oracle')
    expect(rec.textContent).toContain('point_estimate')
    expect(rec.textContent).toContain('Primary anchor')

    expect(submit().disabled).toBe(false)
    fireEvent.click(submit())
    await Promise.resolve()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    const cfg = (onSubmit.mock.calls[0] as unknown[])[0] as Record<string, unknown>
    expect(cfg.feed).toBe(ZERO)
    expect(cfg.strike).toBe(0n)
    expect(cfg.question).toBe(Q)
    expect(cfg.marketId).toBe(2849008n)
    expect(cfg.settleTime).toBe(BigInt(endMs / 1000))
    expect(cfg.name).toBe('Fed Hike')
  })

  it('"No matching market" launches with marketId 0, and typing never calls probability', async () => {
    const { cournot, onSubmit } = setup()
    fireEvent.click(screen.getByRole('button', { name: /Find markets/ }))
    fireEvent.click(await screen.findByRole('radio', { name: /No matching market/ }))
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: Q + ' ' } })
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: Q } })
    fireEvent.click(submit())
    await Promise.resolve()
    expect(cournot.probability).not.toHaveBeenCalled()
    const cfg = (onSubmit.mock.calls[0] as unknown[])[0] as Record<string, unknown>
    expect(cfg.marketId).toBe(0n)
    expect(cfg.question).toBe(Q)
    expect(cfg.feed).toBe(ZERO)
  })

  it('a 402 shows a friendly payment message', async () => {
    setup({ resolve: vi.fn(async () => ({ markets })), probability: vi.fn(async () => Promise.reject(new ApiError('payment_required', 'HTTP 402'))) })
    fireEvent.click(screen.getByRole('button', { name: /Find markets/ }))
    fireEvent.click(await screen.findByRole('radio', { name: /No matching market/ }))
    fireEvent.click(screen.getByRole('button', { name: /Get Cournot odds/ }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/payment/i)
  })

  it('rejects a question over 280 bytes', () => {
    setup()
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'x'.repeat(281) } })
    expect(screen.getByText('At most 280 bytes')).toBeTruthy()
    expect((screen.getByRole('button', { name: /Find markets/ }) as HTMLButtonElement).disabled).toBe(true)
  })
})
