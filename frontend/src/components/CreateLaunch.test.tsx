import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { Address } from 'viem'
import type { Config } from '../lib/api.ts'
import { CreateLaunchForm, toLocalInput } from './CreateLaunch.tsx'

const E18 = 10n ** 18n
const BTC = '0xe20536bc715aac6560394e33deb66ed205aeec33' as Address
const BNB = '0xb3d1614bf894e68add1ea50ca250c152bad5256f' as Address

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
    { address: BTC, symbol: 'BTCB/USD' },
    { address: BNB, symbol: 'BNB/USD' },
  ],
  minDuration: 300,
  maxDuration: 30 * 86400,
  batchMs: 2000,
}

const priceOf = (f: Address) => (f === BTC ? 100_000n * E18 : f === BNB ? 600n * E18 : null)

function setup(onSubmit = vi.fn(async () => {})) {
  render(<CreateLaunchForm config={config} priceOf={priceOf} quoteUsd={600n * E18} connected onSubmit={onSubmit} />)
  fireEvent.click(screen.getByRole('button', { name: 'Price' }))
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Moon Dog' } })
  fireEvent.change(screen.getByLabelText('Symbol'), { target: { value: 'MDOG' } })
  return onSubmit
}
const submit = () => screen.getByRole('button', { name: /create launch/i }) as HTMLButtonElement

describe('CreateLaunchForm', () => {
  it('defaults: cut 10%, strike prefilled with the current price, target = minTarget', () => {
    setup()
    expect(screen.getByRole('button', { name: '10%' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '30%' }).getAttribute('aria-pressed')).toBe('false')
    expect((screen.getByLabelText(/Strike/) as HTMLInputElement).value).toBe('100000')
    expect((screen.getByLabelText(/Target/) as HTMLInputElement).value).toBe('2.15')
    expect(submit().disabled).toBe(false)
  })

  it('switching feed re-prefills the strike', () => {
    setup()
    fireEvent.change(screen.getByLabelText('Feed'), { target: { value: BNB } })
    expect((screen.getByLabelText(/Strike/) as HTMLInputElement).value).toBe('600')
  })

  it('target below minTarget disables submit', () => {
    setup()
    fireEvent.change(screen.getByLabelText(/Target/), { target: { value: '2' } })
    expect(submit().disabled).toBe(true)
    expect(screen.getByText(/at least 2.15 BNB/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText(/Target/), { target: { value: '3' } })
    expect(submit().disabled).toBe(false)
  })

  it('USDT quote: target in USDT from minTarget, priced at $1', () => {
    const usdt = { ...config, quoteToken: '0x190C989D5665a0e404B444b53CAE9AbCfb600157' as Address, quoteSymbol: 'USDT', minTarget: (3000n * E18).toString() }
    render(<CreateLaunchForm config={usdt} priceOf={priceOf} quoteUsd={E18} connected onSubmit={vi.fn(async () => {})} />)
    fireEvent.click(screen.getByRole('button', { name: 'Price' }))
    expect(screen.getByLabelText('Target (USDT)')).toBeTruthy()
    expect((screen.getByLabelText(/Target/) as HTMLInputElement).value).toBe('3000')
    expect(screen.getByText(/\$3,000 · pool needed/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText(/Target/), { target: { value: '1000' } })
    expect(screen.getByText(/at least 3,000 USDT/)).toBeTruthy()
    expect(screen.getByText(/backed by 1 USDT/)).toBeTruthy()
  })

  it('settlement under 5 minutes out disables submit', () => {
    setup()
    fireEvent.change(screen.getByLabelText(/Settlement/), { target: { value: toLocalInput(new Date(Date.now() + 120_000)) } })
    expect(submit().disabled).toBe(true)
  })

  it('submits the LaunchConfig fields in contract units', async () => {
    const onSubmit = setup()
    fireEvent.click(screen.getByRole('button', { name: '25%' }))
    fireEvent.change(screen.getByLabelText(/Strike/), { target: { value: '101000.5' } })
    fireEvent.click(submit())
    await Promise.resolve()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    const cfg = (onSubmit.mock.calls[0] as unknown[])[0] as Record<string, unknown>
    expect(cfg.name).toBe('Moon Dog')
    expect(cfg.symbol).toBe('MDOG')
    expect(cfg.feed).toBe(BTC)
    expect(cfg.cutBps).toBe(2500)
    expect(cfg.strike).toBe(1010005n * 10n ** 17n)
    expect(cfg.target).toBe(215n * 10n ** 16n)
    expect(Number(cfg.settleTime)).toBeGreaterThan(Date.now() / 1000 + 300)
  })

  it('Quick tab shows the Flap / Four.meme picker, Flap by default', () => {
    const onVenue = vi.fn()
    const cournot = { resolve: vi.fn(() => new Promise<never>(() => {})), probability: vi.fn() }
    render(
      <CreateLaunchForm
        config={{ ...config, fourRail: '0x00000000000000000000000000000000000F0047' }}
        priceOf={priceOf}
        quoteUsd={600n * E18}
        connected
        onSubmit={vi.fn()}
        onVenue={onVenue}
        cournot={cournot as never}
      />,
    )
    expect(screen.getByRole('button', { name: 'Quick' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Flap' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Four.meme' }))
    expect(onVenue).toHaveBeenCalledWith('four')
  })

  it('no picker without a Four rail', () => {
    render(<CreateLaunchForm config={config} priceOf={priceOf} quoteUsd={600n * E18} connected onSubmit={vi.fn()} onVenue={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Four.meme' })).toBeNull()
  })
})
