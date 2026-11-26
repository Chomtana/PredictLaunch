# PredictLaunch

A memecoin launchpad where each launch's liquidity is raised by a Polymarket-style "Up or Down"
prediction market on an Atlas Oracle feed. The creator picks a feed, a **strike** (price to beat) and
a **settlement time**. Traders buy Up or Down shares (1 Up + 1 Down are always backed by 1 unit of the quote token: native
BNB, or on the testnet dev stack Flap's faucet USDT).
At settlement, winners are paid 1 − cut per share, the cut fills the launch's pool, losers claim the
memecoin, and graduation launches the token through Flap's Pool Launch Portal via our Launcher
Factory, with a PancakeSwap pool. If the target isn't reached, winners are paid in full.

The creator picks where the coin launches: **Flap** (default) or **Four.meme**, through our own OpenFour
preset (see [Four.meme (OpenFour) rail](#fourmeme-openfour-rail)). Same mechanism on both: 1B supply,
the raise and 500M seed a PancakeSwap pool, losers claim the other 500M.

- Interfaces: [SPEC.md](SPEC.md) (and each track's `SPEC-NOTES.md`)
- Design: [docs/superpowers/specs/2026-11-25-predictlaunch-design.md](docs/superpowers/specs/2026-11-25-predictlaunch-design.md)
- Plan: [docs/superpowers/plans/2026-11-25-predictlaunch.md](docs/superpowers/plans/2026-11-25-predictlaunch.md)

```
contracts/   Foundry: Exchange, Flap Launcher Factory + Launcher (rail), OpenFour preset + FourRail (src/openfour/)
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
scripts/dev.sh --no-four       # Flap only: skip our OpenFour instance (saves ~5 min)
```

It runs, in order: `anvil --fork-url $BSC_TESTNET_RPC_URL --chain-id 97 --block-time 1` →
`forge script Deploy` (owner anvil #0, operator anvil #9; enables the factory on the Flap Portal
through Flap's testnet whitelist helper, exactly as on real testnet) → `contracts/script/fork-setup.sh`
(fork only: authorizes the Exchange on every Atlas feed with `anvil_setStorageAt`) → the feed
relay (copies live testnet prices into the fork every 2 s) → the sequencer (`--dev-faucet`) → the
seed bots (each round: 2-3 BTC/BNB/ETH price launches with random meme names, coin-icon logos,
near-the-money strikes, 10-30 min, random cut and target; plus 1-2 Cournot question launches on live
real-world markets such as city rain, the Fed or Starship, with a matching photo, all on Flap; and,
when Four is deployed, one more price launch and one more question launch on Four.meme; catalog in
`frontend/src/lib/catalog.ts`, images in `frontend/public/seed/`; a maker and two takers trade
around a Black-Scholes-style fair price, or the Cournot probability) → Vite. When every seeded
launch has settled, the bots create a new round. Logs are in `.dev/*.log`; Ctrl-C stops everything.

**Quote token.** By default the Exchange's collateral is Flap's testnet faucet USDT
(`0x190C989D5665a0e404B444b53CAE9AbCfb600157`, on-chain symbol "USD", 18 decimals). Its `mint` is
public, so bots, the dev faucet and anyone on live testnet can mint it
([abc.flap.sh/faucet](https://abc.flap.sh/faucet?lang=en)); only gas and the 0.005 BNB salt-lock fee
need tBNB. The Portal's pool floor is 1,500 USDT, so `minTarget` is 1,500 and every demo amount is
x1000 the BNB one. `QUOTE=bnb scripts/dev.sh` runs with native BNB instead (`QUOTE_TOKEN` and
`MIN_TARGET` env on `Deploy.s.sol`).

### Real BSC testnet (no fork)

**One seed phrase for everything.** Put a BIP-39 `MNEMONIC` in `.env`. Every account comes from it
(`scripts/keys.sh`): index 0 deployer/owner, 9 operator (batches, keeper, resolver, OpenFour `Core.signer`),
3 seed creator, 5 market maker, 6/7 takers. Left empty, it is anvil's public test mnemonic, so the fork keeps
using anvil #0..#9; `dev.sh` with your own mnemonic gives those accounts fork BNB.

```bash
scripts/wallets.sh             # addresses, needs, balances; tops up every account from the deployer
scripts/wallets.sh --check     # list only, send nothing
scripts/wallets.sh --rpc http://127.0.0.1:8545   # the same on the dev fork
scripts/testnet.sh             # all of it: wallet check, deploy once (Flap + our OpenFour), sequencer, bots, frontend
scripts/testnet.sh --no-four   # Flap only; also --no-seed, --no-frontend, --redeploy
scripts/testnet.sh --verify    # retry BscScan verification (needs ETHERSCAN_API_KEY)
```

**Fund only the deployer.** `wallets.sh` adds up what the other accounts are missing; when the deployer
holds that plus what it keeps for itself (0.1 tBNB, or just the gas still needed to deploy when `testnet.sh`
calls it), it sends each account its shortfall from the deployer; otherwise it prints the one amount to send
to the deployer. USDT needs nothing: the bots mint Flap's faucet USDT (public `mint`) whenever
they run low (every few ticks, and right away after an `insufficient_balance` rejection). On a real network
they only warn when an account's gas runs low.

**BscScan verification.** With `ETHERSCAN_API_KEY` (an etherscan.io key; Etherscan V2 covers BscScan
testnet) in `.env`, `testnet.sh` verifies every contract it deployed right after the deploy: Exchange, the Flap
factory and the beacon + Launcher implementation its constructor creates, FourRail, the preset validator and
the three OpenFour modules (`scripts/verify.sh`, from the broadcasts saved in `.dev/testnet/`; constructor
arguments are read back from the chain). It runs once per deployment; `scripts/testnet.sh --verify` retries.
OpenFour's own Core / Registry proxies come from their fork-deploy and are not ours to verify.

**The deployment is tracked.** After it deploys, `testnet.sh` writes the public addresses to
[`deployments/bsc-testnet.json`](deployments/) (summary with BscScan links) and `deployments/bsc-testnet/`
(the files later runs reuse). Commit them; any clone then runs against the same deployment. Keys never leave
`.env`. `testnet.sh` refuses to run with the public anvil mnemonic.

The manual steps below do the same by hand.

`Deploy.s.sol` uses no cheats, so it deploys to the real testnet as is. It enables the factory on
the Flap Portal by calling `whitelist(factory)` on Flap's testnet helper
`0x77779969a11eff7582f3bCf48135A846A3457777` (anyone may call it; it exists on testnet only), then
reads `Portal.launcherFactoryMultiplier(factory)` back and fails unless it is `(true, 10000)`. By default it
enables only the feeds with a Chainlink fallback (BTCB, BNB, BTC, ETH, CAKE, USDT), because the Exchange can't read the
others until Atlas authorizes it (BNB, BTC and ETH are open-read Atlas feeds and settle on Atlas directly) (see Known limitations). The deployer needs about 0.012 tBNB.

```bash
set -a; . ./.env; set +a
START_BLOCK=$(cast block-number --rpc-url "$BSC_TESTNET_RPC_URL")
cd contracts
OPERATOR=<operator address> QUOTE_TOKEN=0x190C989D5665a0e404B444b53CAE9AbCfb600157 \
DEPLOY_JSON=../.dev/testnet-deploy.json \
forge script script/Deploy.s.sol:Deploy --rpc-url "$BSC_TESTNET_RPC_URL" --broadcast \
  --legacy --with-gas-price 1gwei --private-key <deployer key>      # or --account / --ledger
# check (should print: true, 10000)
cast call --rpc-url "$BSC_TESTNET_RPC_URL" 0x000042108465206185A077Edc3F3fd2b49060000 \
  'launcherFactoryMultiplier(address)(bool,uint16)' $(jq -r .factory ../.dev/testnet-deploy.json)
```

Leave out `--broadcast` to simulate against live testnet state first. Optional env:
`FACTORY_MULTIPLIER_BPS` (0..10000, default 10000), and `ALL_FEEDS=true` once Atlas has authorized the
Exchange. The helper can't disable a factory, but anyone can overwrite its multiplier, so re-check it
before testing if the multiplier matters. Then run the sequencer against the live RPC, **without**
`--dev-faucet` (it uses `anvil_setBalance`) and without the feed relay or seed bots (both fork only).
The operator key needs tBNB for batch gas:
`target/debug/predictlaunch-sequencer --rpc "$BSC_TESTNET_RPC_URL" --exchange <exchange> --factory <factory> --operator-key <operator key> --start-block "$START_BLOCK" --quote-symbol USDT --oracle-dir .dev/oracle-testnet`.

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

## Four.meme (OpenFour) rail

OpenFour is Four.meme's modular launch engine. Following the
[openfour-docs](https://github.com/four-meme-community/openfour-docs) developer guide, we fork-deploy our
**own** OpenFour instance (Registry, Core, FeeRouter, Tools over the testnet implementations; we own it) and
register a **PredictLaunch preset** on it:

| Slot | Module | Notes |
| --- | --- | --- |
| token, vault | fork's `TOKEN_STANDARD`, `VAULT_BASIC` | reused |
| curve | `FairLaunchCurveModule` (`module.curve.fair_launch`) | fixed price `raise / 500M`, sells off |
| trade | `PredictLaunchTradeModule` (`module.trade.predict_launch`) | new: only the rail may buy, no sells |
| migrate | `FairLaunchMigrateModule` (`module.migrate.fair_launch`) | at sell-out: raise + other 500M to an empty PCS V2 pair, LP burned |
| validator | `PredictLaunchPresetValidator` | pins 1B supply, 500M sale, raise = sale × price, buyer = rail |

`FourRail` (`contracts/src/openfour/FourRail.sol`) is both the factory and the graduation rail of Four
launches. `FourRail.createLaunch(cfg)` registers the market on the Exchange (no salt, no fee; the token
doesn't exist yet). At graduation the keeper signs the rail's `createDigest` with the operator key (our
fork's `Core.signer`) and calls `FourRail.graduate(id, validTimestamp, sig)`, which runs
`Exchange.graduate`: `Core.createToken` on the preset, `Core.buy` of the whole 500M sale with the raise
(sold out, so Core migrates to PancakeSwap in the same call), and the 500M goes to the Exchange for the
losers. On our fork the preset has zero protocol/dev fees, so the pool gets the whole raise (minus
`raise / 500M` rounding dust, sent to the creator).

`scripts/openfour-fork.sh <rpc> <deployer key> <signer> <exchange>` does the whole setup (openfour-docs
`fork-deploy` at a pinned commit, then `forge script DeployFour`) and writes `.dev/four.json`; `dev.sh`
runs it unless `--no-four`. On real testnet the same script works (deployer needs tBNB and must own the
Exchange), then pass `--four-rail <rail>` to the sequencer. Fork tests:
`OPENFOUR_RPC=<rpc with the fork deployed> OPENFOUR_JSON=../.dev/openfour/fork-deployment.json forge test --mc FourForkTest --threads 1`.

Limitation: the create signature covers the raise, so it can only be made at graduation, by a key that is
`Core.signer`. That is fine on our own OpenFour instance; on the official Four.meme deployment the signer is
Four.meme's create API, which this path does not use.

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
  back to Chainlink for BTCB/USD, CAKE/USD and USDT/USD (BNB/USD, BTC/USD and ETH/USD are open-read, so they need no authorization) (`setFallbackFeed`, set by the
  deploy script; the price is scaled from 8 to 18 decimals and `SnapshotSource` names the source).
  Launches on any other feed can't snapshot: the market goes Void after the grace window, everyone
  redeems at 0.50 and the launch fails, so by default the deploy script doesn't enable those feeds
  (`ALL_FEEDS=true` does). On the fork, `dev.sh` deploys with `ALL_FEEDS=true` and `fork-setup.sh`
  authorizes the Exchange on Atlas, so Atlas is used.
- **Chart vs settlement prices.** The chart streams the Atlas offchain API (CoinMarketCap-backed,
  ~10 s updates; onchain feed fallback), while settlement always uses the onchain snapshot. On the
  fork the onchain feeds are copied from live testnet every 2 s by the feed relay, so the two agree
  closely but not to the wei.
- **Flap factory gating.** On testnet, `Deploy.s.sol` enables the factory through Flap's public
  whitelist helper (the testnet Portal does not currently enforce it anyway; see
  `contracts/SPEC-NOTES.md`). The helper doesn't exist on mainnet, where Flap enables a factory only after
  an audit, so the deploy script refuses to run there.
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
