// Web Worker: mines a Flap launch salt off the main thread (see salt.ts).
import type { Hex } from 'viem'
import { mineSaltSync } from './salt.ts'

self.onmessage = (e: MessageEvent<{ seed: Hex }>) => {
  try {
    self.postMessage({ salt: mineSaltSync(e.data.seed) })
  } catch (err) {
    self.postMessage({ error: String(err) })
  }
}
