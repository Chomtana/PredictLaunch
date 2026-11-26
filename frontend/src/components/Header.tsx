import { shortAddr } from '../lib/format.ts'
import { fmtBnb, fmtPrice } from '../lib/units.ts'
import { useApp } from '../state.tsx'
import { Logo } from './ui.tsx'

export function Header({ route }: { route: string }) {
  const { config, configError, wsUp, wallet, bnbUsd, quoteSymbol, setAccountOpen, tradingReady, available } = useApp()
  const online = !!config && !configError
  return (
    <header className="header">
      <a className="brand" href="#/">
        <Logo />
        <span>PredictLaunch</span>
      </a>
      <nav className="nav">
        <a className={route === 'home' ? 'on' : ''} href="#/">
          Launches
        </a>
        <a className={route === 'create' ? 'on' : ''} href="#/create">
          Create
        </a>
      </nav>
      <div className="header-right">
        {bnbUsd != null && (
          <span className="pill muted" title="BNB/USD (Atlas oracle)">
            BNB <b className="mono">{fmtPrice(bnbUsd)}</b>
          </span>
        )}
        <span className={`pill status ${online ? (wsUp ? 'ok' : 'warn') : 'bad'}`} title={configError ?? (wsUp ? 'Live' : 'Polling')}>
          <i />
          {online ? (wsUp ? 'Live' : 'Polling') : 'Offline'}
        </span>
        <a className="btn primary sm create-btn" href="#/create">
          + Create launch
        </a>
        {wallet ? (
          <button className="btn account-btn" onClick={() => setAccountOpen(true)}>
            <span className="mono">{available != null ? fmtBnb(available, 3) : '…'} {quoteSymbol}</span>
            <span className="addr">
              {tradingReady && <i className="dot ok" title="Trading enabled" />}
              {shortAddr(wallet.address)}
            </span>
          </button>
        ) : (
          <button className="btn" onClick={() => setAccountOpen(true)}>
            Connect
          </button>
        )}
      </div>
    </header>
  )
}
