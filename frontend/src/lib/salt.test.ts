import { describe, expect, it } from 'vitest'
import { concat, getContractAddress, type Hex } from 'viem'
import { mineSalt, mineSaltSync, PORTAL, predictToken, TOKEN_IMPL } from './salt.ts'

// EIP-1167 minimal-proxy creation code for TOKEN_IMPL, as OpenZeppelin Clones deploys it.
const cloneCode = concat(['0x3d602d80600a3d3981f3363d3d373d3d3d363d73', TOKEN_IMPL, '0x5af43d82803e903d91602b57fd5bf3'])
const viemPredict = (salt: Hex) => getContractAddress({ opcode: 'CREATE2', from: PORTAL, salt, bytecode: cloneCode })

describe('salt mining', () => {
  const seed = '0x1111111111111111111111111111111111111111111111111111111111111111' as Hex

  it('predictToken agrees with viem CREATE2 + EIP-1167 bytecode', () => {
    expect(predictToken(seed)).toBe(viemPredict(seed))
  })

  it('mineSaltSync finds a salt whose token ends in 7777', () => {
    const salt = mineSaltSync(seed)
    const addr = viemPredict(salt)
    expect(addr.toLowerCase().endsWith('7777')).toBe(true)
    expect(predictToken(salt)).toBe(addr)
  })

  it('mineSalt (async, falls back without Worker) gives the same salt', async () => {
    const salt = await mineSalt(seed)
    expect(salt).toBe(mineSaltSync(seed))
    expect(viemPredict(salt).toLowerCase().endsWith('7777')).toBe(true)
  }, 30_000)
})
