import { useEffect, useState } from 'react'
import { api, big, n, type Book, type LaunchDetail, type LaunchOracle, type Trade } from '../lib/api.ts'
import { labelsFor } from '../lib/labels.ts'
import { CournotPanel, SettlementPanel } from './Cournot.tsx'
import { midUp } from '../lib/market.ts'
import { fmtPrice } from '../lib/units.ts'
import { useApp } from '../state.tsx'
import { phaseOf } from './LaunchCard.tsx'
import { LaunchProgress } from './LaunchProgress.tsx'
import { OrderBook } from './OrderBook.tsx'
import { Positions } from './Positions.tsx'
import { PriceChart } from './PriceChart.tsx'
import { PriceHeader, QuestionHeader, question } from './PriceHeader.tsx'
import { TradePanel } from './TradePanel.tsx'
import { OutcomePanel } from './OutcomePanel.tsx'
import { Spinner, useNow } from './ui.tsx'

export function LaunchPage({ id }: { id: number }) {
  const app = useApp()
  const { config, live, watchLaunch, user, wallet, tradingReady, quoteUsd, priceOf, oraclePriceOf, livePairOf, feedSymbol } = app
  const now = useNow(1000)
  const [detail, setDetail] = useState<LaunchDetail | null>(null)
  const [book, setBook] = useState<Book | null>(null)
  const [trades, setTrades] = useState<Trade[]>([])
  const [missing, setMissing] = useState(false)
  const [oracle, setOracle] = useState<LaunchOracle | null>(null)

  useEffect(() => {
    watchLaunch(id)
    return () => watchLaunch(null)
  }, [id, watchLaunch])

  // REST polling (the WS snapshot, when connected, overrides it).
  useEffect(() => {
    if (!config) return
    let stop = false
    setDetail(null)
    setMissing(false)
    const load = () => {
      api
        .launch(id)
        .then((d) => !stop && (setDetail(d), setMissing(false)))
        .catch((e) => !stop && (e as { code?: string }).code === 'http_404' && setMissing(true))
      api
        .book(id)
        .then((b) => !stop && setBook(b))
        .catch(() => {})
      api
        .trades(id, 50)
        .then((t) => !stop && setTrades(t))
        .catch(() => {})
    }
    load()
    const t = setInterval(load, 2500)
    return () => {
      stop = true
      clearInterval(t)
    }
  }, [id, config])

  const l = live.launch && Number(live.launch.id) === id ? { ...detail, ...live.launch } : detail
  const isQ = labelsFor(l).kind === 'question'

  // Question launches: the oracle record, tracked prices and the resolver's proposal (free reads, slow poll).
  useEffect(() => {
    if (!config || !isQ) return
    let stop = false
    setOracle(null)
    const load = () =>
      api
        .oracle(id)
        .then((o) => !stop && setOracle(o))
        .catch(() => {})
    load()
    const t = setInterval(load, 10_000)
    return () => {
      stop = true
      clearInterval(t)
    }
  }, [id, config, isQ])
  const b = live.book ?? book
  const tr = live.trades ?? trades

  if (!config || !l) {
    return (
      <div className="page">
        <div className="panel empty">
          {missing ? (
            <>
              <div>Launch #{id} not found.</div>
              <a className="btn" href="#/">
                Back to launches
              </a>
            </>
          ) : (
            <>
              <Spinner /> {config ? 'Loading launch…' : 'Waiting for the sequencer…'}
            </>
          )}
        </div>
      </div>
    )
  }

  const phase = phaseOf(l, now)
  const feedSym = feedSymbol(l.feed)
  const strike = big(l.strike)
  const settleTime = n(l.settleTime)
  const current = priceOf(l.feed) ?? (l.currentPrice ? big(l.currentPrice) : null)
  const pos = user?.positions.find((p) => String(p.launchId) === String(id))
  const position = pos ? { up: big(pos.up), down: big(pos.down) } : null
  const mine = user?.launches.find((x) => String(x.launchId) === String(id)) ?? null
  const orders = (user?.orders ?? []).filter((o) => String(o.launchId) === String(id) && (!o.status || o.status === 'open'))
  const balance = user ? big(user.balance) - big(user.locked) : null
  const tradable = phase === 'live'
  const settled = phase === 'graduated' || phase === 'graduating' || phase === 'failed' || phase === 'void'
  const labels = labelsFor(l)
  const yesMid = midUp(b)
  const qText = l.question || `Question #${id}`
  const probability = oracle?.opening?.probability ?? l.oracleProbability ?? null

  return (
    <div className="page">
      <div className="launch-layout">
        <div className="launch-main">
          {isQ ? (
            <QuestionHeader
              name={l.name}
              symbol={l.symbol}
              image={l.imageURI}
              question={qText}
              settleTime={settleTime}
              phase={phase}
              now={now}
              yesMid={yesMid}
              probability={probability}
              source={oracle?.opening?.source ?? l.oracleSource ?? null}
            />
          ) : (
          <PriceHeader
            name={l.name}
            symbol={l.symbol}
            image={l.imageURI}
            feedSym={feedSym}
            strike={strike}
            current={current}
            oracle={livePairOf(l.feed) ? (oraclePriceOf(l.feed) ?? (l.currentPrice ? big(l.currentPrice) : null)) : null}
            settleTime={settleTime}
            settlePrice={l.snapped ? big(l.settlePrice) : null}
            phase={phase}
            now={now}
          />
          )}
          {settled && <OutcomePanel l={l} phase={phase} mine={mine} />}
          {isQ ? (
            <>
              <CournotPanel question={qText} oracle={oracle} probability={l.oracleProbability} source={l.oracleSource} bookYes={yesMid} />
              <SettlementPanel oracle={oracle} settleTime={settleTime} now={now} resolved={l.resolved} outcome={n(l.outcome)} />
            </>
          ) : (
            <PriceChart feed={l.feed} strike={strike} settleTime={settleTime} />
          )}
          <LaunchProgress l={l} quoteUsd={quoteUsd} position={position} mine={mine} />
          <Positions position={position} cutBps={n(l.cutBps)} mid={yesMid} orders={orders} trades={tr} onCancel={app.cancelOrder} labels={labels} />
        </div>
        <div className="launch-side">
          {!settled && (
          <TradePanel
            launchId={id}
            title={isQ ? qText : question(feedSym, strike, settleTime)}
            labels={labels}
            symbol={l.symbol}
            cutBps={n(l.cutBps)}
            settleTime={settleTime}
            tradable={tradable}
            book={b}
            position={position}
            balance={balance}
            keyReady={tradingReady}
            connected={!!wallet}
            onEnable={app.enableTrading}
            onConnect={() => app.setAccountOpen(true)}
            onOrder={app.placeOrder}
          />
          )}
          {!settled && <OrderBook book={b} labels={labels} />}
          {settled && (
            <div className="panel section">
              <h3>Market settled</h3>
              <div className="muted small">
                {isQ ? (
                  <>Resolved {n(l.outcome) === 2 ? 'VOID' : labels.names[n(l.outcome) === 0 ? 0 : 1]} from the Cournot evidence.</>
                ) : (
                  <>
                    Settlement price {l.snapped ? fmtPrice(l.settlePrice) : '—'} vs strike {fmtPrice(strike)}.
                  </>
                )}{' '}
                Payouts were sent to traders automatically.
              </div>
              <button className="btn wide" style={{ marginTop: 12 }} onClick={() => app.setAccountOpen(true)}>
                View balance
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
