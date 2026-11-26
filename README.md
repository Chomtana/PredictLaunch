# PredictLaunch

A memecoin launchpad where each launch's liquidity is raised by a Polymarket-style "Up or Down"
prediction market on an Atlas Oracle feed. The creator picks a feed, a **strike** (price to beat) and
a **settlement time**. Traders buy Up or Down shares (1 Up + 1 Down are always backed by 1 unit of the quote token: native
BNB, or on the testnet dev stack Flap's faucet USDT).
At settlement, winners are paid 1 − cut per share, the cut fills the launch's pool, losers claim the
memecoin, and graduation launches the token through Flap's Pool Launch Portal via our Launcher
Factory, with a PancakeSwap pool. If the target isn't reached, winners are paid in full.

- Interfaces: [SPEC.md](SPEC.md) (and each track's `SPEC-NOTES.md`)
- Design: [docs/superpowers/specs/2026-11-25-predictlaunch-design.md](docs/superpowers/specs/2026-11-25-predictlaunch-design.md)
- Plan: [docs/superpowers/plans/2026-11-25-predictlaunch.md](docs/superpowers/plans/2026-11-25-predictlaunch.md)

```
contracts/   Foundry: Exchange, Flap Launcher Factory + Launcher (rail)
core/        Rust lib: types, EIP-712, book/matcher, state mirror, batcher
sequencer/   Rust service: matching, batches, keeper, HTTP/WS API
frontend/    React/Vite UI + scripts/ (feed relay, seed bots, e2e driver)
scripts/     dev.sh (one-command fork demo), e2e.sh (end-to-end smoke)
```

## Setup

Requirements: Foundry (`anvil`, `forge`, `cast`), Rust (cargo), Node ≥ 22 with pnpm, `jq`, `curl`.

```bash
cp .env.example .env        # set BSC_TESTNET_RPC_URL: your own BSC testnet node or a provider key
cd contracts && forge soldeer install && cd ..
cd frontend && pnpm install && cd ..
```

`.env` is gitignored and read by `scripts/dev.sh`, `scripts/e2e.sh` and Foundry. The scripts never print
the URL (logs are scrubbed). A public rate-limited endpoint is usually too slow for the fork: use a
provider key.

## Local demo: `scripts/dev.sh`

```bash
scripts/dev.sh                 # everything, including the frontend at http://localhost:5173
scripts/dev.sh --no-live       # seed once, no live market-maker loop
scripts/dev.sh --no-seed       # no seeded launches/bots
scripts/dev.sh --no-frontend   # no Vite (API work, e2e)
```

It runs, in order: `anvil --fork-url $BSC_TESTNET_RPC_URL --chain-id 97 --block-time 1` →
`forge script Deploy` (owner anvil #0, operator anvil #9) → `contracts/script/fork-setup.sh`
(authorizes the Exchange on every Atlas feed and opens the factory on the Flap Portal) → the feed
relay (copies live testnet prices into the fork every 2 s) → the sequencer (`--dev-faucet`) → the
seed bots (two launches: BTCB, strike = now, settles in 15 min, cut 10%, target 2,150 USDT; BNB,
strike = now + 1%, settles in 30 min, cut 30%, target 3,000 USDT; a maker and two takers trading around
a Black-Scholes-style fair price) → Vite. When both seeded launches have settled, the bots create a
new pair. Logs are in `.dev/*.log`; Ctrl-C stops everything.

**Quote token.** By default the Exchange's collateral is Flap's testnet faucet USDT
(`0x190C989D5665a0e404B444b53CAE9AbCfb600157`, on-chain symbol "USD", 18 decimals). Its `mint` is
public, so bots, the dev faucet and anyone on live testnet can mint it
([abc.flap.sh/faucet](https://abc.flap.sh/faucet?lang=en)); only gas and the 0.005 BNB salt-lock fee
need tBNB. The Portal's pool floor is 1,500 USDT, so `minTarget` is 1,500 and every demo amount is
x1000 the BNB one. `QUOTE=bnb scripts/dev.sh` runs with native BNB instead (`QUOTE_TOKEN` and
`MIN_TARGET` env on `Deploy.s.sol`).

### MetaMask

Add a **custom network**: name "PredictLaunch fork", RPC `http://127.0.0.1:8545`, chain ID `97`,
symbol BNB. It has the same chain ID as the real BSC testnet: keep it a separate network, never mix
the two, and never send real testnet funds to the dev keys. Import an anvil dev key (PUBLIC keys,
fork only), for example #0 `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80` or
#1 `0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d`. The faucet button in the
app gives any address 1000 fork BNB for gas and 10,000 USDT (`POST /api/faucet`, dev only).

### Dev wallet

Instead of MetaMask, pick a dev wallet in the connect dialog (shown only when the RPC is local):
Alice #0, Bob #1, Carol #2 or Erin #4. It signs with that public anvil key in the browser, no
extension needed. The seed bots use #3 (creator), #5 (maker), #6 and #7 (takers); #9 is the
operator. Local fork only.

## End-to-end smoke: `scripts/e2e.sh`

```bash
scripts/e2e.sh                 # ~13 min, real time; prints "E2E OK"
```

It starts `dev.sh --no-frontend --no-seed`, then `frontend/scripts/e2e.ts` creates a BTCB launch
settling 10 min out (cut 10%, target 2,150 USDT), two bots mint 25,000 USDT of pairs, and it waits for the
keeper to snapshot, resolve, redeem and graduate through the real Flap Portal. It asserts the token
ends in `7777`, a token/USDT PancakeSwap pair holds the raise, the loser claims > 0 tokens, the winner's balance rose by
(1 − cut) per winning share, and `/api/status.softReversals == 0`.

## Tests

```bash
cd contracts && forge test           # fork tests skip when BSC_TESTNET_RPC_URL is unset
cargo test --workspace
cd frontend && pnpm vitest run
```

## Known limitations

- **Atlas feeds only serve authorized contracts.** On live testnet the Atlas team must call
  `setAuthorizedCallers([exchange], [true])` on each feed a launch uses. Until then `snapshot` falls
  back to Chainlink for BTCB/USD, BNB/USD, CAKE/USD and USDT/USD (`setFallbackFeed`, set by the
  deploy script; the price is scaled from 8 to 18 decimals and `SnapshotSource` names the source).
  Launches on any other feed can't snapshot: the market goes Void after the grace window, everyone
  redeems at 0.50 and the launch fails. On the fork, `fork-setup.sh` authorizes the Exchange on
  Atlas, so Atlas is used.
- **Chart vs settlement prices.** The chart streams the Atlas offchain API (CoinMarketCap-backed,
  ~10 s updates; onchain feed fallback), while settlement always uses the onchain snapshot. On the
  fork the onchain feeds are copied from live testnet every 2 s by the feed relay, so the two agree
  closely but not to the wei.
- **Flap factory gating.** Flap must enable our factory with `setLauncherFactoryMultiplier` on
  mainnet; the testnet Portal currently does not enforce it (see `contracts/SPEC-NOTES.md`).
- **The salt lock is taken at creation** (`Portal.newLauncher` charges `SALT_LOCK_FEE` and locks the
  `…7777` salt) while the token launches at graduation, up to 30 days later. Tested with a 10-minute
  gap; whether the Portal expires long-held locks was not checked.
- The fork has chain ID 97, same as the real testnet; PancakeSwap/BscScan links in the UI only work
  for live-testnet launches.
- The fork's feed prices are as fresh as the relay (2 s polling of the live testnet).
- Cold-fork stalls: the first graduation on a fresh fork fetches a lot of remote state and anvil
  stalls for ~15–30 s, long enough for an in-flight batch to exceed `MAX_LAG` and revert (a soft
  reversal). `seed.ts` and `e2e.ts` warm the path with a no-op `eth_call` right after creating
  their first launch; a launch created first from the UI on a brand-new fork doesn't get that.
- The fork RPC URL is passed to `anvil --fork-url`, so it is visible in the local process list
  (`ps`); it is never written to logs.
