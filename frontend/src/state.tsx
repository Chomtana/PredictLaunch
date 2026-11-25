// App state: sequencer config + launches, live feed prices, wallet, trading key, user data and
// every user action. The app renders without the sequencer (config stays null and it retries).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Address, Hex, PublicClient } from 'viem'
import { api, ApiError, big, openFeed, type Book, type Config, type Feed, type LaunchDetail, type LaunchSummary, type Trade, type UserView, type WsMsg } from './lib/api.ts'
import * as chainLib from './lib/chain.ts'
import { chainFor, errMsg, publicClientFor, type LaunchConfig } from './lib/chain.ts'
import { authorizeKeyMsg, randomNonce, signAuthorizeKey, signCancel, signOrder, type Domain, type Msg, type TypedSigner } from './lib/eip712.ts'
import { mineSalt, predictToken, randomSeed } from './lib/salt.ts'
import { accountOf, clearKey, loadKey, newKey, saveKey, type StoredKey } from './lib/tradingKey.ts'
import { connectDev, connectInjected, discoverInjected, type InjectedInfo, type Wallet } from './lib/wallet.ts'

export type KeyState = 'none' | 'active' | 'expired'

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error' | 'pending'
  title: string
  body?: string
}

export interface PricePt {
  t: number
  price: bigint
}

export interface OrderParams {
  launchId: number
  outcome: 0 | 1
  side: 0 | 1
  /** cents, outcome terms (a market order's slippage cap) */
  price: number
  amount: bigint
  market: boolean
  expiry: bigint
}

export interface LiveLaunch {
  launch?: LaunchDetail
  book?: Book
  trades?: Trade[]
}

const lc = (a: string) => a.toLowerCase()
const MARKET_TTL = 3600n

