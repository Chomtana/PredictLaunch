// Browser trading key (SPEC "Trading keys"): generated here, authorized ONCE by the main wallet
// with an AuthorizeKey signature, then signs every order / cancel silently.
//
// Stored in localStorage per (chain, Exchange, owner). It can only place / cancel orders and revoke
// itself: withdrawals stay on-chain from the main wallet, so a leaked key cannot move funds out.

import type { Address, Hex, LocalAccount } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

export interface StoredKey {
  privateKey: Hex
  address: Address
  /** unix seconds */
  expiry: number
  createdMs: number
}

export const DEFAULT_KEY_TTL = 7 * 24 * 3600

const storageKey = (chainId: number, exchange: Address, owner: Address) =>
  `bilauncher:tradingKey:${chainId}:${exchange.toLowerCase()}:${owner.toLowerCase()}`

function store(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function loadKey(chainId: number, exchange: Address, owner: Address): StoredKey | null {
  try {
    const raw = store()?.getItem(storageKey(chainId, exchange, owner))
    if (!raw) return null
    const k = JSON.parse(raw) as StoredKey
    return /^0x[0-9a-fA-F]{64}$/.test(k.privateKey) ? k : null
  } catch {
    return null
  }
}

export function saveKey(chainId: number, exchange: Address, owner: Address, k: StoredKey) {
  try {
    store()?.setItem(storageKey(chainId, exchange, owner), JSON.stringify(k))
  } catch {
    /* private mode: the key lives for this tab only */
  }
}

export function clearKey(chainId: number, exchange: Address, owner: Address) {
  try {
    store()?.removeItem(storageKey(chainId, exchange, owner))
  } catch {
    /* ignore */
  }
}

export function newKey(ttlSeconds = DEFAULT_KEY_TTL): StoredKey {
  const privateKey = generatePrivateKey()
  return {
    privateKey,
    address: privateKeyToAccount(privateKey).address,
    expiry: Math.floor(Date.now() / 1000) + ttlSeconds,
    createdMs: Date.now(),
  }
}

export const accountOf = (k: StoredKey): LocalAccount => privateKeyToAccount(k.privateKey)
