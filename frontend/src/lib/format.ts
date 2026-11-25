// Display helpers (adapted from biliquid's lib/format.ts).

export const shortAddr = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '')

export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 2) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/** Compact time left: "2d 4h", "3h 12m", "4m 05s", "12s". */
export function duration(sec: number): string {
  if (sec <= 0) return '0s'
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${s}s`
}

/** Countdown parts for the big timer. */
export function countdown(sec: number): { d: number; h: number; m: number; s: number } {
  const t = Math.max(0, Math.floor(sec))
  return { d: Math.floor(t / 86400), h: Math.floor((t % 86400) / 3600), m: Math.floor((t % 3600) / 60), s: t % 60 }
}

export const pad2 = (n: number) => String(n).padStart(2, '0')

/** "Nov 26, 12:00" in the viewer's timezone. */
export function settleLabel(unixSec: number, locale?: string, timeZone?: string): string {
  return new Date(unixSec * 1000).toLocaleString(locale ?? 'en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  })
}

export const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** "BTCB/USD" → "BTC" for display (BTCB is BTC on BSC). */
export function asset(feedSymbol?: string | null): string {
  if (!feedSymbol) return '?'
  const base = feedSymbol.split('/')[0]
  return base === 'BTCB' ? 'BTC' : base
}

/** Chart axis labels in the viewer's timezone (lightweight-charts TickMarkType: 0 Year … 4 TimeWithSeconds). */
export function chartTick(sec: number, tickType: number): string {
  const d = new Date(sec * 1000)
  const o: Intl.DateTimeFormatOptions =
    tickType === 0
      ? { year: 'numeric' }
      : tickType === 1
        ? { month: 'short' }
        : tickType === 2
          ? { month: 'short', day: 'numeric' }
          : tickType === 3
            ? { hour: '2-digit', minute: '2-digit', hour12: false }
            : { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }
  return d.toLocaleString(undefined, o)
}

export const chartCrosshair = (sec: number) =>
  new Date(sec * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

export function hue(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360
  return h
}

/** Compact token count: 12.3M, 450K. */
export function compact(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return n.toFixed(n >= 1 ? 0 : 2)
}
