// Feed relay: keeps the Atlas feed prices on the local anvil fork live.
//
// The fork freezes every feed at the fork block. Every 2 s this copies storage slot 0x32 of each feed
// (updatedAt(uint48) | startedAt(uint48) | answer(uint80), high bits to low) from live BSC testnet
// into the fork with anvil_setStorageAt, whenever it changed. At startup it checks, for every feed,
// that the decoded slot answer equals the live latestAnswer() (exits non-zero otherwise), so a
// layout change can't silently feed garbage prices.
//
//   BSC_TESTNET_RPC_URL=... node --experimental-strip-types scripts/feed-relay.ts \
//     [--fork http://127.0.0.1:8545] [--feeds 0xaaa,0xbbb] [--interval-ms 2000]
//
// The live RPC URL is read from the BSC_TESTNET_RPC_URL env var only (never from argv, never logged).
// Without --feeds, every feed in contracts/script/feeds.json is relayed.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createPublicClient, http, parseAbi, type Address, type Hex } from 'viem'

export const SLOT = '0x0000000000000000000000000000000000000000000000000000000000000032' as const

export interface FeedState {
  answer: bigint
  startedAt: number
  updatedAt: number
}

const M48 = (1n << 48n) - 1n
const M80 = (1n << 80n) - 1n

/** Decode the Atlas SingleFeed state word (slot 0x32). */
export function decodeSlot32(word: Hex): FeedState {
  const w = BigInt(word)
  return {
    answer: w & M80,
    startedAt: Number((w >> 80n) & M48),
    updatedAt: Number((w >> 128n) & M48),
  }
}

const feedAbi = parseAbi(['function latestAnswer() view returns (int256)'])

function arg(k: string): string | undefined {
  const i = process.argv.indexOf(`--${k}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const liveUrl = process.env.BSC_TESTNET_RPC_URL
  if (!liveUrl) {
    console.error('feed-relay: BSC_TESTNET_RPC_URL is not set')
    process.exit(1)
  }
  const forkUrl = arg('fork') ?? 'http://127.0.0.1:8545'
  const interval = Number(arg('interval-ms') ?? 2000)
  let feeds: Address[]
  const list = arg('feeds')
  if (list) feeds = list.split(',').map((s) => s.trim() as Address)
  else {
    const p = fileURLToPath(new URL('../../contracts/script/feeds.json', import.meta.url))
    feeds = (JSON.parse(readFileSync(p, 'utf8')) as { address: Address }[]).map((f) => f.address)
  }

  // Errors from viem embed the URL; strip it before printing anything.
  const scrub = (e: unknown) => String((e as Error)?.message ?? e).split(liveUrl).join('<live-rpc>').split('\n')[0]

  const live = createPublicClient({ transport: http(liveUrl, { retryCount: 2, timeout: 10_000 }) })
  const fork = createPublicClient({ transport: http(forkUrl) })

  const readWord = async (f: Address) => ((await live.getStorageAt({ address: f, slot: SLOT })) ?? '0x0') as Hex

  // Startup check: slot layout matches latestAnswer() on every feed.
  for (const f of feeds) {
    let ok = false
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      try {
        const [word, ans] = await Promise.all([readWord(f), live.readContract({ address: f, abi: feedAbi, functionName: 'latestAnswer' })])
        const d = decodeSlot32(word)
        if (d.answer === ans) ok = true
        else if (attempt === 2) {
          console.error(`feed-relay: ${f} slot answer ${d.answer} != latestAnswer ${ans}`)
          process.exit(1)
        }
      } catch (e) {
        if (attempt === 2) {
          console.error(`feed-relay: ${f} startup read failed: ${scrub(e)}`)
          process.exit(1)
        }
      }
    }
  }
  console.log(`feed-relay: layout check ok on ${feeds.length} feeds; relaying every ${interval} ms`)

  const last = new Map<Address, Hex>()
  let writes = 0
  const tick = async () => {
    await Promise.all(
      feeds.map(async (f) => {
        try {
          const word = await readWord(f)
          const padded = ('0x' + BigInt(word).toString(16).padStart(64, '0')) as Hex
          if (last.get(f) === padded) return
          await fork.request({ method: 'anvil_setStorageAt' as never, params: [f, SLOT, padded] as never })
          last.set(f, padded)
          writes++
        } catch (e) {
          console.error(`feed-relay: ${f}: ${scrub(e)}`)
        }
      }),
    )
  }
  await tick()
  console.log(`feed-relay: ready (${writes} initial writes)`)
  let n = 0
  for (;;) {
    await new Promise((r) => setTimeout(r, interval))
    await tick()
    if (++n % 30 === 0) console.log(`feed-relay: ${writes} writes so far`)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error('feed-relay: fatal', String((e as Error)?.message ?? e).split(process.env.BSC_TESTNET_RPC_URL || '\0').join('<live-rpc>'))
    process.exit(1)
  })
}
