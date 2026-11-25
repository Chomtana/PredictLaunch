import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, cournotError, poolOf, progressOf, toUnixSec } from './api.ts'

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

  it('Cournot calls: paths, bodies, friendly errors', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ markets: [] })))
    vi.stubGlobal('fetch', fetchMock)
    await api.cournotResolve('Will it rain?')
    await api.cournotProbability('Will it rain?', '2849008')
    await api.oracle(4)
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit | undefined][]
    expect(calls.map((c) => c[0])).toEqual(['/api/cournot/resolve', '/api/cournot/probability', '/api/launch/4/oracle'])
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({ message: 'Will it rain?' })
    expect(JSON.parse(String(calls[1][1]?.body))).toEqual({ message: 'Will it rain?', marketId: 2849008 })

    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'payment_required', message: '402' }), { status: 402 }))
    expect(cournotError(await api.cournotProbability('q', 1).catch((x: unknown) => x))).toMatch(/payment/i)
    expect(cournotError(new ApiError('cournot_unavailable', ''))).toMatch(/unreachable/)
    expect(cournotError(new ApiError('bad_question', ''))).toMatch(/280 bytes/)
    expect(cournotError(new ApiError('http_503', ''))).toMatch(/unreachable/)
  })

  it('toUnixSec reads ISO, seconds and ms', () => {
    expect(toUnixSec('2026-12-09T23:59:00Z')).toBe(Date.UTC(2026, 11, 9, 23, 59) / 1000)
    expect(toUnixSec(1_795_000_000)).toBe(1_795_000_000)
    expect(toUnixSec('1795000000')).toBe(1_795_000_000)
    expect(toUnixSec(1_795_000_000_000)).toBe(1_795_000_000)
    expect(toUnixSec(null)).toBeNaN()
  })

  it('pool and progress use the projection while active, raised after', () => {
    const base = { raised: '0', projectedRaised: (E18).toString(), pairs: (10n * E18).toString(), cutBps: 1000, target: (2n * E18).toString() }
    expect(poolOf({ ...base, status: 0 })).toBe(E18)
    expect(progressOf({ ...base, status: 0 })).toBe(0.5)
    expect(poolOf({ ...base, status: 2, raised: (3n * E18).toString() })).toBe(3n * E18)
    expect(progressOf({ ...base, status: 2, raised: (3n * E18).toString() })).toBe(1)
  })
})
