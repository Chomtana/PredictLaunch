import { useState } from 'react'
import { fmtBnb, fmtShares, num18, POOL_TOKENS } from '../lib/units.ts'
import { Spinner } from './ui.tsx'

/** Pool opening price in BNB per token: raised / 500M. */
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
  const [copied, setCopied] = useState(false)
  const amount = BigInt(claimable || '0')
  if (graduating) {
    return (
      <div className="panel state-panel graduated">
        <h2>
          <Spinner size={18} /> Launching on Flap…
        </h2>
        <div className="muted">
          The pool hit its target. ${symbol} is being minted through the Flap Portal: {fmtBnb(raised, 3)} BNB and 500M tokens seed the PancakeSwap pool.
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
        The prediction is over. {fmtBnb(raised, 3)} BNB from winners' cut and 500M ${symbol} now form the PancakeSwap pool. Losers share the other 500M.
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
          <span className="v mono">{poolPrice(raised).toExponential(2)} BNB</span>
        </div>
        <div className="stat">
          <span className="k">Pool liquidity</span>
          <span className="v mono">{fmtBnb(raised, 3)} BNB</span>
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
            {fmtBnb(amount, 0)} <span className="muted">${symbol}</span>
          </div>
        </div>
        <button className="btn primary" disabled={amount === 0n} onClick={onClaim}>
          Claim {fmtBnb(amount, 0)} {symbol}
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
