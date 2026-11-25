import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, poolOf, progressOf } from './api.ts'

afterEach(() => vi.unstubAllGlobals())

const E18 = 10n ** 18n

describe('api client', () => {
  it('GETs JSON', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ bids: [{ price: 40, amount: '1' }], asks: [] })))
    vi.stubGlobal('fetch', fetchMock)
    const b = await api.book(3)
    expect(b.bids[0].price).toBe(40)
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe('/api/book/3')
  })

  it('maps 400 bodies to ApiError', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'not_tradable', message: 'closed', index: 0 }), { status: 400 }))
    const e = await api.msgs([]).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(ApiError)
    expect((e as ApiError).code).toBe('not_tradable')
    expect((e as ApiError).index).toBe(0)
  })

  it('pool and progress use the projection while active, raised after', () => {
    const base = { raised: '0', projectedRaised: (E18).toString(), pairs: (10n * E18).toString(), cutBps: 1000, target: (2n * E18).toString() }
    expect(poolOf({ ...base, status: 0 })).toBe(E18)
    expect(progressOf({ ...base, status: 0 })).toBe(0.5)
    expect(poolOf({ ...base, status: 2, raised: (3n * E18).toString() })).toBe(3n * E18)
    expect(progressOf({ ...base, status: 2, raised: (3n * E18).toString() })).toBe(1)
  })
})
