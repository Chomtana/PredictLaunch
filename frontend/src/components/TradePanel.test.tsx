import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { Book } from '../lib/api.ts'
import { TradePanel, type TradePanelProps } from './TradePanel.tsx'

const E18 = 10n ** 18n
const book: Book = {
  asks: [{ price: 60, amount: (100n * E18).toString() }],
  bids: [{ price: 55, amount: (100n * E18).toString() }],
}

function setup(over: Partial<TradePanelProps> = {}) {
  const onOrder = vi.fn(async () => null)
  const props: TradePanelProps = {
    launchId: 1,
    title: 'BTC ≥ $100,000',
    symbol: 'MOON',
    cutBps: 1000,
    settleTime: Math.floor(Date.now() / 1000) + 3600,
    tradable: true,
    book,
    position: null,
    balance: 10n * E18,
    keyReady: true,
    connected: true,
    onEnable: vi.fn(),
    onConnect: vi.fn(),
    onOrder,
    ...over,
  }
  render(<TradePanel {...props} />)
  return onOrder
}

describe('TradePanel', () => {
  it('stake 1 BNB at Up 60¢ with cut 10% shows win 1.49 BNB', () => {
    setup()
    expect(screen.getByRole('button', { name: /Up 60¢/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Down 45¢/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^1 BNB/ }))
    // 1 BNB / 0.60 = 1.666… shares → floored to 1.66 → payout 1.66 × 0.9 = 1.494
    expect(screen.getByTestId('to-win').textContent).toContain('1.49 BNB')
    expect(screen.getByRole('button', { name: /^1 BNB/ }).textContent).toContain('win 1.49 BNB')
  })

  it('market buy sends the Up order capped at the worst price touched', () => {
    const onOrder = setup()
    fireEvent.click(screen.getByRole('button', { name: /^1 BNB/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Buy Up/ }))
    expect(onOrder).toHaveBeenCalledTimes(1)
    const p = (onOrder.mock.calls[0] as unknown[])[0] as Record<string, unknown>
    expect(p).toMatchObject({ launchId: 1, outcome: 0, side: 0, price: 60, amount: 166n * 10n ** 16n, market: true })
  })

  it('Down buys hit the Up bids mirrored', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: /Down 45¢/ }))
    fireEvent.click(screen.getByRole('button', { name: /^1 BNB/ }))
    // 1 / 0.45 = 2.222 → 2.22 shares → 1.998 → "1.99"
    expect(screen.getByTestId('to-win').textContent).toContain('1.99 BNB')
  })

  it('Sell tab with no position disables submit', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'Sell' }))
    const submit = screen.getByRole('button', { name: /^Sell Up/ }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    expect(screen.getByText(/no Up shares/i)).toBeTruthy()
  })

  it('Sell tab with a position enables submit', () => {
    setup({ position: { up: 2n * E18, down: 0n } })
    fireEvent.click(screen.getByRole('button', { name: 'Sell' }))
    const submit = screen.getByRole('button', { name: /^Sell Up/ }) as HTMLButtonElement
    expect(submit.disabled).toBe(false)
  })

  it('after settlement (not tradable) shows Settling…', () => {
    setup({ tradable: false, settleTime: Math.floor(Date.now() / 1000) - 10 })
    expect(screen.getByText(/Settling…/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Buy Up/ })).toBeNull()
  })

  it('without a session key asks to enable trading', () => {
    setup({ keyReady: false })
    expect(screen.getByRole('button', { name: /Enable trading/ })).toBeTruthy()
  })
})
