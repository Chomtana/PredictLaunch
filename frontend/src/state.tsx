// App state: sequencer config + launches, live feed prices, wallet, trading key, user data and
// every user action. The app renders without the sequencer (config stays null and it retries).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Address, Hex, PublicClient } from 'viem'
import { api, ApiError, big, n, openFeed, type Book, type Config, type Feed, type LaunchDetail, type LaunchSummary, type Trade, type UserView, type WsMsg } from './lib/api.ts'
import * as chainLib from './lib/chain.ts'
import { chainFor, errMsg, publicClientFor, type LaunchConfig } from './lib/chain.ts'
import { authorizeKeyMsg, randomNonce, signAuthorizeKey, signCancel, signOrder, type Domain, type Msg, type TypedSigner } from './lib/eip712.ts'
import { binancePair, streamTrades } from './lib/binance.ts'
import { kindOf } from './lib/labels.ts'
import { mineSalt, predictToken, randomSeed } from './lib/salt.ts'
import { fourEnabled, type Venue } from './lib/venue.ts'
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
  /** ERC20 quote: the Exchange's allowance on the wallet (null = unknown or native). */
  const [allowance, setAllowance] = useState<bigint | null>(null)
  /** Internal Exchange balance (deposits made before approve-only trading; withdrawable). */
  const [exchangeBalance, setExchangeBalance] = useState<bigint | null>(null)
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
    for (const l of launches ?? []) if (kindOf(l) === 'price') s.add(lc(l.feed))
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

  // ---------------------------------------------------------------- Binance live prices (display only)
  // Feeds with a Binance pair show Binance trades as the "now" price and chart line; settlement still
  // uses the oracle (`oraclePriceOf`). Keyed by feed address like `prices`.
  const [livePrices, setLivePrices] = useState<Record<string, PricePt>>({})
  const liveListeners = useRef(new Set<(feed: string, t: number, p: bigint) => void>())
  const feedPairs = useMemo(() => {
    const m = new Map<string, string[]>() // pair → feed addresses
    for (const f of config?.feeds ?? []) {
      const pair = binancePair(f.symbol)
      if (pair) m.set(pair, [...(m.get(pair) ?? []), lc(f.address)])
    }
    return m
  }, [config])
  useEffect(() => {
    if (feedPairs.size === 0) return
    return streamTrades([...feedPairs.keys()], ({ pair, t, price }) => {
      const feeds = feedPairs.get(pair) ?? []
      setLivePrices((p) => {
        const n = { ...p }
        for (const f of feeds) n[f] = { t, price }
        return n
      })
      for (const f of feeds) liveListeners.current.forEach((fn) => fn(f, t, price))
    })
  }, [feedPairs])
  const onLiveTick = useCallback((fn: (feed: string, t: number, p: bigint) => void) => {
    liveListeners.current.add(fn)
    return () => {
      liveListeners.current.delete(fn)
    }
  }, [])
  /** Binance pair for a feed, or null when it has none (the chart then uses the oracle). */
  const livePairOf = useCallback((f: string) => binancePair(config?.feeds.find((x) => lc(x.address) === lc(f))?.symbol), [config])

  const oraclePriceOf = useCallback((f: Address | string | null | undefined) => (f ? (prices[lc(f)]?.price ?? null) : null), [prices])
  /** Display price: Binance when streaming (fresher than 15 s), else the oracle. */
  const priceOf = useCallback(
    (f: Address | string | null | undefined) => {
      if (!f) return null
      const lp = livePrices[lc(f)]
      if (lp && Date.now() / 1000 - lp.t < 15) return lp.price
      return oraclePriceOf(f)
    },
    [livePrices, oraclePriceOf],
  )
  const bnbUsd = priceOf(bnbFeed)
  // The Exchange's collateral: native BNB (priced by the BNB feed) or a USD token (priced at 1).
  const quoteToken = (config?.quoteToken ?? chainLib.NATIVE) as Address
  const quoteNative = chainLib.isNative(quoteToken)
  const quoteSymbol = config?.quoteSymbol ?? 'BNB'
  const quoteUsd = quoteNative ? bnbUsd : 10n ** 18n
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
  // ERC20 quote: trading also needs the one-time approve (batches pull straight from the wallet).
  const needsApproval = !quoteNative && allowance != null && allowance < chainLib.APPROVED_MIN
  const tradingReady = keyState === 'active' && !needsApproval
  // What the user can spend, net of open orders. ERC20 quote before the approve: the sequencer can't pull anything
  // yet, so show the wallet (+ any old exchange balance) instead of 0.
  const locked = user ? BigInt(user.locked) : 0n
  const available: bigint | null =
    !quoteNative && (allowance == null || allowance < chainLib.APPROVED_MIN)
      ? walletBalance != null
        ? walletBalance + (exchangeBalance ?? 0n) - locked
        : null
      : user
        ? BigInt(user.balance) - locked
        : null

  const refreshUser = useCallback(() => {
    if (!wallet) return
    api
      .user(wallet.address)
      .then(setUser)
      .catch(() => {})
    if (publicClient) {
      chainLib
        .quoteBalance(publicClient, quoteToken, wallet.address)
        .then(setWalletBalance)
        .catch(() => {})
      if (config) {
        chainLib
          .quoteAllowance(publicClient, quoteToken, wallet.address, config.exchange)
          .then(setAllowance)
          .catch(() => {})
        publicClient
          .readContract({ address: config.exchange, abi: chainLib.exchangeAbi, functionName: 'balanceOf', args: [wallet.address] })
          .then(setExchangeBalance)
          .catch(() => {})
      }
    }
  }, [wallet, publicClient, quoteToken, config])

  useEffect(() => {
    if (!wallet) return
    refreshUser()
    const t = setInterval(refreshUser, 3000)
    return () => clearInterval(t)
  }, [wallet, refreshUser])

  // Drop a stored trading key the sequencer doesn't know. A dev-fork restart redeploys the Exchange at the
  // same address with a fresh sequencer, so the saved key would still look "enabled" while every order
  // fails with bad_signature. A key enabled in the last 10 s is spared: a user view fetched before its
  // AuthorizeKey landed would not list it yet.
  useEffect(() => {
    if (!wallet || !config || !key || !user?.keys) return
    if (user.address && lc(user.address) !== lc(wallet.address)) return
    if (Date.now() - key.createdMs < 10_000) return
    if (user.keys.some((k) => lc(k.key) === lc(key.address) && n(k.expiry) * 1000 > Date.now())) return
    clearKey(config.chainId, config.exchange, wallet.address)
    setKey(null)
  }, [user, key, wallet, config])

  const ownerSigner = useCallback(
    (w: Wallet): TypedSigner => ({ signTypedData: (a) => w.client.signTypedData({ ...a, account: w.account }) }),
    [],
  )

  const enableTrading = useCallback(async () => {
    if (!wallet || !config || !domain) return
    if (!quoteNative && publicClient) {
      const id = toast({ kind: 'pending', title: `Approve ${quoteSymbol}`, body: 'One-time approval: trades are paid straight from your wallet.' }, 0)
      try {
        const sent = await chainLib.approveTrading(wallet.client, publicClient, wallet.account, config.exchange, quoteToken)
        setAllowance(2n ** 256n - 1n)
        if (sent) updateToast(id, { kind: 'success', title: `${quoteSymbol} approved`, body: 'No deposit needed: trades use your wallet balance.' })
        else dismiss(id)
      } catch (e) {
        updateToast(id, { kind: 'error', title: 'Approval failed', body: errMsg(e) }, 8000)
        return
      }
      // Already have a live session key: the approval was all that was missing.
      if (key && key.expiry * 1000 > Date.now()) return
    }
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
  }, [wallet, config, domain, toast, updateToast, dismiss, ownerSigner, quoteNative, publicClient, quoteSymbol, quoteToken, key])

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
    (amount: bigint) =>
      wallet && config && publicClient && runTx('Deposit', () => chainLib.deposit(wallet.client, publicClient, wallet.account, config.exchange, quoteToken, amount), 'Balance credited'),
    [wallet, config, publicClient, quoteToken, runTx],
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
      const body = quoteNative ? '1,000 test BNB sent to your wallet' : `10,000 test ${quoteSymbol} and 1,000 BNB for gas sent to your wallet`
      toast({ kind: 'success', title: 'Faucet', body })
      refreshUser()
    } catch (e) {
      toast({ kind: 'error', title: 'Faucet unavailable', body: e instanceof ApiError ? e.message : errMsg(e) })
    }
  }, [wallet, toast, refreshUser, quoteNative, quoteSymbol])

  /** Flap: mines a salt, then Portal.newLauncher{value: saltLockFee}(factory, abi.encode(cfg)).
   *  Four: FourRail.createLaunch(cfg) (no salt, no fee). */
  const createLaunch = useCallback(
    /** `draft` may be a function: it is called once the salt is mined, right before the wallet prompt, so a
     *  short settlement ("1 min") is measured from then, not from the click. */
    async (draft: Omit<LaunchConfig, 'salt'> | (() => Omit<LaunchConfig, 'salt'>), onStage?: (s: string) => void, venue: Venue = 'flap'): Promise<boolean> => {
      if (!wallet || !config) return false
      if (venue === 'four' && fourEnabled(config)) {
        onStage?.('Confirm in wallet · Four.meme launch')
        const cfg = typeof draft === 'function' ? draft() : draft
        const rc = await runTx(
          'Create launch',
          () => chainLib.createFourLaunch(wallet.client, wallet.account, config.fourRail!, { ...cfg, salt: chainLib.ZERO_SALT }),
          'Launch created: trading opens once the sequencer indexes it',
        )
        refreshLaunches()
        return !!rc
      }
      onStage?.('Mining a …7777 token address')
      let salt: Hex
      try {
        salt = await mineSalt(randomSeed())
      } catch (e) {
        toast({ kind: 'error', title: 'Salt mining failed', body: errMsg(e) })
        return false
      }
      onStage?.(`Token ${predictToken(salt).slice(0, 8)}…7777 · confirm in wallet`)
      const cfg = typeof draft === 'function' ? draft() : draft
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
  // A stored key the sequencer doesn't recognize (e.g. a dev fork restarted: same Exchange address, fresh
  // sequencer state) fails every message with bad_signature. Drop it so "Enable trading" re-authorizes.
  const staleKey = useCallback(
    (e: unknown) => {
      if (!(e instanceof ApiError) || e.code !== 'bad_signature' || !wallet || !config) return false
      clearKey(config.chainId, config.exchange, wallet.address)
      setKey(null)
      toast({ kind: 'error', title: 'Trading key not recognized', body: 'The sequencer no longer knows this trading key. Enable trading again, then retry.' }, 8000)
      return true
    },
    [wallet, config, toast],
  )
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
        if (!staleKey(e)) toast({ kind: 'error', title: 'Order rejected', body: e instanceof ApiError ? `${e.code}: ${e.message}` : errMsg(e) }, 7000)
        return null
      }
    },
    [wallet, domain, key, toast, refreshUser, staleKey],
  )

  const cancelOrder = useCallback(
    async (orderHash: Hex) => {
      if (!wallet || !domain || !key) return
      try {
        await api.msgs([await signCancel(domain, accountOf(key), { owner: wallet.address, orderHash, nonce: randomNonce() })])
        refreshUser()
      } catch (e) {
        if (!staleKey(e)) toast({ kind: 'error', title: 'Cancel failed', body: e instanceof ApiError ? e.message : errMsg(e) })
      }
    },
    [wallet, domain, key, toast, refreshUser, staleKey],
  )

  return {
    config,
    configError,
    launches,
    refreshLaunches,
    wsUp,
    prices,
    priceOf,
    oraclePriceOf,
    livePairOf,
    onLiveTick,
    bnbUsd,
    bnbFeed,
    quoteToken,
    quoteSymbol,
    quoteUsd,
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
    needsApproval,
    tradingReady,
    available,
    exchangeBalance,
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

/** The quote token's symbol and USD price; works outside AppProvider (component tests): BNB, unpriced. */
export function useQuote(): { symbol: string; usd: bigint | null } {
  const s = useContext(Ctx)
  return { symbol: s?.quoteSymbol ?? 'BNB', usd: s?.quoteUsd ?? null }
}

export function useApp(): AppState {
  const s = useContext(Ctx)
  if (!s) throw new Error('useApp outside AppProvider')
  return s
}
