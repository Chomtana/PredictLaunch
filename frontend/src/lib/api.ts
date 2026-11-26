// Sequencer API client (SPEC "Sequencer HTTP/WS API"). Amounts are decimal strings in wei; prices
// are cents in Up terms; feed prices are 18-dec decimal strings. Numeric fields the SPEC leaves
// untyped are accepted as number or string (see SPEC-NOTES.md).

import type { Address, Hex } from 'viem'
import type { Msg } from './eip712.ts'

export const API_BASE: string = (import.meta.env?.VITE_API_URL as string | undefined) ?? ''

type Num = number | string

export interface FeedInfo {
  address: Address
  symbol: string
}

export interface Config {
  chainId: number
  rpc: string
  exchange: Address
  factory: Address
  /** OpenFour rail (FourRail): the factory of Four.meme launches. Zero/absent = Flap only. */
  fourRail?: Address
  portal: Address
  saltLockFee: string
  minTarget: string
  cuts: number[]
  feeds: FeedInfo[]
  minDuration: number
  maxDuration: number
  batchMs: number
  /** Exchange collateral: the zero address = native BNB (older sequencers omit it). */
  quoteToken?: Address
  /** Its display symbol, e.g. "BNB" or "USDT". */
  quoteSymbol?: string
  /** Optional: true when POST /api/faucet is enabled (--dev-faucet). */
  faucet?: boolean
  /** True when the sequencer runs with --dev-faucet (anvil fork only); false on a real network. */
  devFaucet?: boolean
  /** Question launches (SPEC "Question launches"): "mock" = simulated oracle, no paid Cournot calls. */
  cournotMode?: 'live' | 'mock'
  /** Seconds a resolver proposal can be challenged before resolve() accepts it. */
  challengeWindow?: Num
  /** Seconds after settleTime with no proposal before resolve() voids the launch. */
  questionDeadline?: Num
}

export const LaunchStatus = { Active: 0, Graduating: 1, Graduated: 2, Failed: 3 } as const
export const OutcomeCode = { Up: 0, Down: 1, Void: 2 } as const

export interface LaunchSummary {
  id: Num
  creator: Address
  rail: Address
  feed: Address
  strike: string
  settleTime: Num
  createdAt: Num
  cutBps: Num
  target: string
  pairs: string
  raised: string
  status: Num
  outcome: Num
  settlePrice: string
  settleUpdatedAt: Num
  snapped: boolean
  resolved: boolean
  token: Address
  totalLoserShares: string
  name: string
  symbol: string
  imageURI: string
  upPrice: number | null
  projectedRaised: string
  progress: Num
  /** "question" for a Cournot question launch (feed = 0). Older sequencers omit it: see `kindOf`. */
  kind?: 'price' | 'question'
  question?: string | null
  marketId?: Num | null
  /** Opening Cournot probability, 0..1. */
  oracleProbability?: number | null
  oracleSource?: OracleSource | null
}

// ------------------------------------------------------------------ Cournot (question launches)

export type OracleSource = 'cournot-live' | 'mock'

/** One market from POST /api/cournot/resolve. `yesPrice` is the live YES price (0..1), not a result. */
export interface CournotMarket {
  matchingConfidence: number
  id: Num
  title: string
  description: string
  /** ISO string or unix seconds (see `toUnixSec`). */
  startTime: Num | null
  endTime: Num | null
  yesPrice: number | null
}

/** SPEC "Oracle record": the normalized Cournot answer the UI shows as-is. */
export interface OracleRecord {
  launchId: Num | null
  /** The exact text sent to Cournot. */
  claim: string
  marketId: Num
  market: Record<string, unknown> | null
  probability: number | null
  result: Record<string, unknown> | null
  basis: Record<string, unknown> | unknown[] | null
  source: OracleSource
  fetchedAt: Num
  error: string | null
  raw: unknown
}

export interface OracleProposal {
  proposed: boolean
  outcome: Num
  proposedAt: Num
  evidenceHash: Hex
  final: boolean
  challengeEndsAt: Num
}

