import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { shortAddr } from '../lib/format.ts'
import { fmtBnb, parseBnb, usd } from '../lib/units.ts'
import { isNative } from '../lib/chain.ts'
import { DEV_ACCOUNTS } from '../lib/wallet.ts'
import { useApp } from '../state.tsx'
import { labelsFor } from '../lib/labels.ts'

/** Account drawer: wallet, trading balance, faucet, trading key. ERC20 quote: approve-only (no deposit/withdraw);
 *  native quote: deposit/withdraw. */
export function AccountDrawer() {
  const s = useApp()
  const { accountOpen, setAccountOpen } = s
  useEffect(() => {
    if (!accountOpen) return
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setAccountOpen(false)
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [accountOpen, setAccountOpen])
  if (!accountOpen) return null
  return createPortal(
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setAccountOpen(false)}>
      <aside className="drawer" role="dialog" aria-label="Account">
        <div className="drawer-head">
          <h3>Account</h3>
          <button className="icon-btn" aria-label="Close" onClick={() => setAccountOpen(false)}>
            ✕
          </button>
        </div>
        {s.wallet ? <Connected /> : <ConnectList />}
      </aside>
    </div>,
    document.body,
  )
}

function ConnectList() {
  const { injected, connect, connectDevWallet, config } = useApp()
  const local = !!config && /127\.0\.0\.1|localhost/.test(config.rpc)
  return (
    <div className="drawer-body">
      <p className="muted">Connect a wallet on BSC testnet{local ? ' (local fork)' : ''}.</p>
      {injected.length === 0 && <div className="muted small">No browser wallet found.</div>}
      {injected.map((w) => (
        <button key={w.id} className="btn wide wallet-opt" onClick={() => connect(w)}>
          {w.icon && <img src={w.icon} alt="" width={20} height={20} />}
          {w.name}
        </button>
      ))}
      {local && (
        <>
          <div className="section-label">Dev wallets (local fork only)</div>
          <div className="dev-grid">
            {DEV_ACCOUNTS.map((a, i) => (
              <button key={a.name} className="btn" onClick={() => connectDevWallet(i)}>
                {a.name}
              </button>
            ))}
          </div>
          <div className="muted small">Public anvil keys. Never send real funds to them.</div>
        </>
      )}
      {!config && <div className="banner warn">The sequencer is offline. Connecting needs its chain config; retrying…</div>}
    </div>
  )
}

