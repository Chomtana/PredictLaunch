import { useState } from 'react'
import { fmtShares, num18, POOL_TOKENS, fmtAmt } from '../lib/units.ts'
import { Spinner } from './ui.tsx'
import { useQuote } from '../state.tsx'

/** Pool opening price in the quote token per token: raised / 500M. */
export const poolPrice = (raised: bigint) => num18(raised) / num18(POOL_TOKENS)

export function GraduatedPanel({
  token,
  symbol,
  raised,
  claimable,
  loserShares,
  onClaim,
  graduating,
}: {
  token: string | null
  symbol: string
  raised: bigint
  /** /api/user launches[].claimableTokens (wei) */
  claimable: string
  loserShares: string
  onClaim: () => void
  graduating?: boolean
}) {
  const { symbol: q } = useQuote()
  const [copied, setCopied] = useState(false)
  const amount = BigInt(claimable || '0')
  if (graduating) {
    return (
      <div className="panel state-panel graduated">
        <h2>
          <Spinner size={18} /> Launching on Flap…
        </h2>
        <div className="muted">
          The pool hit its target. ${symbol} is being minted through the Flap Portal: {fmtAmt(raised, 3)} {q} and 500M tokens seed the PancakeSwap pool.
        </div>
      </div>
    )
  }
  const copy = () => {
    if (!token) return
    void navigator.clipboard?.writeText(token).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      },
      () => {},
    )
  }
  return (
    <div className="panel state-panel graduated">
      <h2>🎓 ${symbol} graduated</h2>
      <div className="muted">
        The prediction is over. {fmtAmt(raised, 3)} {q} from winners' cut and 500M ${symbol} now form the PancakeSwap pool. Losers share the other 500M.
      </div>
      {token && (
        <div className="addr-row">
          <span style={{ flex: 1 }}>{token}</span>
          <button className="btn sm" onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
      <div className="stat-grid">
        <div className="stat">
          <span className="k">Pool price</span>
          <span className="v mono">{poolPrice(raised).toExponential(2)} {q}</span>
        </div>
        <div className="stat">
          <span className="k">Pool liquidity</span>
          <span className="v mono">{fmtAmt(raised, 3)} {q}</span>
        </div>
        <div className="stat">
          <span className="k">Your loser shares</span>
          <span className="v mono">{fmtShares(loserShares || '0')}</span>
        </div>
        <div className="stat">
          <span className="k">Supply</span>
          <span className="v">1B</span>
        </div>
      </div>
      <div className="claim-box">
        <div>
          <div className="muted small">Claimable</div>
          <div className="big mono">
            {fmtAmt(amount, 0)} <span className="muted">${symbol}</span>
          </div>
        </div>
        <button className="btn primary" disabled={amount === 0n} onClick={onClaim}>
          Claim {fmtAmt(amount, 0)} {symbol}
        </button>
      </div>
      {token && (
        <div className="muted small">
          Trade it:{' '}
          <a className="link" href={`https://pancakeswap.finance/swap?chain=bscTestnet&outputCurrency=${token}`} target="_blank" rel="noreferrer">
            PancakeSwap V2 ↗
          </a>{' '}
          ·{' '}
          <a className="link" href={`https://testnet.bscscan.com/token/${token}`} target="_blank" rel="noreferrer">
            BscScan ↗
          </a>{' '}
          (links work for live testnet launches, not the local fork)
        </div>
      )}
    </div>
  )
}