export interface LaunchOracle {
  opening: OracleRecord | null
  prices: { t: number; price: number }[]
  settlement: OracleRecord | null
  proposal: OracleProposal | null
}

/** Unix seconds from an ISO string, unix seconds or unix ms (number or numeric string). NaN if unparseable. */
export function toUnixSec(v: Num | null | undefined): number {
  if (v == null || v === '') return NaN
  const x = typeof v === 'number' ? v : /^\d+(\.\d+)?$/.test(v) ? Number(v) : Date.parse(v) / 1000
  return x > 1e12 ? Math.floor(x / 1000) : x
}

const COURNOT_ERRORS: Record<string, string> = {
  cournot_unavailable: 'The Cournot oracle is unreachable right now. Try again in a moment.',
  payment_required: 'Cournot is unavailable right now (402). Try again later.',
  bad_question: 'Cournot rejected the question: it must be 1–280 bytes and a clear yes/no claim.',
  rate_limited: 'Too many requests: wait a couple of seconds and try again.',
}

/** A friendly line for a failed Cournot call (the API's error codes, or the HTTP status when the body has none). */
export function cournotError(e: unknown): string {
  const code = (e as { code?: string })?.code ?? ''
  if (COURNOT_ERRORS[code]) return COURNOT_ERRORS[code]
  if (code === 'http_402') return COURNOT_ERRORS.payment_required
  if (code === 'http_429') return COURNOT_ERRORS.rate_limited
  if (/^http_5\d\d$/.test(code)) return COURNOT_ERRORS.cournot_unavailable
  if (e instanceof TypeError) return 'The sequencer is unreachable.'
  return (e as Error)?.message ?? String(e)
}

export interface Trade {
  price: number
  amount: string
  side: 'buy' | 'sell'
  ts: number
}

export interface LaunchDetail extends LaunchSummary {
  currentPrice: string | null
  lastTrades?: Trade[]
}

export interface Level {
  price: number
  amount: string
}
export interface Book {
  bids: Level[]
  asks: Level[]
}

export interface PricePoint {
  t: number
  price: string
  /** "atlas-api" (Atlas offchain API, CoinMarketCap-backed) or "onchain" (feed latestRoundData fallback). */
  source?: 'atlas-api' | 'onchain'
}

export interface OrderView {
  orderHash: Hex
  launchId: Num
  outcome: Num
  side: Num
  price: Num
  amount: string
  filled?: string
  remaining?: string
  status?: string
}

export interface Position {
  launchId: Num
  up: string
  down: string
}
export interface UserLaunch {
  launchId: Num
  loserShares: string
  claimableTokens: string
}
export interface UserView {
  address?: string
  balance: string
  locked: string
  pendingWithdrawals: { idx?: Num; amount?: string }[]
  orders: OrderView[]
  positions: Position[]
  launches: UserLaunch[]
  /** Trading keys the sequencer accepts for this owner (onchain or pending). Absent on older sequencers. */
  keys?: { key: string; expiry: Num }[]
}

export interface MsgResult {
  orderHash?: Hex
  fills: { price: number; amount: string; kind: Num }[]
  resting: string
}

export class ApiError extends Error {
  code: string
  index?: number
  constructor(code: string, message: string, index?: number) {
    super(message || code)
    this.code = code
    this.index = index
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(API_BASE + path, init)
  const text = await r.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    /* non-JSON */
  }
  if (!r.ok) {
    const b = body as { error?: string; message?: string; index?: number } | null
    throw new ApiError(b?.error ?? `http_${r.status}`, b?.message ?? (text.slice(0, 160) || r.statusText), b?.index)
  }
  return body as T
}

const post = <T>(path: string, body: unknown) =>
  req<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

