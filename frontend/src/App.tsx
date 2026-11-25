import { useEffect, useState } from 'react'
import { AccountDrawer } from './components/Account.tsx'
import { CreateLaunch } from './components/CreateLaunch.tsx'
import { Header } from './components/Header.tsx'
import { Home } from './components/Home.tsx'
import { LaunchPage } from './components/LaunchPage.tsx'
import { Toasts } from './components/ui.tsx'
import { useApp } from './state.tsx'

export type Route = { name: 'home' } | { name: 'create' } | { name: 'launch'; id: number }

export function parseHash(h: string): Route {
  const p = h.replace(/^#\/?/, '').split('/')
  if (p[0] === 'create') return { name: 'create' }
  if (p[0] === 'launch' && /^\d+$/.test(p[1] ?? '')) return { name: 'launch', id: Number(p[1]) }
  return { name: 'home' }
}

function useRoute(): Route {
  const [r, setR] = useState(() => parseHash(window.location.hash))
  useEffect(() => {
    const on = () => {
      setR(parseHash(window.location.hash))
      window.scrollTo(0, 0)
    }
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return r
}

export function App() {
  const route = useRoute()
  const { configError, config } = useApp()
  return (
    <div className="app">
      <Header route={route.name} />
      {configError && !config && (
        <div className="banner warn top">
          Can't reach the bilauncher sequencer ({configError}). Showing what we can; retrying every 2 s.
        </div>
      )}
      <main>
        {route.name === 'home' && <Home />}
        {route.name === 'create' && <CreateLaunch />}
        {route.name === 'launch' && <LaunchPage id={route.id} />}
      </main>
      <footer className="footer">
        <span>bilauncher · BSC testnet{config && /127\.0\.0\.1|localhost/.test(config.rpc) ? ' (local fork)' : ''}</span>
        <span className="muted">
          Launches via Flap Portal · prices by Atlas oracle{config ? ` · Exchange ${config.exchange.slice(0, 8)}…` : ''}
        </span>
      </footer>
      <AccountDrawer />
      <Toasts />
    </div>
  )
}
