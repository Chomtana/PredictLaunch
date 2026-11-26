// Display-only live prices from Binance's public market-data endpoints (no key, no account).
//
// The oracle feeds update every ~10 s to hours, which makes a flat, jumpy chart. For the demo the
// chart and the "now" price follow Binance trades instead. Settlement is NOT affected: it always uses
// the onchain oracle snapshot, which the chart also draws so any gap stays visible.

const WS_URL = 'wss://data-stream.binance.vision/stream?streams='
const REST_URL = 'https://data-api.binance.vision/api/v3/klines'

// Feed base symbol → Binance USDT pair. Only pairs that exist on Binance spot (checked 2026-11-26);
// any other feed (and the stablecoins, whose USDT pair says nothing about USD) keeps the oracle price.
const PAIRS: Record<string, string> = {
  BTC: 'BTCUSDT',
  BTCB: 'BTCUSDT',
  BNB: 'BNBUSDT',
  WBNB: 'BNBUSDT',
  ETH: 'ETHUSDT',
  CAKE: 'CAKEUSDT',
  ANKR: 'ANKRUSDT',
  ASTER: 'ASTERUSDT',
  WLFI: 'WLFIUSDT',
  AT: 'ATUSDT',
}

/** "BNB/USD" → "BNBUSDT", or null when Binance has no pair for it. */
export function binancePair(feedSymbol: string | null | undefined): string | null {
  if (!feedSymbol) return null
  const base = feedSymbol.split('/')[0].trim().toUpperCase()
  return PAIRS[base] ?? null
}

/** Decimal text → 18-decimal bigint ("558.32000000" → 558320000000000000000n). */
export function toWei18(s: string): bigint {
  const [i, f = ''] = s.split('.')
  return BigInt(i || '0') * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18))
}

export interface Tick {
  pair: string
  /** Unix seconds (fractional: trade time in ms / 1000). */
  t: number
  price: bigint
}

/**
 * Stream trades for `pairs`, at most one tick per pair every `throttleMs`. Reconnects with backoff.
 * Returns a close function.
 */
export function streamTrades(pairs: string[], onTick: (t: Tick) => void, throttleMs = 250): () => void {
  if (pairs.length === 0) return () => {}
  let ws: WebSocket | null = null
  let closed = false
  let retry = 1000
  let timer: ReturnType<typeof setTimeout> | undefined
  const lastSent = new Map<string, number>()
  const pending = new Map<string, Tick>()
  const flush = setInterval(() => {
    const now = Date.now()
    for (const [pair, tk] of pending) {
      if (now - (lastSent.get(pair) ?? 0) >= throttleMs) {
        pending.delete(pair)
        lastSent.set(pair, now)
        onTick(tk)
      }
    }
  }, Math.max(50, throttleMs / 2))

  const open = () => {
    if (closed) return
    ws = new WebSocket(WS_URL + pairs.map((p) => `${p.toLowerCase()}@aggTrade`).join('/'))
    ws.onopen = () => {
      retry = 1000
    }
    ws.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data as string).data as { s: string; p: string; T: number }
        pending.set(d.s, { pair: d.s, t: d.T / 1000, price: toWei18(d.p) })
      } catch {
        /* ignore malformed frames */
      }
    }
    ws.onclose = () => {
      if (closed) return
      timer = setTimeout(open, retry)
      retry = Math.min(retry * 2, 30_000)
    }
    ws.onerror = () => ws?.close()
  }
  open()
  return () => {
    closed = true
    clearInterval(flush)
    clearTimeout(timer)
    ws?.close()
  }
}

/** Close prices for the last `sinceSec`: 1 m candles, with the most recent ~16 min at 1 s. */
export async function history(pair: string, sinceSec: number): Promise<{ t: number; price: bigint }[]> {
  type K = [number, string, string, string, string]
  const get = async (interval: string, startMs: number): Promise<K[]> => {
    const r = await fetch(`${REST_URL}?symbol=${pair}&interval=${interval}&startTime=${startMs}&limit=1000`)
    if (!r.ok) throw new Error(`binance ${r.status}`)
    return r.json()
  }
  const nowMs = Date.now()
  const [mins, secs] = await Promise.all([get('1m', sinceSec * 1000), get('1s', nowMs - 1000 * 1000)])
  const fineStart = secs.length ? secs[0][0] : Infinity
  const out: { t: number; price: bigint }[] = []
  for (const k of mins) if (k[0] + 60_000 <= fineStart) out.push({ t: (k[0] + 60_000) / 1000, price: toWei18(k[4]) })
  for (const k of secs) out.push({ t: (k[0] + 1000) / 1000, price: toWei18(k[4]) })
  return out
}
