import { describe, expect, it, vi } from 'vitest'
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, type Address, type Hex } from 'viem'
import { createLaunch, encodeLaunchConfig, LAUNCH_CONFIG_ABI, portalAbi, type LaunchConfig } from './chain.ts'

const cfg: LaunchConfig = {
  name: 'Doge Moon',
  symbol: 'DMOON',
  imageURI: 'https://example.com/d.png',
  feed: '0xe20536bc715aac6560394e33deb66ed205aeec33',
  strike: 100_000n * 10n ** 18n,
  settleTime: 1_900_000_000n,
  cutBps: 1000,
  target: 2_150_000_000_000_000_000n,
  salt: '0x00000000000000000000000000000000000000000000000000000000000000ab',
  question: '',
  marketId: 0n,
}

const ZERO = '0x0000000000000000000000000000000000000000' as Address

describe('chain', () => {
  it('encodes LaunchConfig as abi.encode(tuple)', () => {
    const data = encodeLaunchConfig(cfg)
    const [c] = decodeAbiParameters(LAUNCH_CONFIG_ABI, data)
    expect(c.name).toBe(cfg.name)
    expect(c.symbol).toBe(cfg.symbol)
    expect(c.feed.toLowerCase()).toBe(cfg.feed)
    expect(c.strike).toBe(cfg.strike)
    expect(c.settleTime).toBe(cfg.settleTime)
    expect(c.cutBps).toBe(1000)
    expect(c.target).toBe(cfg.target)
    expect(c.salt).toBe(cfg.salt)
    expect(c.question).toBe('')
    expect(c.marketId).toBe(0n)
  })

  it('appends question and marketId at the end of the tuple', () => {
    const q: LaunchConfig = { ...cfg, feed: ZERO, strike: 0n, question: 'Will it rain in Boston on Nov 27, 2026?', marketId: 2849008n }
    const data = encodeLaunchConfig(q)
    const [c] = decodeAbiParameters(LAUNCH_CONFIG_ABI, data)
    expect(c.feed).toBe(ZERO)
    expect(c.strike).toBe(0n)
    expect(c.question).toBe(q.question)
    expect(c.marketId).toBe(2849008n)
    // field order: the two new members are the last components
    const names = LAUNCH_CONFIG_ABI[0].components.map((x) => x.name)
    expect(names.slice(-2)).toEqual(['question', 'marketId'])
    expect(names.slice(0, 9)).toEqual(['name', 'symbol', 'imageURI', 'feed', 'strike', 'settleTime', 'cutBps', 'target', 'salt'])
    // it matches a hand-built encoding with the Solidity types in order
    const manual = encodeAbiParameters(
      [{ type: 'tuple', components: [{ type: 'string' }, { type: 'string' }, { type: 'string' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint64' }, { type: 'uint16' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'string' }, { type: 'uint256' }] }],
      [[q.name, q.symbol, q.imageURI, q.feed, q.strike, q.settleTime, q.cutBps, q.target, q.salt, q.question, q.marketId]],
    )
    expect(data).toBe(manual)
  })

  it('createLaunch calls Portal.newLauncher{value: saltLockFee}(factory, data)', async () => {
    const writeContract = vi.fn(async () => '0xabc' as Hex)
    const portal = '0x000042108465206185A077Edc3F3fd2b49060000' as Address
    const factory = '0x00000000000000000000000000000000000fac70' as Address
    await createLaunch({ writeContract } as never, '0x00000000000000000000000000000000000000a1', { portal, factory, saltLockFee: 5n * 10n ** 15n }, cfg)
    const call = (writeContract.mock.calls[0] as unknown[])[0] as { address: Address; functionName: string; args: [Address, Hex]; value: bigint; abi: typeof portalAbi }
    expect(call.address).toBe(portal)
    expect(call.functionName).toBe('newLauncher')
    expect(call.value).toBe(5n * 10n ** 15n)
    expect(call.args[0]).toBe(factory)
    expect(call.args[1]).toBe(encodeLaunchConfig(cfg))
    // and it encodes as a valid Portal call
    const data = encodeFunctionData({ abi: portalAbi, functionName: 'newLauncher', args: call.args })
    const [f, d] = decodeFunctionData({ abi: portalAbi, data }).args as [Address, Hex]
    expect([f.toLowerCase(), d]).toEqual([factory, call.args[1]])
  })
})
