// Owner settlement of a question launch (SPEC "Question launches"): Exchange.overrideOutcome. LOCAL ONLY:
// the owner is the deployer, anvil #0 in scripts/dev.sh (deploy.json `owner`); OWNER_KEY overrides it.
//
//   node --experimental-strip-types scripts/settle.ts --launch 3 --outcome yes|no|void \
//     [--rpc http://127.0.0.1:8545] [--deploy ../.dev/deploy.json] [--note "why"]
//
// The evidence hash is keccak256 of a small JSON note (printed with the tx). The override is final, so
// the keeper resolves the launch on its next pass (then redeems and graduates as usual).

import { readFileSync } from 'node:fs'
import { keccak256, toBytes, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { exchangeAbi } from '../src/lib/chain.ts'
import { ANVIL_KEYS, arg, setup } from './lib.ts'

const OUTCOMES = { yes: 0, no: 1, void: 2 } as const

function usage(msg: string): never {
  console.error(`settle: ${msg}\nusage: settle.ts --launch N --outcome yes|no|void [--rpc URL] [--deploy PATH] [--note TEXT]`)
  process.exit(2)
}

async function main() {
  const launch = arg('launch')
  const outcomeArg = arg('outcome')?.toLowerCase()
  if (!launch || !/^\d+$/.test(launch)) usage('--launch N is required')
  if (!outcomeArg || !(outcomeArg in OUTCOMES)) usage('--outcome must be yes, no or void')
  const outcome = OUTCOMES[outcomeArg as keyof typeof OUTCOMES]
  const id = BigInt(launch)
  const deployPath = arg('deploy', '../.dev/deploy.json')!
  const S = setup(arg('rpc', 'http://127.0.0.1:8545')!, arg('api', 'http://127.0.0.1:8787')!, deployPath)

  const owner = (JSON.parse(readFileSync(deployPath, 'utf8')) as { owner?: Address }).owner
  const key = (process.env.OWNER_KEY as Hex | undefined) ?? ANVIL_KEYS.find((k) => owner && privateKeyToAccount(k).address.toLowerCase() === owner.toLowerCase()) ?? ANVIL_KEYS[0]
  const acct = privateKeyToAccount(key)
  if (owner && acct.address.toLowerCase() !== owner.toLowerCase()) usage(`the Exchange owner is ${owner}, not ${acct.address}: set OWNER_KEY`)

  const isQ = await S.pc.readContract({ address: S.deploy.exchange, abi: exchangeAbi, functionName: 'isQuestion', args: [id] })
  if (!isQ) usage(`launch #${id} is not a question launch`)

  const note = JSON.stringify({ launchId: Number(id), outcome: outcomeArg.toUpperCase(), by: 'owner', note: arg('note', 'manual settlement (settle.ts)'), at: Math.floor(Date.now() / 1000) })
  const evidenceHash = keccak256(toBytes(note))
  console.log(`settle: launch #${id} -> ${outcomeArg.toUpperCase()} as ${acct.address}`)
  console.log(`settle: note ${note}`)
  console.log(`settle: evidenceHash ${evidenceHash}`)
  const rc = await S.send(acct, { address: S.deploy.exchange, abi: exchangeAbi, functionName: 'overrideOutcome', args: [id, outcome, evidenceHash] })
  console.log(`settle: tx ${rc.transactionHash} (block ${rc.blockNumber}, status ${rc.status})`)
}

main().catch((e) => {
  console.error(`settle: ${(e as { shortMessage?: string }).shortMessage ?? (e as Error).message}`)
  process.exit(1)
})
