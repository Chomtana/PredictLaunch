import { describe, expect, it } from 'vitest'
import { binancePair, toWei18 } from './binance.ts'

describe('binance', () => {
  it('maps feed symbols to Binance USDT pairs', () => {
    expect(binancePair('BNB/USD')).toBe('BNBUSDT')
    expect(binancePair('BTCB/USD')).toBe('BTCUSDT')
    expect(binancePair('BTC/USD')).toBe('BTCUSDT')
    expect(binancePair('ETH/USD')).toBe('ETHUSDT')
    // No Binance pair, or a stablecoin: the oracle price is used.
    expect(binancePair('OIK / USD')).toBeNull()
    expect(binancePair('USDT/USD')).toBeNull()
    expect(binancePair('')).toBeNull()
    expect(binancePair(null)).toBeNull()
  })

  it('parses decimal prices to 18 decimals', () => {
    expect(toWei18('558.32000000')).toBe(558320000000000000000n)
    expect(toWei18('0.00310000')).toBe(3100000000000000n)
    expect(toWei18('60775')).toBe(60775n * 10n ** 18n)
  })
})
