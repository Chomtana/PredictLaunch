// EIP-712 messages exactly as SPEC "EIP-712" defines them. Cross-checked against the shared
// vectors (fixtures/eip712-vectors.json) in eip712.test.ts.

import { hashTypedData, type Address, type Hex } from 'viem'

export interface Domain {
  chainId: number
  exchange: Address
}

export const domainOf = (d: Domain) =>
  ({ name: 'predictlaunch', version: '1', chainId: d.chainId, verifyingContract: d.exchange }) as const

export const ORDER_TYPES = {
  Order: [
    { name: 'owner', type: 'address' },
    { name: 'launchId', type: 'uint256' },
    { name: 'round', type: 'uint32' },
    { name: 'outcome', type: 'uint8' },
    { name: 'side', type: 'uint8' },
    { name: 'price', type: 'uint8' },
    { name: 'amount', type: 'uint128' },
    { name: 'expiry', type: 'uint64' },
    { name: 'nonce', type: 'uint64' },
  ],
} as const

export const AUTHORIZE_KEY_TYPES = {
  AuthorizeKey: [
    { name: 'owner', type: 'address' },
    { name: 'key', type: 'address' },
    { name: 'expiry', type: 'uint64' },
    { name: 'nonce', type: 'uint64' },
  ],
} as const

export const CANCEL_TYPES = {
  Cancel: [
    { name: 'owner', type: 'address' },
    { name: 'orderHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint64' },
  ],
} as const

export interface Order {
  owner: Address
  launchId: bigint
  /** Always 0 (one market per launch; kept in the type for vector stability). */
  round: number
  outcome: 0 | 1
  side: 0 | 1
  price: number
  amount: bigint
  expiry: bigint
  nonce: bigint
}
export interface AuthorizeKey {
  owner: Address
  key: Address
  expiry: bigint
  nonce: bigint
}
export interface Cancel {
  owner: Address
  orderHash: Hex
  nonce: bigint
}

/** Order fields as decimal strings (the API wire format). */
export type OrderStrings = Record<'owner' | 'launchId' | 'round' | 'outcome' | 'side' | 'price' | 'amount' | 'expiry' | 'nonce', string>

export const orderToStrings = (o: Order): OrderStrings => ({
  owner: o.owner,
  launchId: o.launchId.toString(),
  round: String(o.round),
  outcome: String(o.outcome),
  side: String(o.side),
  price: String(o.price),
  amount: o.amount.toString(),
  expiry: o.expiry.toString(),
  nonce: o.nonce.toString(),
})

export const orderFromStrings = (s: OrderStrings): Order => ({
  owner: s.owner as Address,
  launchId: BigInt(s.launchId),
  round: Number(s.round),
  outcome: Number(s.outcome) as 0 | 1,
  side: Number(s.side) as 0 | 1,
  price: Number(s.price),
  amount: BigInt(s.amount),
  expiry: BigInt(s.expiry),
  nonce: BigInt(s.nonce),
})

export const orderTyped = (d: Domain, o: Order) =>
  ({ domain: domainOf(d), types: ORDER_TYPES, primaryType: 'Order', message: o }) as const
export const authorizeKeyTyped = (d: Domain, a: AuthorizeKey) =>
  ({ domain: domainOf(d), types: AUTHORIZE_KEY_TYPES, primaryType: 'AuthorizeKey', message: a }) as const
export const cancelTyped = (d: Domain, c: Cancel) =>
  ({ domain: domainOf(d), types: CANCEL_TYPES, primaryType: 'Cancel', message: c }) as const

export const orderHash = (d: Domain, o: Order): Hex => hashTypedData(orderTyped(d, o))
export const authorizeKeyDigest = (d: Domain, a: AuthorizeKey): Hex => hashTypedData(authorizeKeyTyped(d, a))
export const cancelDigest = (d: Domain, c: Cancel): Hex => hashTypedData(cancelTyped(d, c))

/** Anything that can sign typed data: a viem LocalAccount, or a wrapper around a wallet client. */
export interface TypedSigner {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  signTypedData: (args: any) => Promise<Hex>
}

// ------------------------------------------------------------------ /api/msgs bodies

export interface PlaceMsg {
  kind: 'place'
  order: OrderStrings
  sig: Hex
  ifResting?: boolean
}
export interface CancelMsg {
  kind: 'cancel'
  owner: Address
  orderHash: Hex
  nonce: string
  sig: Hex
  ifResting?: boolean
}
export interface AuthorizeKeyMsg {
  kind: 'authorizeKey'
  owner: Address
  key: Address
  expiry: string
  nonce: string
  sig: Hex
}
export type Msg = PlaceMsg | CancelMsg | AuthorizeKeyMsg

export async function signOrder(d: Domain, signer: TypedSigner, o: Order): Promise<{ orderHash: Hex; msg: PlaceMsg }> {
  const sig = await signer.signTypedData(orderTyped(d, o))
  return { orderHash: orderHash(d, o), msg: { kind: 'place', order: orderToStrings(o), sig } }
}

export async function signCancel(d: Domain, signer: TypedSigner, c: Cancel, ifResting?: boolean): Promise<CancelMsg> {
  const sig = await signer.signTypedData(cancelTyped(d, c))
  const msg: CancelMsg = { kind: 'cancel', owner: c.owner, orderHash: c.orderHash, nonce: c.nonce.toString(), sig }
  if (ifResting !== undefined) msg.ifResting = ifResting
  return msg
}

/** The owner's wallet signs this once per session (the only wallet popup for trading). */
export const signAuthorizeKey = (d: Domain, owner: TypedSigner, a: AuthorizeKey): Promise<Hex> =>
  owner.signTypedData(authorizeKeyTyped(d, a))

export const authorizeKeyMsg = (a: AuthorizeKey, sig: Hex): AuthorizeKeyMsg => ({
  kind: 'authorizeKey',
  owner: a.owner,
  key: a.key,
  expiry: a.expiry.toString(),
  nonce: a.nonce.toString(),
  sig,
})

/** Random u64 nonce. */
export function randomNonce(): bigint {
  const b = new Uint32Array(2)
  crypto.getRandomValues(b)
  return (BigInt(b[0]) << 32n) | BigInt(b[1])
}
