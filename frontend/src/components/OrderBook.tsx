import { useState } from 'react'
import type { Book, Level } from '../lib/api.ts'
import { mirror } from '../lib/market.ts'
import { cost, fmtBnb, fmtShares } from '../lib/units.ts'

const DEPTH = 8

/** One Up-terms ladder; the Down view is the same book mirrored (Down ask = 100 − Up bid). */
export function OrderBook({ book }: { book: Book | null }) {
  const [view, setView] = useState<0 | 1>(0)
  const b = book ? (view === 0 ? book : mirror(book)) : null
  const asks = (b?.asks ?? []).slice(0, DEPTH)
  const bids = (b?.bids ?? []).slice(0, DEPTH)
  const max = [...asks, ...bids].reduce((m, l) => (BigInt(l.amount) > m ? BigInt(l.amount) : m), 1n)
  const spread = asks[0] && bids[0] ? asks[0].price - bids[0].price : null
  const last = asks[0] && bids[0] ? Math.round((asks[0].price + bids[0].price) / 2) : null
  return (
    <div className="panel ob">
      <div className="ob-head">
        <h3>Order book</h3>
        <div className="seg">
          <button className={view === 0 ? 'on' : ''} onClick={() => setView(0)}>
            Trade Up
          </button>
          <button className={view === 1 ? 'on' : ''} onClick={() => setView(1)}>
            Trade Down
          </button>
        </div>
      </div>
      <div className="ob-cols">
        <span>Price</span>
        <span style={{ textAlign: 'right' }}>Shares</span>
        <span style={{ textAlign: 'right' }}>Total</span>
      </div>
      {asks.length === 0 && <div className="ob-empty">No asks</div>}
      {[...asks].reverse().map((l) => (
        <Row key={`a${l.price}`} l={l} kind="ask" max={max} />
      ))}
      <div className="ob-mid">
        <span>{last != null ? `Mid ${last}¢` : 'Mid —'}</span>
        <span>{spread != null ? `Spread ${spread}¢` : ''}</span>
      </div>
      {bids.map((l) => (
        <Row key={`b${l.price}`} l={l} kind="bid" max={max} />
      ))}
      {bids.length === 0 && <div className="ob-empty">No bids</div>}
    </div>
  )
}

function Row({ l, kind, max }: { l: Level; kind: 'ask' | 'bid'; max: bigint }) {
  const a = BigInt(l.amount)
  const w = Number((a * 1000n) / max) / 10
  return (
    <div className={`ob-row ${kind}`}>
      <div className="ob-bar" style={{ width: `${w}%` }} />
      <span className="p">{l.price}¢</span>
      <span>{fmtShares(a)}</span>
      <span>{fmtBnb(cost(a, l.price), 3)}</span>
    </div>
  )
}
