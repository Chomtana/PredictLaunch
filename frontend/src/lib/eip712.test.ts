// The browser's EIP-712 encoding must give exactly the digests and signatures in the shared
// fixture (written by contracts/test/Vectors.t.sol), so the contract, sequencer and UI agree.
import { describe, expect, it } from 'vitest'
import { keccak256, recoverTypedDataAddress, stringToBytes, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import vectors from '../../../fixtures/eip712-vectors.json' with { type: 'json' }
import {
  authorizeKeyDigest,
  authorizeKeyMsg,
  authorizeKeyTyped,
  cancelDigest,
  orderHash,
  orderFromStrings,
  signAuthorizeKey,
  signCancel,
  signOrder,
  type Domain,
} from './eip712.ts'

const d: Domain = { chainId: Number(vectors.domain.chainId), exchange: vectors.domain.verifyingContract as Address }
const ALICE = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const BOB = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
const KEY = privateKeyToAccount(keccak256(stringToBytes('predictlaunch-key')))
const signers = [ALICE, BOB, KEY]
const signerOf = (a: string) => signers.find((s) => s.address.toLowerCase() === a.toLowerCase())!

describe('EIP-712 matches the shared vectors', () => {
  it('domain and fixture accounts', () => {
    expect(vectors.domain.name).toBe('predictlaunch')
    expect(vectors.domain.version).toBe('1')
    expect(d.chainId).toBe(97)
    expect(KEY.address).toBe(vectors.tradingKey)
  })

  for (const [i, v] of vectors.orders.entries()) {
    it(`order #${i} hash and signature`, async () => {
      const o = orderFromStrings(v.order)
      expect(orderHash(d, o)).toBe(v.hash)
      const signed = await signOrder(d, signerOf(v.signer), o)
      expect(signed.orderHash).toBe(v.hash)
      expect(signed.msg.sig).toBe(v.sig)
      expect(signed.msg.kind).toBe('place')
      expect(signed.msg.order).toEqual(v.order)
    })
  }

  for (const [i, v] of vectors.keys.entries()) {
    it(`authorizeKey #${i}`, async () => {
      const a = { owner: v.auth.owner as Address, key: v.auth.key as Address, expiry: BigInt(v.auth.expiry), nonce: BigInt(v.auth.nonce) }
      expect(authorizeKeyDigest(d, a)).toBe(v.hash)
      const sig = await signAuthorizeKey(d, signerOf(v.signer), a)
      expect(sig).toBe(v.sig)
      expect(await recoverTypedDataAddress({ ...authorizeKeyTyped(d, a), signature: sig })).toBe(ALICE.address)
      expect(authorizeKeyMsg(a, sig)).toEqual({ kind: 'authorizeKey', ...v.auth, sig: v.sig })
    })
  }

  for (const [i, v] of vectors.cancels.entries()) {
    it(`cancel #${i}`, async () => {
      const c = { owner: v.cancel.owner as Address, orderHash: v.cancel.orderHash as Hex, nonce: BigInt(v.cancel.nonce) }
      expect(cancelDigest(d, c)).toBe(v.hash)
      const msg = await signCancel(d, signerOf(v.signer), c)
      expect(msg).toEqual({ kind: 'cancel', ...v.cancel, sig: v.sig })
      const ifResting = await signCancel(d, signerOf(v.signer), c, true)
      expect(ifResting.ifResting).toBe(true)
    })
  }

  it('the round is signed: another round gives another hash', () => {
    const o = orderFromStrings(vectors.orders[0].order)
    expect(orderHash(d, o)).not.toBe(orderHash(d, { ...o, round: o.round + 1 }))
  })
})