export const api = {
  config: () => req<Config>('/api/config'),
  launches: () => req<LaunchSummary[]>('/api/launches'),
  launch: (id: Num) => req<LaunchDetail>(`/api/launch/${id}`),
  book: (id: Num) => req<Book>(`/api/book/${id}`),
  trades: (id: Num, limit = 50) => req<Trade[]>(`/api/trades/${id}?limit=${limit}`),
  prices: (feed: Address, since: number) => req<PricePoint[]>(`/api/prices/${feed}?since=${since}`),
  user: (addr: Address) => req<UserView>(`/api/user/${addr}`),
  msgs: (group: Msg[]) => post<{ results: MsgResult[] }>('/api/msgs', group),
  faucet: (address: Address) => post<unknown>('/api/faucet', { address }),
  /** Free; always a live Cournot call. */
  cournotResolve: (message: string) => post<{ markets: CournotMarket[] }>('/api/cournot/resolve', { message }),
  /** May cost money in live mode (cached by (message, marketId)): only call on an explicit user action. */
  /** `market` = the creator's pick (title + end time): Cournot ids are per-response, so the sequencer re-matches by these. */
  cournotProbability: (message: string, marketId: Num, market?: { title: string; endTime: Num | null }) =>
    post<OracleRecord>('/api/cournot/probability', { message, marketId: Number(marketId), ...(market ? { market } : {}) }),
  oracle: (id: Num) => req<LaunchOracle>(`/api/launch/${id}/oracle`),
}

// ------------------------------------------------------------------ helpers over API shapes

export const n = (v: Num | null | undefined) => (v == null ? 0 : Number(v))
export const big = (v: Num | null | undefined) => (v == null || v === '' ? 0n : BigInt(v))

/** Raised so far, or the projected pool (cut × open pairs) while the market is open. */
export function poolOf(l: Pick<LaunchSummary, 'status' | 'raised' | 'projectedRaised' | 'pairs' | 'cutBps'>): bigint {
  const st = n(l.status)
  if (st === LaunchStatus.Active) {
    if (l.projectedRaised != null) return big(l.projectedRaised)
    return (big(l.pairs) * BigInt(n(l.cutBps))) / 10000n
  }
  return big(l.raised)
}

/** 0..1 progress towards the target. */
export function progressOf(l: Pick<LaunchSummary, 'status' | 'raised' | 'projectedRaised' | 'pairs' | 'cutBps' | 'target'>): number {
  const t = big(l.target)
  if (t === 0n) return 0
  return Math.min(1, Number((poolOf(l) * 10000n) / t) / 10000)
}

// ------------------------------------------------------------------ WebSocket feed

export interface WsSnapshot {
  type: 'snapshot'
  launch?: LaunchDetail
  book?: Book
  trades?: Trade[]
  user?: UserView
}
export interface WsPrice {
  type: 'price'
  feed: Address
  t: number
  price: string
}
export type WsMsg = WsSnapshot | WsPrice

export interface Feed {
  subscribe(sub: { launchId?: number; user?: Address }): void
  close(): void
}

/** Reconnecting WS client. Calls `onMsg` for every message, `onState` on connect/disconnect. */
export function openFeed(onMsg: (m: WsMsg) => void, onState: (up: boolean) => void): Feed {
  let ws: WebSocket | null = null
  let sub: { launchId?: number; user?: Address } = {}
  let closed = false
  let retry: ReturnType<typeof setTimeout> | null = null
  const url = () => {
    if (API_BASE) return API_BASE.replace(/^http/, 'ws') + '/ws'
    const l = window.location
    return `${l.protocol === 'https:' ? 'wss' : 'ws'}://${l.host}/ws`
  }
  const send = () => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ sub }))
  }
  const connect = () => {
    if (closed) return
    try {
      ws = new WebSocket(url())
    } catch {
      retry = setTimeout(connect, 2000)
      return
    }
    ws.onopen = () => {
      onState(true)
      send()
    }
    ws.onmessage = (e) => {
      try {
        onMsg(JSON.parse(String(e.data)) as WsMsg)
      } catch {
        /* ignore */
      }
    }
    ws.onclose = () => {
      onState(false)
      if (!closed) retry = setTimeout(connect, 2000)
    }
    ws.onerror = () => ws?.close()
  }
  connect()
  return {
    subscribe(s) {
      sub = s
      send()
    },
    close() {
      closed = true
      if (retry) clearTimeout(retry)
      ws?.close()
    },
  }
}
