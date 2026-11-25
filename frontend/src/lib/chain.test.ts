import { describe, expect, it, vi } from 'vitest'
import { decodeAbiParameters, decodeFunctionData, encodeFunctionData, type Address, type Hex } from 'viem'
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
}

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
