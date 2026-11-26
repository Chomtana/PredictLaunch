import type { Hex } from 'viem'
import { n, type OrderView, type Trade } from '../lib/api.ts'
import { clock } from '../lib/format.ts'
import { cost, fmtShares, payout, fmtAmt } from '../lib/units.ts'
import { useQuote } from '../state.tsx'
import { PRICE_LABELS, type OutcomeLabels } from '../lib/labels.ts'

/** The user's position in this launch, their open orders, and recent trades. */
export function Positions({
  position,
  cutBps,
  mid,
  orders,
  trades,
  onCancel,
  labels = PRICE_LABELS,
}: {
  position: { up: bigint; down: bigint } | null
  cutBps: number
  mid: number | null
  orders: OrderView[]
  trades: Trade[]
  onCancel: (h: Hex) => void
  labels?: OutcomeLabels
}) {
  const [U, D] = labels.names
  const { symbol: q } = useQuote()
  const rows = position
    ? ([
        [0, position.up, mid],
        [1, position.down, mid != null ? 100 - mid : null],
      ] as const).filter(([, a]) => a > 0n)
    : []
  return (
    <div className="panel section">
      <h3>Your position</h3>
      {rows.length === 0 ? (
        <div className="muted small">No shares yet.</div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Outcome</th>
              <th className="r">Shares</th>
              <th className="r">Value @ mid</th>
              <th className="r">If it wins</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([o, a, p]) => (
              <tr key={o}>
                <td className={o === 0 ? 'up' : 'down'}>
                  <b>{labels.names[o]}</b>
                </td>
                <td className="r mono">{fmtShares(a)}</td>
                <td className="r mono">{p != null ? `${fmtAmt(cost(a, p), 3)} ${q}` : '—'}</td>
                <td className="r mono up">{fmtAmt(payout(a, cutBps), 3)} {q}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {orders.length > 0 && (
        <>
          <h3 style={{ marginTop: 18 }}>Open orders</h3>
          <table className="table">
            <thead>
              <tr>
                <th>Side</th>
                <th className="r">Price</th>
                <th className="r">Remaining</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.orderHash}>
                  <td className={n(o.outcome) === 0 ? 'up' : 'down'}>
                    {n(o.side) === 0 ? 'Buy' : 'Sell'} {n(o.outcome) === 0 ? U : D}
                  </td>
                  <td className="r mono">{n(o.price)}¢</td>
                  <td className="r mono">{fmtShares(o.remaining ?? o.amount)}</td>
                  <td className="r">
                    <button className="btn sm ghost" onClick={() => onCancel(o.orderHash)}>
                      Cancel
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <h3 style={{ marginTop: 18 }}>Recent trades</h3>
      {trades.length === 0 ? (
        <div className="muted small">No trades yet.</div>
      ) : (
        <div className="trades-list">
          <table className="table">
            <tbody>
              {trades.slice(0, 30).map((t, i) => (
                <tr key={i}>
                  <td className={t.side === 'buy' ? 'up' : 'down'}>{t.side === 'buy' ? U : D}</td>
                  <td className="r mono">{t.side === 'buy' ? t.price : 100 - t.price}¢</td>
                  <td className="r mono">{fmtShares(t.amount)}</td>
                  <td className="r muted small">{clock(t.ts > 1e12 ? t.ts : t.ts * 1000)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
