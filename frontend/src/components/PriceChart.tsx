import { useEffect, useRef, useState } from 'react'
import {
  AreaSeries,
  ColorType,
  createChart,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type TickMarkType,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'
import type { Address } from 'viem'
import { api } from '../lib/api.ts'
import { history as binanceHistory } from '../lib/binance.ts'
import { chartCrosshair, chartTick } from '../lib/format.ts'
import { num18 } from '../lib/units.ts'
import { useApp } from '../state.tsx'

const HISTORY_SEC = 3 * 3600

/**
 * Live price with a dashed line at the strike. Feeds with a Binance pair draw Binance trades (display
 * only) with a dashed reference line at the latest oracle price, which settlement uses; other feeds
 * draw the oracle itself.
 */
export function PriceChart({ feed, strike, settleTime }: { feed: Address; strike: bigint; settleTime: number }) {
  const { onPriceTick, onLiveTick, livePairOf } = useApp()
  const pair = livePairOf(feed)
  const el = useRef<HTMLDivElement>(null)
  const chart = useRef<IChartApi | null>(null)
  const series = useRef<ISeriesApi<'Area'> | null>(null)
  const oracleLine = useRef<IPriceLine | null>(null)
  // Reference levels kept in view by the autoscale (price lines alone don't widen the scale).
  const levels = useRef<{ strike: number | null; oracle: number | null }>({ strike: null, oracle: null })
  const strikeLine = useRef<IPriceLine | null>(null)
  const [points, setPoints] = useState(0)

  useEffect(() => {
    if (!el.current) return
    const c = createChart(el.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#828da0', fontFamily: 'Inter Variable, system-ui', attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: 'rgba(255,255,255,0.05)' } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.15, bottom: 0.15 } },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: true,
        rightOffset: 6,
        tickMarkFormatter: (t: Time, k: TickMarkType) => chartTick(t as number, k),
      },
      localization: { timeFormatter: (t: Time) => chartCrosshair(t as number) },
      crosshair: { mode: CrosshairMode.Magnet },
      handleScroll: true,
      handleScale: true,
    })
    series.current = c.addSeries(AreaSeries, {
      lineColor: '#ff9f2e',
      topColor: 'rgba(255,159,46,0.18)',
      bottomColor: 'rgba(255,159,46,0)',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerRadius: 4,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      autoscaleInfoProvider: (base: () => { priceRange: { minValue: number; maxValue: number } } | null) => {
        const r = base()
        if (!r) return r
        for (const v of [levels.current.strike, levels.current.oracle]) {
          if (v == null) continue
          r.priceRange.minValue = Math.min(r.priceRange.minValue, v)
          r.priceRange.maxValue = Math.max(r.priceRange.maxValue, v)
        }
        return r
      },
    })
    chart.current = c
    return () => {
      c.remove()
      chart.current = null
      series.current = null
      oracleLine.current = null
      strikeLine.current = null
    }
  }, [])

  // Strike line.
  useEffect(() => {
    const s = series.current
    if (!s) return
    if (strikeLine.current) s.removePriceLine(strikeLine.current)
    strikeLine.current = s.createPriceLine({
      price: num18(strike),
      color: '#c2cad6',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: 'Price to beat',
    })
    const p = num18(strike)
    levels.current.strike = p
    const prec = p >= 1000 ? 2 : p >= 1 ? 4 : 6
    s.applyOptions({ priceFormat: { type: 'price', precision: prec, minMove: 1 / 10 ** prec } })
  }, [strike])

  // Oracle: sequencer REST history, WS ticks, and a 5 s poll as a fallback. Without a Binance pair it is
  // the chart's line; with one, only its latest value is drawn, as a dashed "Oracle" reference line.
  useEffect(() => {
    const s = series.current
    if (!s) return
    let stop = false
    let last = 0
    const clearRef = () => {
      if (oracleLine.current) s.removePriceLine(oracleLine.current)
      oracleLine.current = null
      levels.current.oracle = null
    }
    clearRef()
    if (!pair) {
      s.setData([])
      setPoints(0)
    }
    const setRef = (price: bigint) => {
      const v = num18(price)
      levels.current.oracle = v
      if (oracleLine.current) oracleLine.current.applyOptions({ price: v })
      else
        oracleLine.current = s.createPriceLine({
          price: v,
          color: '#5aa9ff',
          lineWidth: 1,
          lineStyle: LineStyle.LargeDashed,
          axisLabelVisible: true,
          title: 'Oracle',
        })
    }
    const push = (t: number, price: bigint) => {
      t = Math.floor(t)
      if (stop || t < last) return
      last = t
      if (pair) return setRef(price)
      s.update({ time: t as UTCTimestamp, value: num18(price) })
      setPoints((n) => n + 1)
    }
    const now = Math.floor(Date.now() / 1000)
    const since = Math.min(now, settleTime) - HISTORY_SEC
    api
      .prices(feed, since)
      .then((pts) => {
        if (stop || !pts.length) return
        const data = dedupe(pts.map((p) => ({ t: p.t, price: BigInt(p.price) })))
        last = data[data.length - 1].time
        if (pair) return setRef(BigInt(pts[pts.length - 1].price))
        s.setData(data)
        setPoints(data.length)
        chart.current?.timeScale().fitContent()
      })
      .catch(() => {})
    const off = onPriceTick((f, t, p) => {
      if (f.toLowerCase() === feed.toLowerCase()) push(t, p)
    })
    const poll = setInterval(() => {
      api
        .prices(feed, last || since)
        .then((pts) => pts.forEach((p) => push(p.t, BigInt(p.price))))
        .catch(() => {})
    }, 5000)
    return () => {
      stop = true
      off()
      clearInterval(poll)
      clearRef()
    }
  }, [feed, pair, settleTime, onPriceTick])

  // Binance line (display only): 1 m + 1 s candle history, then trades.
  useEffect(() => {
    if (!pair || !series.current) return
    const s = series.current
    let stop = false
    let last = 0
    s.setData([])
    setPoints(0)
    const buffered: { t: number; price: bigint }[] = []
    let loaded = false
    const push = (t: number, price: bigint) => {
      t = Math.floor(t)
      if (stop || t < last) return
      last = t
      s.update({ time: t as UTCTimestamp, value: num18(price) })
      setPoints((n) => n + 1)
    }
    const off = onLiveTick((f, t, p) => {
      if (f.toLowerCase() !== feed.toLowerCase()) return
      if (loaded) push(t, p)
      else buffered.push({ t, price: p })
    })
    const now = Math.floor(Date.now() / 1000)
    binanceHistory(pair, Math.min(now, settleTime) - HISTORY_SEC)
      .then((pts) => {
        if (stop) return
        const data = dedupe(pts)
        s.setData(data)
        last = data.length ? data[data.length - 1].time : 0
        setPoints(data.length)
        chart.current?.timeScale().fitContent()
      })
      .catch(() => {})
      .finally(() => {
        loaded = true
        buffered.forEach((b) => push(b.t, b.price))
      })
    return () => {
      stop = true
      off()
    }
  }, [feed, pair, settleTime, onLiveTick])

  return (
    <div className="chart-wrap">
      <div ref={el} style={{ position: 'absolute', inset: 0 }} />
      {points === 0 && <div className="chart-empty">Waiting for price data…</div>}
      <div className="chart-legend">
        {pair ? (
          <>
            Live: Binance {pair} · dashed blue: Atlas oracle (settles the market)
          </>
        ) : (
          'Source: CoinMarketCap × Atlas'
        )}
      </div>
    </div>
  )
}


/** Whole-second, strictly increasing points (the last price in each second wins). */
function dedupe(pts: { t: number; price: bigint }[]): { time: UTCTimestamp; value: number }[] {
  const out: { time: UTCTimestamp; value: number }[] = []
  for (const p of pts) {
    const time = Math.floor(p.t) as UTCTimestamp
    const v = num18(p.price)
    if (out.length && time < out[out.length - 1].time) continue
    if (out.length && time === out[out.length - 1].time) out[out.length - 1].value = v
    else out.push({ time, value: v })
  }
  return out
}
