// Main wallet: any injected EIP-1193 wallet (EIP-6963 discovery + window.ethereum), or a
// LOCAL-ONLY dev wallet that uses the public anvil keys (local fork only).
//
// The main wallet is used for on-chain txs (deposit, withdraw, claim, create launch) and
// for exactly ONE off-chain signature per session: AuthorizeKey. Orders never touch it.

import {
  createWalletClient,
  custom,
  http,
  numberToHex,
  type Account,
  type Address,
  type Chain,
  type EIP1193Provider,
  type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { withFixedGas } from './chain'

export interface InjectedInfo {
  id: string
  name: string
  icon?: string
  provider: EIP1193Provider
}

export interface Wallet {
  kind: 'injected' | 'dev'
  address: Address
  label: string
  client: WalletClient
  /** For writeContract / signTypedData: a local account (dev) or the json-rpc address (injected). */
  account: Account | Address
  provider?: EIP1193Provider
}

/** anvil's default accounts (#5-#7 are the seed bots, #9 the operator). PUBLIC keys from the anvil mnemonic: local demo only, never fund them. */
export const DEV_ACCOUNTS: { name: string; key: `0x${string}` }[] = [
  { name: 'Alice #0', key: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' },
  { name: 'Bob #1', key: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' },
  { name: 'Carol #2', key: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' },
  { name: 'Erin #4', key: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a' },
]

export function discoverInjected(onChange: (list: InjectedInfo[]) => void): () => void {
  const found = new Map<string, InjectedInfo>()
  const emit = () => onChange([...found.values()])
  const onAnnounce = (e: Event) => {
    const d = (e as CustomEvent).detail as { info: { uuid: string; name: string; icon?: string; rdns?: string }; provider: EIP1193Provider }
    found.set(d.info.rdns ?? d.info.uuid, { id: d.info.rdns ?? d.info.uuid, name: d.info.name, icon: d.info.icon, provider: d.provider })
    emit()
  }
  window.addEventListener('eip6963:announceProvider', onAnnounce)
  window.dispatchEvent(new Event('eip6963:requestProvider'))
  // Legacy fallback (wallets that don't implement EIP-6963).
  const t = setTimeout(() => {
    const eth = (window as unknown as { ethereum?: EIP1193Provider & { isMetaMask?: boolean } }).ethereum
    if (eth && found.size === 0) {
      found.set('injected', { id: 'injected', name: eth.isMetaMask ? 'MetaMask' : 'Browser wallet', provider: eth })
      emit()
    }
  }, 150)
  return () => {
    clearTimeout(t)
    window.removeEventListener('eip6963:announceProvider', onAnnounce)
  }
}

async function ensureChain(p: EIP1193Provider, chain: Chain) {
  const current = await p.request({ method: 'eth_chainId' })
  if (Number(current) === chain.id) return
  try {
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: numberToHex(chain.id) }] })
  } catch (e) {
    const code = (e as { code?: number }).code
    if (code !== 4902 && code !== -32603) throw e
    await p.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: numberToHex(chain.id),
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: [...chain.rpcUrls.default.http],
        },
      ],
    })
  }
}

export async function connectInjected(w: InjectedInfo, chain: Chain, silent = false): Promise<Wallet> {
  const accounts = (await w.provider.request({ method: silent ? 'eth_accounts' : 'eth_requestAccounts' })) as Address[]
  if (!accounts?.length) throw new Error('No account authorized')
  if (!silent) await ensureChain(w.provider, chain)
  const address = accounts[0]
  return {
    kind: 'injected',
    address,
    label: w.name,
    client: withFixedGas(createWalletClient({ chain, transport: custom(w.provider) })),
    account: address,
    provider: w.provider,
  }
}

export function connectDev(index: number, chain: Chain): Wallet {
  const acct = privateKeyToAccount(DEV_ACCOUNTS[index].key)
  return {
    kind: 'dev',
    address: acct.address,
    label: `Dev wallet · ${DEV_ACCOUNTS[index].name}`,
    client: withFixedGas(createWalletClient({ chain, transport: http(), account: acct })),
    account: acct,
  }
}