function useAppState() {
  const [config, setConfig] = useState<Config | null>(null)
  const [configError, setConfigError] = useState<string | null>(null)
  const [launches, setLaunches] = useState<LaunchSummary[] | null>(null)
  const [wsUp, setWsUp] = useState(false)
  const [prices, setPrices] = useState<Record<string, PricePt>>({})
  const [wallet, setWallet] = useState<Wallet | null>(null)
  const [injected, setInjected] = useState<InjectedInfo[]>([])
  const [walletBalance, setWalletBalance] = useState<bigint | null>(null)
  const [user, setUser] = useState<UserView | null>(null)
  const [key, setKey] = useState<StoredKey | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [accountOpen, setAccountOpen] = useState(false)
  const [live, setLive] = useState<LiveLaunch>({})
  const [watchId, setWatchId] = useState<number | null>(null)
  const feed = useRef<Feed | null>(null)
  const toastId = useRef(1)
  const watchRef = useRef<number | null>(null)
  watchRef.current = watchId

  const chain = useMemo(() => (config ? chainFor(config.chainId, config.rpc) : null), [config])
  const publicClient = useMemo<PublicClient | null>(() => (chain ? publicClientFor(chain) : null), [chain])
  const domain = useMemo<Domain | null>(() => (config ? { chainId: config.chainId, exchange: config.exchange } : null), [config])

  // ---------------------------------------------------------------- toasts
  const toast = useCallback((t: Omit<Toast, 'id'>, ttl = 5000) => {
    const id = toastId.current++
    setToasts((ts) => [...ts.slice(-4), { ...t, id }])
    if (ttl > 0) setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), ttl)
    return id
  }, [])
  const updateToast = useCallback((id: number, t: Omit<Toast, 'id'>, ttl = 5000) => {
    setToasts((ts) => ts.map((x) => (x.id === id ? { ...t, id } : x)))
    if (ttl > 0) setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), ttl)
  }, [])
  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((x) => x.id !== id)), [])

  // ---------------------------------------------------------------- config, launches
  useEffect(() => {
    let stop = false
    let t: ReturnType<typeof setTimeout>
    const load = () =>
      api
        .config()
        .then((c) => {
          if (stop) return
          setConfig(c)
          setConfigError(null)
        })
        .catch((e) => {
          if (stop) return
          setConfigError(errMsg(e))
          t = setTimeout(load, 2000)
        })
    load()
    return () => {
      stop = true
      clearTimeout(t)
    }
  }, [])

  const refreshLaunches = useCallback(() => {
    api
      .launches()
      .then(setLaunches)
      .catch(() => setLaunches((l) => l ?? null))
  }, [])
  useEffect(() => {
    if (!config) return
    refreshLaunches()
    const t = setInterval(refreshLaunches, 4000)
    return () => clearInterval(t)
  }, [config, refreshLaunches])

  // ---------------------------------------------------------------- feed prices (REST poll + WS ticks)
  const bnbFeed = useMemo(() => config?.feeds.find((f) => /^W?BNB\//i.test(f.symbol))?.address ?? null, [config])
  const watchedFeeds = useMemo(() => {
    const s = new Set<string>()
    if (bnbFeed) s.add(lc(bnbFeed))
    for (const l of launches ?? []) s.add(lc(l.feed))
    for (const f of config?.feeds ?? []) s.add(lc(f.address))
    return [...s]
  }, [bnbFeed, launches, config])

  const putPrice = useCallback((feedAddr: string, t: number, price: bigint) => {
    setPrices((p) => {
      const k = lc(feedAddr)
      if (p[k] && p[k].t >= t) return p
      return { ...p, [k]: { t, price } }
    })
  }, [])

  useEffect(() => {
    if (!config || watchedFeeds.length === 0) return
    let stop = false
    const poll = () => {
      const since = Math.floor(Date.now() / 1000) - 3600
      for (const f of watchedFeeds) {
        api
          .prices(f as Address, since)
          .then((pts) => {
            if (stop || !pts?.length) return
            const last = pts[pts.length - 1]
            putPrice(f, last.t, big(last.price))
          })
          .catch(() => {})
      }
    }
    poll()
    const t = setInterval(poll, 10_000)
    return () => {
      stop = true
      clearInterval(t)
    }
  }, [config, watchedFeeds, putPrice])

  const priceOf = useCallback((f: Address | string | null | undefined) => (f ? (prices[lc(f)]?.price ?? null) : null), [prices])
  const bnbUsd = priceOf(bnbFeed)
  const feedSymbol = useCallback((f: string) => config?.feeds.find((x) => lc(x.address) === lc(f))?.symbol ?? '', [config])

  // ---------------------------------------------------------------- websocket
  const onWs = useCallback(
    (m: WsMsg) => {
      if (m.type === 'price') {
        putPrice(m.feed, m.t, big(m.price))
        priceListeners.current.forEach((fn) => fn(m.feed, m.t, big(m.price)))
        return
      }
      if (m.user) setUser(m.user)
      if (m.launch || m.book || m.trades) {
        const id = watchRef.current
        if (m.launch && id != null && Number(m.launch.id) !== id) return
        setLive((l) => ({
          launch: m.launch ?? l.launch,
          book: m.book ?? l.book,
          trades: m.trades ?? l.trades,
        }))
      }
    },
    [putPrice],
  )
  const priceListeners = useRef(new Set<(feed: string, t: number, p: bigint) => void>())
  const onPriceTick = useCallback((fn: (feed: string, t: number, p: bigint) => void) => {
    priceListeners.current.add(fn)
    return () => {
      priceListeners.current.delete(fn)
    }
  }, [])

  useEffect(() => {
    if (!config) return
    const f = openFeed(onWs, setWsUp)
    feed.current = f
    return () => f.close()
  }, [config, onWs])

  useEffect(() => {
    feed.current?.subscribe({ launchId: watchId ?? undefined, user: wallet?.address })
  }, [watchId, wallet?.address, config, wsUp])

  const watchLaunch = useCallback((id: number | null) => {
    setWatchId(id)
    setLive({})
  }, [])

  // ---------------------------------------------------------------- wallet
  useEffect(() => discoverInjected(setInjected), [])

  const connect = useCallback(
    async (w: InjectedInfo) => {
      if (!chain) return toast({ kind: 'error', title: 'Sequencer offline', body: 'Chain config unavailable; try again shortly.' })
      try {
        setWallet(await connectInjected(w, chain))
      } catch (e) {
        toast({ kind: 'error', title: 'Wallet connection failed', body: errMsg(e) })
      }
    },
    [chain, toast],
  )
  const connectDevWallet = useCallback(
    (i: number) => {
      if (!chain) return toast({ kind: 'error', title: 'Sequencer offline', body: 'Chain config unavailable; try again shortly.' })
      setWallet(connectDev(i, chain))
    },
    [chain, toast],
  )
  const disconnect = useCallback(() => {
    setWallet(null)
    setUser(null)
    setKey(null)
  }, [])

  // trading key from storage
  useEffect(() => {
    if (!wallet || !config) return setKey(null)
    setKey(loadKey(config.chainId, config.exchange, wallet.address))
  }, [wallet, config])

  const keyState: KeyState = !key ? 'none' : key.expiry * 1000 <= Date.now() ? 'expired' : 'active'

  const refreshUser = useCallback(() => {
    if (!wallet) return
    api
      .user(wallet.address)
      .then(setUser)
      .catch(() => {})
    publicClient
      ?.getBalance({ address: wallet.address })
      .then(setWalletBalance)
      .catch(() => {})
  }, [wallet, publicClient])

  useEffect(() => {
    if (!wallet) return
    refreshUser()
    const t = setInterval(refreshUser, 3000)
    return () => clearInterval(t)
  }, [wallet, refreshUser])

  const ownerSigner = useCallback(
    (w: Wallet): TypedSigner => ({ signTypedData: (a) => w.client.signTypedData({ ...a, account: w.account }) }),
    [],
  )

  const enableTrading = useCallback(async () => {
    if (!wallet || !config || !domain) return
    const k = newKey()
    const a = { owner: wallet.address, key: k.address, expiry: BigInt(k.expiry), nonce: randomNonce() }
    const id = toast({ kind: 'pending', title: 'Enable trading', body: 'Sign once in your wallet: no more popups this session.' }, 0)
    try {
      const sig = await signAuthorizeKey(domain, ownerSigner(wallet), a)
      await api.msgs([authorizeKeyMsg(a, sig)])
      saveKey(config.chainId, config.exchange, wallet.address, k)
      setKey(k)
      updateToast(id, { kind: 'success', title: 'Trading enabled', body: 'Orders are now signed by your browser session key.' })
    } catch (e) {
      updateToast(id, { kind: 'error', title: 'Could not enable trading', body: e instanceof ApiError ? e.message : errMsg(e) })
    }
  }, [wallet, config, domain, toast, updateToast, ownerSigner])

  const forgetKey = useCallback(() => {
    if (!wallet || !config) return
    clearKey(config.chainId, config.exchange, wallet.address)
    setKey(null)
  }, [wallet, config])

  // ---------------------------------------------------------------- onchain txs
  const runTx = useCallback(
    async (title: string, send: () => Promise<Hex>, done?: string) => {
      const id = toast({ kind: 'pending', title, body: 'Confirm in your wallet…' }, 0)
      try {
        const hash = await send()
        updateToast(id, { kind: 'pending', title, body: 'Waiting for confirmation…' }, 0)
        const rc = await publicClient!.waitForTransactionReceipt({ hash })
        if (rc.status !== 'success') throw new Error('Transaction reverted')
        updateToast(id, { kind: 'success', title, body: done ?? 'Confirmed' })
        refreshUser()
        return rc
      } catch (e) {
        updateToast(id, { kind: 'error', title: `${title} failed`, body: errMsg(e) }, 8000)
        return null
      }
    },
    [toast, updateToast, publicClient, refreshUser],
  )

  const deposit = useCallback(
    (amount: bigint) => wallet && config && runTx('Deposit', () => chainLib.deposit(wallet.client, wallet.account, config.exchange, amount), 'Balance credited'),
    [wallet, config, runTx],
  )
  const withdraw = useCallback(
    (amount: bigint) =>
      wallet && config && runTx('Withdraw', () => chainLib.requestWithdraw(wallet.client, wallet.account, config.exchange, amount), 'Requested: paid in the next batch'),
    [wallet, config, runTx],
  )
  const claimTokens = useCallback(
    (launchId: number) =>
      wallet && config && runTx('Claim tokens', () => chainLib.claimTokens(wallet.client, wallet.account, config.exchange, BigInt(launchId)), 'Tokens sent to your wallet'),
    [wallet, config, runTx],
  )

  const faucet = useCallback(async () => {
    if (!wallet) return
    try {
      await api.faucet(wallet.address)
      toast({ kind: 'success', title: 'Faucet', body: '1,000 test BNB sent to your wallet' })
      refreshUser()
    } catch (e) {
      toast({ kind: 'error', title: 'Faucet unavailable', body: e instanceof ApiError ? e.message : errMsg(e) })
    }
  }, [wallet, toast, refreshUser])

  /** Mines a salt, then Portal.newLauncher{value: saltLockFee}(factory, abi.encode(cfg)). */
  const createLaunch = useCallback(
    async (cfg: Omit<LaunchConfig, 'salt'>, onStage?: (s: string) => void): Promise<boolean> => {
      if (!wallet || !config) return false
      onStage?.('Mining a …7777 token address')
      let salt: Hex
      try {
        salt = await mineSalt(randomSeed())
      } catch (e) {
        toast({ kind: 'error', title: 'Salt mining failed', body: errMsg(e) })
        return false
      }
      onStage?.(`Token ${predictToken(salt).slice(0, 8)}…7777 · confirm in wallet`)
      const fee = BigInt(config.saltLockFee)
      const rc = await runTx(
        'Create launch',
        () => chainLib.createLaunch(wallet.client, wallet.account, { portal: config.portal, factory: config.factory, saltLockFee: fee }, { ...cfg, salt }),
        'Launch created: trading opens once the sequencer indexes it',
      )
      refreshLaunches()
      return !!rc
    },
    [wallet, config, runTx, toast, refreshLaunches],
  )

  // ---------------------------------------------------------------- orders (signed by the session key)
  const placeOrder = useCallback(
    async (p: OrderParams) => {
      if (!wallet || !domain || !key) {
        toast({ kind: 'error', title: 'Enable trading first' })
        return null
      }
      const signer = accountOf(key)
      const order = {
        owner: wallet.address as Address,
        launchId: BigInt(p.launchId),
        round: 0,
        outcome: p.outcome,
        side: p.side,
        price: p.price,
        amount: p.amount,
        expiry: p.market ? BigInt(Math.floor(Date.now() / 1000)) + MARKET_TTL : p.expiry,
        nonce: randomNonce(),
      }
      try {
        const { orderHash, msg } = await signOrder(domain, signer, order)
        const group: Msg[] = [msg]
        if (p.market) group.push(await signCancel(domain, signer, { owner: wallet.address, orderHash, nonce: randomNonce() }, true))
        const res = await api.msgs(group)
        refreshUser()
        return res.results[0]
      } catch (e) {
        toast({ kind: 'error', title: 'Order rejected', body: e instanceof ApiError ? `${e.code}: ${e.message}` : errMsg(e) }, 7000)
        return null
      }
    },
    [wallet, domain, key, toast, refreshUser],
  )

  const cancelOrder = useCallback(
    async (orderHash: Hex) => {
      if (!wallet || !domain || !key) return
      try {
        await api.msgs([await signCancel(domain, accountOf(key), { owner: wallet.address, orderHash, nonce: randomNonce() })])
        refreshUser()
      } catch (e) {
        toast({ kind: 'error', title: 'Cancel failed', body: e instanceof ApiError ? e.message : errMsg(e) })
      }
    },
    [wallet, domain, key, toast, refreshUser],
  )

  return {
    config,
    configError,
    launches,
    refreshLaunches,
    wsUp,
    prices,
    priceOf,
    bnbUsd,
    bnbFeed,
    feedSymbol,
    onPriceTick,
    live,
    watchLaunch,
    setLive,
    chain,
    publicClient,
    domain,
    wallet,
    injected,
    connect,
    connectDevWallet,
    disconnect,
    walletBalance,
    user,
    refreshUser,
    key,
    keyState,
    enableTrading,
    forgetKey,
    deposit,
    withdraw,
    claimTokens,
    faucet,
    createLaunch,
    placeOrder,
    cancelOrder,
    toasts,
    toast,
    dismiss,
    accountOpen,
    setAccountOpen,
  }
}

export type AppState = ReturnType<typeof useAppState>
const Ctx = createContext<AppState | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  const s = useAppState()
  return <Ctx.Provider value={s}>{children}</Ctx.Provider>
}

export function useApp(): AppState {
  const s = useContext(Ctx)
  if (!s) throw new Error('useApp outside AppProvider')
  return s
}