function Connected() {
  const { wallet, user, walletBalance, quoteSymbol: q, quoteUsd, quoteToken, deposit, withdraw, faucet, keyState, tradingReady, needsApproval, exchangeBalance, available, enableTrading, forgetKey, disconnect, launches } = useApp()
  const native = isNative(quoteToken)
  const [tab, setTab] = useState<'deposit' | 'withdraw'>('deposit')
  const [amt, setAmt] = useState('')
  const [busy, setBusy] = useState(false)
  if (!wallet) return null
  const v = parseBnb(amt)
  const bal = user ? BigInt(user.balance) : null
  const locked = user ? BigInt(user.locked) : 0n
  const free = bal != null ? bal - locked : null
  const max = tab === 'deposit' ? walletBalance : free
  const ok = v != null && v > 0n && (max == null || v <= max)
  const go = async () => {
    if (!v) return
    setBusy(true)
    try {
      await (tab === 'deposit' ? deposit(v) : withdraw(v))
      setAmt('')
    } finally {
      setBusy(false)
    }
  }
  const nameOf = (id: string | number) => launches?.find((l) => String(l.id) === String(id))

  return (
    <div className="drawer-body">
      <div className="acct-id">
        <div>
          <div className="muted small">{wallet.label}</div>
          <div className="mono">{shortAddr(wallet.address)}</div>
        </div>
        <button className="btn sm ghost" onClick={disconnect}>
          Disconnect
        </button>
      </div>

      {!native ? (
        <>
          <div className="bal-card">
            <div className="muted small">Available</div>
            <div className="bal-big mono">{available != null ? fmtBnb(available, 4) : '…'} {q}</div>
            <div className="muted small">
              {available != null && usd(available, quoteUsd)} {locked > 0n && <>· {fmtBnb(locked, 4)} in open orders</>}
            </div>
          </div>
          {exchangeBalance != null && exchangeBalance > 0n && (
            <div className="key-row">
              <span className="small">
                {fmtBnb(exchangeBalance, 4)} {q} left on the exchange from earlier deposits
              </span>
              <button className="btn sm ghost" disabled={busy} onClick={() => { setBusy(true); Promise.resolve(withdraw(exchangeBalance)).finally(() => setBusy(false)) }}>
                Withdraw
              </button>
            </div>
          )}
        </>
      ) : (
      <>
      <div className="bal-card">
        <div className="muted small">Trading balance</div>
        <div className="bal-big mono">{bal != null ? fmtBnb(bal, 4) : '…'} {q}</div>
        <div className="muted small">
          {bal != null && usd(bal, quoteUsd)} {locked > 0n && <>· {fmtBnb(locked, 4)} in open orders</>}
        </div>
        <div className="muted small">Wallet: {walletBalance != null ? fmtBnb(walletBalance, 4) : '…'} {q}</div>
      </div>

      <div className="seg full">
        <button className={tab === 'deposit' ? 'on' : ''} onClick={() => setTab('deposit')}>
          Deposit
        </button>
        <button className={tab === 'withdraw' ? 'on' : ''} onClick={() => setTab('withdraw')}>
          Withdraw
        </button>
      </div>
      <div className="amount-row">
        <input aria-label={`Amount (${q})`} inputMode="decimal" placeholder="0.0" value={amt} onChange={(e) => setAmt(e.target.value)} />
        <span className="unit">{q}</span>
        {max != null && max > 0n && (
          <button className="chip" onClick={() => setAmt(fmtBnb(native && tab === 'deposit' && max > 10n ** 16n ? max - 10n ** 16n : max, 4).replace(/,/g, ''))}>
            Max
          </button>
        )}
      </div>
      <button className="btn primary wide" disabled={!ok || busy} onClick={go}>
        {tab === 'deposit' ? `Deposit ${q}` : 'Request withdrawal'}
      </button>
      {tab === 'withdraw' && <div className="muted small">Paid in the next batch (a few seconds). Resting orders are cancelled if needed.</div>}
      {user && user.pendingWithdrawals.length > 0 && (
        <div className="muted small">
          {user.pendingWithdrawals.length} withdrawal{user.pendingWithdrawals.length > 1 ? 's' : ''} pending
        </div>
      )}
      </>
      )}
      <button className="btn ghost wide" onClick={faucet}>
        {native ? 'Get 1,000 test BNB (faucet)' : `Get 10,000 test ${q} (faucet)`}
      </button>

      <div className="section-label">Trading session</div>
      {tradingReady ? (
        <div className="key-row">
          <span>
            <i className="dot ok" /> Trading enabled · no wallet popups
          </span>
          <button className="btn sm ghost" onClick={forgetKey}>
            Forget
          </button>
        </div>
      ) : (
        <>
          <div className="muted small">
            {native
              ? 'Sign once to create a browser session key. It can place and cancel orders only; it can never withdraw.'
              : `Approve ${q} once, then sign once to create a browser session key. The key can place and cancel orders only; it can never move your funds.`}
          </div>
          <button className="btn primary wide" onClick={enableTrading}>
            {keyState === 'expired' && !needsApproval ? 'Renew trading session' : 'Enable trading'}
          </button>
        </>
      )}

      {user && user.positions.length > 0 && (
        <>
          <div className="section-label">Positions</div>
          <div className="mini-list">
            {user.positions.map((p) => {
              const l = nameOf(p.launchId)
              const [U, D] = labelsFor(l).names
              return (
                <a key={String(p.launchId)} href={`#/launch/${p.launchId}`} className="mini-row">
                  <span>{l ? `$${l.symbol}` : `#${p.launchId}`}</span>
                  <span className="mono">
                    {BigInt(p.up) > 0n && <span className="up">{fmtBnb(p.up, 2)} {U} </span>}
                    {BigInt(p.down) > 0n && <span className="down">{fmtBnb(p.down, 2)} {D}</span>}
                  </span>
                </a>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
