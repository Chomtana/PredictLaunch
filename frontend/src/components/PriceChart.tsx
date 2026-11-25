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
  type UTCTimestamp,
} from 'lightweight-charts'
import type { Address } from 'viem'
import { api } from '../lib/api.ts'
import { num18 } from '../lib/units.ts'
import { useApp } from '../state.tsx'

const HISTORY_SEC = 3 * 3600

/** Live feed price (REST history + WS ticks) with a dashed line at the strike. */
export function PriceChart({ feed, strike, settleTime }: { feed: Address; strike: bigint; settleTime: number }) {
  const { onPriceTick } = useApp()
  const el = useRef<HTMLDivElement>(null)
  const chart = useRef<IChartApi | null>(null)
  const series = useRef<ISeriesApi<'Area'> | null>(null)
  const strikeLine = useRef<IPriceLine | null>(null)
  const lastT = useRef(0)
  const [points, setPoints] = useState(0)

  useEffect(() => {
    if (!el.current) return
    const c = createChart(el.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#828da0', fontFamily: 'Inter Variable, system-ui', attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: 'rgba(255,255,255,0.05)' } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.15, bottom: 0.15 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: true, rightOffset: 6 },
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
    })
    chart.current = c
    return () => {
      c.remove()
      chart.current = null
      series.current = null
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
    const prec = p >= 1000 ? 2 : p >= 1 ? 4 : 6
    s.applyOptions({ priceFormat: { type: 'price', precision: prec, minMove: 1 / 10 ** prec } })
  }, [strike])

  // History, then poll as a fallback for WS ticks.
  useEffect(() => {
    let stop = false
    lastT.current = 0
    series.current?.setData([])
    setPoints(0)
    const push = (t: number, price: bigint) => {
      if (!series.current || t <= lastT.current) return
      lastT.current = t
      series.current.update({ time: t as UTCTimestamp, value: num18(price) })
      setPoints((n) => n + 1)
    }
    const now = Math.floor(Date.now() / 1000)
    const since = Math.min(now, settleTime) - HISTORY_SEC
    api
      .prices(feed, since)
      .then((pts) => {
        if (stop || !series.current) return
        const data: { time: UTCTimestamp; value: number }[] = []
        for (const p of pts) {
          if (data.length && p.t <= data[data.length - 1].time) continue
          data.push({ time: p.t as UTCTimestamp, value: num18(p.price) })
        }
        series.current.setData(data)
        lastT.current = data.length ? data[data.length - 1].time : 0
        setPoints(data.length)
        chart.current?.timeScale().fitContent()
      })
      .catch(() => {})
    const off = onPriceTick((f, t, p) => {
      if (f.toLowerCase() === feed.toLowerCase()) push(t, p)
    })
    const poll = setInterval(() => {
      api
        .prices(feed, lastT.current || since)
        .then((pts) => pts.forEach((p) => push(p.t, BigInt(p.price))))
        .catch(() => {})
    }, 5000)
    return () => {
      stop = true
      off()
      clearInterval(poll)
    }
  }, [feed, settleTime, onPriceTick])

  return (
    <div className="chart-wrap">
      <div ref={el} style={{ position: 'absolute', inset: 0 }} />
      {points === 0 && <div className="chart-empty">Waiting for price data…</div>}
      <div className="chart-legend">Source: Atlas oracle</div>
    </div>
  )
}

