// Salt mining for Flap launches. The Portal deploys each token as an EIP-1167 clone of TOKEN_IMPL
// with CREATE2(salt), and only accepts salts whose token address ends in 0x7777. Candidates are
// keccak256(seed, i) (the same scheme as contracts/reference/flap/ForkBase.sol). ~65k tries on average,
// so the browser runs it in a Web Worker.

import { concat, getAddress, hexToBytes, keccak256, toHex, type Address, type Hex } from 'viem'

export const PORTAL: Address = '0x000042108465206185A077Edc3F3fd2b49060000'
export const TOKEN_IMPL: Address = '0x7777c57ff7dc441c1715b2e36fa581c48B782222'

const CLONE_CODE = concat(['0x3d602d80600a3d3981f3363d3d373d3d3d363d73', TOKEN_IMPL, '0x5af43d82803e903d91602b57fd5bf3'])
const CLONE_CODE_HASH = hexToBytes(keccak256(CLONE_CODE))

/** The token address a salt yields: CREATE2(PORTAL, salt, keccak(clone code)). */
export function predictToken(salt: Hex): Address {
  const buf = new Uint8Array(85)
  buf[0] = 0xff
  buf.set(hexToBytes(PORTAL), 1)
  buf.set(hexToBytes(salt), 21)
  buf.set(CLONE_CODE_HASH, 53)
  return getAddress(toHex(keccak256(buf, 'bytes').slice(12)))
}

/** Synchronous search from candidate `start`. Deterministic for a given seed. */
export function mineSaltSync(seed: Hex, start = 0n, maxTries = 5_000_000): Hex {
  const pre = new Uint8Array(85)
  pre[0] = 0xff
  pre.set(hexToBytes(PORTAL), 1)
  pre.set(CLONE_CODE_HASH, 53)
  const cand = new Uint8Array(64)
  cand.set(hexToBytes(seed), 0)
  for (let n = 0; n < maxTries; n++) {
    let i = start + BigInt(n)
    for (let b = 63; b >= 32; b--) {
      cand[b] = Number(i & 0xffn)
      i >>= 8n
    }
    const salt = keccak256(cand, 'bytes')
    pre.set(salt, 21)
    const h = keccak256(pre, 'bytes')
    if (h[30] === 0x77 && h[31] === 0x77) return toHex(salt)
  }
  throw new Error('no salt found')
}

/** Random 32-byte seed. */
export function randomSeed(): Hex {
  const b = new Uint8Array(32)
  crypto.getRandomValues(b)
  return toHex(b)
}

/** Mine in a Web Worker when available (browser), else synchronously (tests, SSR). */
export function mineSalt(seed: Hex): Promise<Hex> {
  if (typeof Worker === 'undefined') return Promise.resolve(mineSaltSync(seed))
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./salt.worker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (e: MessageEvent<{ salt?: Hex; error?: string }>) => {
      w.terminate()
      if (e.data.salt) resolve(e.data.salt)
      else reject(new Error(e.data.error ?? 'salt mining failed'))
    }
    w.onerror = (e) => {
      w.terminate()
      reject(new Error(e.message || 'salt worker failed'))
    }
    w.postMessage({ seed })
  })
}
