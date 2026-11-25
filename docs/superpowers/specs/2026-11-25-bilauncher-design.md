# bilauncher — design

Date: 2026-11-25. Status: ready for approval (builder check done).


> **Change 2026-11-25 (user's decision): one market per launch.** Recurring Up/Down rounds were
> replaced. The creator sets a **strike** (price to beat) and a **settlement time** (5 min to 30
> days out). Up wins iff the Atlas price at settlement ≥ strike. At settlement: `raised = cut ×
> open pairs`; if ≥ target, the coin graduates through Flap and losers claim it; otherwise the
> launch fails and winners are paid 1.00. A missing settlement snapshot voids the market (0.50 each).
> The "Rounds" section, the per-feed interval rules and the separate deadline below are superseded;
> SPEC.md is authoritative. Why: it removes the riskiest machinery (round boundaries, sequential
> resolution, per-round pauses), gives creators a meme narrative ("$MOON if BNB ≥ $1,000 by
> Friday"), and makes graduation one dramatic demo moment.

## Intent

A hackathon pivot from biliquid (`../../biliquid`, a ZK-proven spot orderbook on BSC). The secret
problem statement calls for a prediction market, so we rebuild on the same skeleton without ZK.

**The pitch:** a memecoin launchpad where the launch's liquidity is raised by a prediction game.
A creator launches a memecoin and attaches a binary "Up or Down" price game (for example "BTC Up or
Down, 5m"). People bet on rounds of that game through a Polymarket-style order book. Winners are
paid **1.00 minus the launch's cut per winning share** (cut set by the creator, default 10%, so
0.90). The cut fills the memecoin's launch pool.
Losers earn the memecoin as a rebate, in proportion to their losing shares. When the pool reaches
the creator's target, the memecoin "graduates": it launches into a trading pool funded by the
raised money, the game stops, and losers claim their tokens.

Why: losing a bet normally leaves you with nothing. Here it leaves you with an early allocation of a
coin whose liquidity was paid for by the winners. Traders also get fast, CEX-like betting.

## Goals

- One home page listing launches (no separate "binary prediction" column). Anyone can create a
  launch.
- A launch page modelled on Polymarket's "BTC Up or Down 5m": price to beat, current price, a live
  chart, a countdown, a strip of rounds (past results, the live one, upcoming ones), and Up/Down
  buy and sell. The book behind it works like Polymarket's (see "Order book").
- Prices come from Atlas Oracle push feeds on BSC testnet (chain 97).
- **Everything runs on a local anvil fork of BSC testnet** (user's decision). The RPC URL comes
  from `.env` (`BSC_TESTNET_RPC_URL`, provided by the user). The Atlas feeds and the Flap Portal
  are the real deployed contracts.
- **Collateral is native BNB only** (user's decision: no tokens, no approvals).
- Low latency: a whitelisted backend sequencer matches orders and confirms them instantly. Every
  fill is settled and **fully checked onchain**, with no ZK proof.
- One wallet signature per session (trading keys), then popup-free betting.
- Memecoin launch through the **real Flap Pool Launch Portal** via our own Launcher Factory (Flap
  track rule), with one complete launch on live BSC testnet.

## Non-goals

- ZK proofs, encrypted order data, recovery keys (all of biliquid's ZK machinery is dropped).
- OpenFour (Four.meme) integration: a stretch goal after the Flap demo works.
- Mainnet, live (non-fork) testnet deploys, fees beyond the per-launch cut, any collateral other
  than native BNB, ERC-1155 share tokens, buy/sell tax on the memecoin.
- Price-range-on-a-date markets (the first idea). Only recurring Up/Down rounds.

## Anti-goals (a failure even if it works)

- The sequencer can move user funds in a way a user's signed order did not allow.
- A round resolves on a price the contract could not have read from the oracle at that time.
- Bets keep running after a launch graduates.

## Constraints and facts found

**Atlas Oracle, BSC testnet.** Push-mode "SingleFeed" contracts are Chainlink AggregatorV3
compatible: `latestRoundData() → (roundId, answer, startedAt, updatedAt, answeredInRound)`, 18
decimals. **They store only the latest price, with no history** (`getRoundData` works only for round
1). So a contract can learn "the price at time T" only by reading the feed at about time T. Reads
from a contract caller work (checked with `eth_call --from <contract>`). These contracts predate
`isOpenRead`, which reverts.

Feed list: the Atlas API (`POST https://api.atlasoracle.io/oracle/user/v1/oracle-feed/search`,
platformId 293 = BSC testnet). Every feed was checked onchain on 2026-11-25.

| Feed | Address (BSC testnet) | Update trigger | Allowed intervals |
|---|---|---|---|
| BTCB/USD | `0xe20536bc715aac6560394e33deb66ed205aeec33` | 60 s or 0.1% | 5m, 15m, 1h, 1d |
| BNB/USD | `0xb3d1614bf894e68add1ea50ca250c152bad5256f` | 60 s or 1% | 5m, 15m, 1h, 1d |
| ANKR/USD | `0xed2ce62b7bfdd31876b1e956a672e8fbe8b29403` | 15 min or 0.2% | 5m, 15m, 1h, 1d |
| CAKE/USD | `0x060d5be909a3f775ddc239d982e4fe46879bce4a` | 24 h or 5% | 1h, 1d |
| ASTER/USD | `0xee9483fd2d380384d42326143f4bc9bd0513234d` | 24 h or 1% | 1h, 1d |
| WLFI/USD | `0x6eba8b28f2411ab14f7ecdc3a2477ad436acbd21` | 24 h or 1% | 1h, 1d |
| B/USD | `0x2bcdfbc731fd179c70794854a4260774369c8d27` | 24 h or 1% | 1h, 1d |
| B2/USD | `0xd6cf91a4d545462821a43997a6df104c5068d71d` | 24 h or 1% | 1h, 1d |
| AT/USD | `0x8b8678dc64b7539a59e68e25d10cb2846f0918fe` | 24 h or 1% | 1h, 1d |
| TAKE/USD | `0x61e4be67372e5dff1b8539cc5441b170ede68a48` | 24 h or 1% | 1h, 1d |
| EGL1/USD | `0xe659636dbe70e9a53f7762d9eef385a4fa528475` | 24 h or 1% | 1h, 1d |
| PUFFER/USD | `0x2bc9c150981d74e24b85c3d714852631928599b4` | 24 h or 1% | 1h, 1d |
| CDL/USD | `0x5036f6f0b618b5eb12452b9fc782c8d2e5e996c9` | 24 h or 1% | 1h, 1d |
| AB/USD | `0xff45b658838fb3afa2d00cca5033258c262f98de` | 24 h or 1% | 1h, 1d |
| SPA/USD | `0x9a97167364dd00f8bc52e346ccb8d603e0b9a740` | 24 h or 1% | 1h, 1d |
| OIK/USD | `0xfe9a5337da82a0fc8476c2a1edc292d729d29f71` | 24 h or 1% | 1h, 1d |
| USDT/USD | `0x9dfd7992952bb9e8fb4bc6065fdc3518addc4e8b` | 24 h or 5% | 1h, 1d |
| BUSD/USD | `0x14a20eafffada4d78afeef1185e7317cf98f6a1f` | 24 h or 1% | 1h, 1d |

Excluded: FDUSD (user's decision), VAI (`0x9eec…e20a`, `latestRoundData` reverts). The demo
focuses on BTCB, BNB and ANKR. The feed whitelist and per-feed allowed intervals live in the
contract, set by the admin.

Known accuracy limit: a slow feed's stored price can be up to its deviation trigger (1–5%) away
from the true price. On the slow feeds a round's end price often equals its start price, so Up
(ties go Up) wins. The 1h/1d-only rule limits this. We accept it.

**Flap Pool Launch** (real Portal; source: docs.flap.sh "Pool Launch" pages and
`github.com/flap-sh/FlapPoolLaunchVaultExample`, read 2026-11-25). A Launcher raises funds under
its own rules. When the target is met it calls the Portal's `launchTaxTokenV2`. That single
transaction creates the token, seeds a PancakeSwap V2 pool with the raised quote plus `poolToken`,
and burns the LP. Every token not in the pool must be handed out in that same transaction
(`Distribution`; `ExcessiveRemainder` otherwise). Flap's `MintLauncher` example takes the remainder
into the Launcher itself (target EXPLICIT, strategy = launcher), and contributors claim it there. We
do the same, with losers as the contributors. Facts checked onchain:
- Portal (Hub) `0x000042108465206185A077Edc3F3fd2b49060000`, the same address on 56 and 97.
  Testnet Guardian `0x00004d58290854c5E9880F4b5B1993c6Ad8b0000`, WBNB
  `0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd`, V2 router
  `0xc9D63ddCB9549578057EAB6A83a543DdFEE2b8c3`, token impl
  `0x7777c57ff7dc441c1715b2e36fa581c48B782222`.
- Quote tokens enabled on testnet (`launchQuoteConfig(0, quote)`): **only native BNB**, priced by
  Flap at a fixed **$700**. USDT, BUSD and WBNB are not enabled there. On mainnet, native, USDT and
  USD1 are enabled.
- Creation floors (USD of pool quote): creation `$750 × multiplier × supply / poolToken`,
  "Graduated" `$1,500 × …`. At 50% in the pool and multiplier 1, that's $1,500 ≈ **2.143 BNB** to
  launch at all, and $3,000 ≈ 4.286 BNB to show as Graduated on Flap.
- **No whitelist on testnet.** The testnet Portal (v1.2.0) has creation open (`featureFlags() == 0`),
  so any contract may call `launchTaxTokenV2` directly. Only the `newLauncher` factory route (and
  launching while paused, as on mainnet) needs Flap to enable a factory. **Verified 2026-11-25** on a
  testnet fork: a plain contract, with no factory and no admin calls, locked a salt, launched with
  1B supply, 500M in the pool and 2.15 BNB native quote, and received the other 500M through its
  own `IStrategy.initializeDistribution` (distribution EXPLICIT to itself). Token
  `0xf235…7777`.
- **Tax must be at least 1%.** 0, 50 and 99 bps revert `InvalidTaxBps`; 100 bps (buy and sell)
  passes. `feeConfigs` must add up to 10000 bps.
- Every launch needs a salt whose predicted token address ends in `0x7777`, mined offchain, and
  locked by the launching contract with `lockSalt{value: SALT_LOCK_FEE()}` (0.005 BNB on testnet).

**Chains and the fork.** The demo and every test run on `anvil --fork-url $BSC_TESTNET_RPC_URL`
(chain 97). Consequences:
- Test BNB is unlimited: the dev script (and a dev-only faucet endpoint) uses `anvil_setBalance`.
- A fork freezes the Atlas feeds, so a **feed relay** process copies each used feed's state from
  live testnet into the fork every ~2 s, but only when it changed. Every SingleFeed checked
  (BTCB, BNB, ANKR, CAKE) keeps its whole state in **storage slot `0x32`**, packed as
  `updatedAt (uint48) | startedAt (uint48) | answer (uint80)` from high bits to low. The relay
  reads it with `eth_getStorageAt` and writes it with `anvil_setStorageAt`. The fork's clock follows
  wall-clock time, so `updatedAt` stays meaningful. The relay must fail loudly if a feed's slot
  `0x32` doesn't decode to its `latestAnswer()`.
- Forge tests use `vm.createSelectFork(BSC_TESTNET_RPC_URL)` and skip when the variable is unset,
  as Flap's fork tests do. A paid RPC is advised, because fork tests read a lot of state.

## Approaches considered

- **A. Polymarket-style exchange, one transaction per match.** ERC-1155 shares in user wallets,
  collateral pulled by approval, operator calls `matchOrders` per match. Closest to Polymarket, but one
  transaction (about 3 s) per fill, gas per fill, and a wallet approval per token.
- **B. Deposit balance with batched settlement (chosen).** Deposit once and sign orders with a
  browser trading key. The sequencer matches and confirms instantly, then submits a batch of fills
  every few seconds. The contract re-verifies every fill. Shares are internal balances. Reuses
  biliquid's sequencer soft-confirm design, trading keys, deposit/withdraw flow and frontend shell.
- **C. Fully onchain book, no sequencer.** Rejected: an onchain transaction per order or cancel
  defeats the latency goal.

The user picked B.

## Decided design

### Launch lifecycle

1. **Create** (anyone, one transaction: `Portal.newLauncher{value: SALT_LOCK_FEE}(ourFactory, config)`
   with a pre-mined salt; our Launcher locks the salt and the factory registers the game with
   `Exchange`; see "Flap integration"): memecoin name,
   symbol, image URI; game feed + interval,
   where the interval must be allowed for that feed; **cut** (user's decision): one of 10% (default),
   15%, 20%, 25% or 30%, stored per launch and fixed for its lifetime; **graduation target** in BNB (creator's
   choice, at least `minTarget`); **deadline** (creator's choice). `minTarget` is an
   admin-configurable value (user's decision: $1,500, configurable). Its default is **2.15 BNB**,
   which is Flap's creation floor at the Portal's $700/BNB, rounded up. Below the floor, the real
   Portal reverts the launch (`LaunchLiquidityTooLow`). A target under ≈4.29 BNB launches but shows
   as "New" rather than "Graduated" on Flap. The game's round 0 starts at the next interval boundary (rounds align
   to wall clock: 5m rounds at :00, :05, ...).
2. **Active**: rounds run back to back. Each round's cut adds to `raised`.
3. **Graduate**: when the resolve that pushes `raised ≥ target` lands, the launch graduates in the
   same transaction. That round is the last one, and every round after it is untradable. The whole
   `raised` amount (overshoot included) becomes pool liquidity: `Exchange` (which locked the salt, so
   it must be the one launching) calls `launchTaxTokenV2{value: raised}` with `poolQuote = raised`. Total
   supply is **always 1,000,000,000 tokens and the split is always 50/50** (user's decision, not
   creator-configurable): `poolToken` = 500M goes into the pool, and the other 500M is handed to the
   bilauncher contract in the launch transaction (Flap `Distribution` target EXPLICIT, strategy =
   that contract, implementing `IStrategy.initializeDistribution`), where losers claim it.
   **Tax: 1% buy and sell, 100% burned** (a single DEFLATION fee slot of 10000 bps). The user wanted
   no tax, but the Portal rejects anything below 1%. Burning is the closest to "no tax": nobody
   collects it.
   Opening price = raised / 500M BNB per token.
4. **Fail** (user's decision): the creator also sets a **deadline** at creation. If the deadline
   passes before graduation, the launch fails: the game stops (no round starting after the deadline
   is tradable, and the round in progress at the deadline still resolves normally), and **winners get
   the full 1.00**. Each winner reclaims the cut per winning share that was held back. To support
   this, redeem records `haircutPaid[launch][user] += cut × winningShares`, and the haircut BNB
   stays in `Exchange` until graduation. On failure, `refundHaircut(launch)`
   credits `haircutPaid` back to the user's balance. Loser shares of a failed launch are worth
   nothing.
5. **Claim**: a loser's allocation = `loserShares[user] / totalLoserShares × 50% of supply`, where
   `loserShares` sums the losing shares the user held at the resolution of each of the launch's
   rounds.

### Rounds

- Round k of a launch covers `[start + k·interval, start + (k+1)·interval)`.
- **Price snapshots.** At each boundary t, `snapshot(launchId, k)` (callable by anyone; the keeper
  calls it in the first block at or after t) reads `latestRoundData` and stores `answer`. The read
  is accepted only if `updatedAt <= t + SNAP_TOLERANCE` (5 s) and `block.timestamp <= t + GRACE`
  (60 s). The first accepted call wins. *(Builder-check call: this caps how far anyone, the
  sequencer included, can pick a favourable price to about 5 s after the boundary.)* Round k's end
  price is the snapshot at its end boundary, which is also round k+1's start price ("price to
  beat").
- **Outcome**: Up if `endPrice >= startPrice`, else Down.
- **Void**: if no accepted snapshot exists for either boundary (for example, the feed updated more
  than 5 s after t before anyone snapshotted), the round is void. Every share, Up or Down, redeems
  at 0.50, with no haircut, no pool contribution and no loser shares.
- **Resolve** after `endTime + MAX_LAG` (so every batch stamped before end has landed). Resolve
  adds `cut × outstandingPairs` to `raised`. outstandingPairs = pairs minted − pairs merged, so
  each outstanding winning share sits across from exactly one losing share. If `raised >= target`,
  the launch graduates in the same call.
- **Tradable** only while live **and after the previous round has resolved**:
  `startTime <= batchTimestamp < endTime`, round k−1 resolved (so the price to beat is recorded
  and the launch is known not to have graduated). *(Builder-check call: this leaves a pause of
  about `MAX_LAG` + one block, roughly 15–20 s, at the start of each round. It makes graduation
  clean: no round after the final one ever has positions. The UI shows "Next round opening…"
  during the pause.)* The keeper runs resolve(k) and snapshot together right after
  `end + MAX_LAG`. Trading on upcoming rounds is not in scope.
- **Redeem** (permissionless, for any user list; the keeper batches it): a winning share credits
  `1 − cut` BNB to the holder's balance; a losing share adds to the holder's `loserShares` for the
  launch.

### Order book (Polymarket model)

- One book per round, shown in Up terms. A Down order is the mirror image: Buy Down @ p ≡ Sell Up
  @ (1 − p). The UI shows a single ladder and lets users act in either outcome.
- Prices are whole hundredths of 1 BNB, 0.01–0.99. Shares are 18-decimal amounts. A pair of
  shares (1 Up + 1 Down) is always backed by exactly 1 BNB.
- Three fill types, priced at the maker's price:
  - **Transfer**: Buy X vs Sell X. Shares move one way, BNB the other.
  - **Mint**: Buy Up @ a + Buy Down @ b, with a + b ≥ 1. Both pay, a new pair is created.
  - **Merge**: Sell Up @ a + Sell Down @ b, with a + b ≤ 1. A pair is burned and its 1 BNB is
    paid out.
- Limit orders (resting) and market orders. A market order is IOC with a slippage cap, done the way
  biliquid does it: a place plus a cancel-if-resting group.

### Onchain settlement (contract `Exchange`)

- **Collateral**: native BNB. A payable `deposit()` credits the internal balance immediately.
  Withdrawals and claims send BNB with a reentrancy guard and pull-style accounting. Withdrawals go through a queue the sequencer must process in its
  next batch, auto-cancelling the user's resting orders if needed (biliquid's "Policy A").
  Requests left unprocessed for `FORCE_DELAY` (10 min) can be force-withdrawn by the user, so a
  dead or hostile sequencer cannot trap funds.
- **Sequencer whitelist**: the admin manages `operators`. Only operators can call `submitBatch`.
- **`submitBatch(batch)`** carries: batch timestamp, trading-key authorizations, orders referenced
  by the batch's fills (with signatures), fills (taker order, maker order, amount, fill type), and
  the withdrawal range processed. The contract checks, per fill:
  - the signature: by the owner, or by a trading key that is authorized and not expired;
  - order fields: launch/round/outcome/side; round live at the batch timestamp; expiry; limit
    price respected;
  - fill-type crossing rule (above);
  - `filled[orderHash] + amount <= order.amount`; order not cancelled onchain;
  - balances and positions suffice, with nothing going negative;
  - batch timestamp: `lastBatchTs <= ts <= block.timestamp` and `block.timestamp - ts <= MAX_LAG`
    (15 s), which bounds how far the sequencer can backdate a fill.
  The whole batch reverts if any check fails. The sequencer `eth_call`-simulates each batch before
  sending it.
- **Trading keys**: `AuthorizeKey(owner,key,expiry,nonce)`, signed by the owner (EIP-712, as in
  biliquid's SPEC), is carried in a batch or submitted directly. The contract stores the key's
  expiry. `revokeKey` can be called onchain by the owner.
- **Trust assumption (stated, accepted)**: offchain cancels are honoured by the sequencer. The
  contract cannot see them, the same as Polymarket's operator model. Users can always cancel onchain
  (`cancelOrder(hash)` / `bumpNonce`), and a cancel there always wins.

### Sequencer (Rust, adapted from biliquid `sequencer/`)

- A new pure matching crate (replaces `engine/`): per-round books, the three fill types,
  balance/position mirror, locks for resting orders.
- Soft confirmation as in biliquid `core.rs`: speculate on the in-flight batch, open a window, cut
  every `BATCH_MS` (default 2 s), retry on failure.
- Keeper loop: snapshot at boundaries, resolve after `MAX_LAG`, redeem, trigger graduation, process
  withdrawals.
- Price stream (reads the fork, which the feed relay keeps live): polls each used feed (about every 2 s), keeps a short in-memory history, and pushes
  ticks over WebSocket for the chart.
- HTTP + WS API in the style of biliquid `api.rs`: launches, book per round, trades, user, msgs.

### Frontend (React/Vite, adapted from biliquid `frontend/`)

- **Home**: launch cards with coin, game ("BTC · 5m"), progress bar `raised / target`, live
  round's Up price, and a "Create launch" button.
- **Create launch**: form (name, symbol, image URL, feed, interval filtered by feed, cut (10–30% picker), target ≥
  `minTarget` read from the contract, deadline).
- **Launch page**: the Polymarket layout in the reference screenshot
  ([assets/polymarket-btc-5m.png](assets/polymarket-btc-5m.png); use it for layout only, not
  Polymarket's branding). Header with coin + game; price
  to beat, current price with delta, countdown; live chart with the target line; round strip (past
  outcomes as ▲/▼ dots, live, upcoming); right panel with Buy/Sell, Up/Down prices, amount
  presets, a "win $X" preview **that shows the `1 − cut` payout** (and the cut as a badge, e.g. "10% to launch"), and the order book. Below that:
  launch progress, "your loser shares → est. tokens", and positions.
- **Graduated launch page**: game stopped; token address, PancakeSwap pool price, "Claim N
  tokens", link to the token on Flap's terminal format (display only on the fork).
- **Account**: deposit/withdraw BNB, a dev faucet (fork only, `anvil_setBalance`), trading-key
  session. Amounts show in BNB, with a USD estimate from the BNB/USD feed.

### Flap integration (real Portal, Launcher Factory route)

The Flap track requires "a Launcher Factory, a complete token launch on BSC Testnet, and a custom
launch UI" (hackathon page, read 2026-11-25). This replaces the earlier direct-launch idea.
- `BilauncherLauncherFactory` (on Flap's `LauncherFactoryBase`) deploys one `BilauncherLauncher`
  (on `LauncherBase`, a beacon proxy as in Flap's `MintLauncherFactory`) per launch. Users create a
  launch with `Portal.newLauncher{value: SALT_LOCK_FEE}(factory, abi.encode(LaunchConfig))`. The
  launcher locks the salt, and the factory registers the game with `Exchange`.
- At graduation, `Exchange` sends the raised BNB to the launch's **rail** (`ILaunchRail.launch`).
  The launcher calls `launchTaxTokenV2` (1B supply, 500M in the pool, 1% buy/sell tax burned,
  distribution EXPLICIT to itself) and forwards the 500M to `Exchange`, where losers claim.
- A factory must be opened by Flap (`setLauncherFactoryMultiplier`). On the fork we impersonate
  Flap's admin; on live testnet Flap's team opens it (user to arrange). The demo ends with one real
  graduation on live BSC testnet (about 2.5 tBNB needed).
- The rail interface leaves room for an OpenFour rail later (stretch, BSC-mainnet fork only).

## Left to the builder

- Exact struct layouts, EIP-712 type strings, error names, events, API shapes (record them in a
  `SPEC.md` like biliquid's, which is the single source of truth between contracts, sequencer and
  frontend).
- Rounding: costs are `shares × cents / 100`. Pick rounding that never lets the contract owe more
  than it holds, and test it.
- Gas limits per batch (cap fills per batch), indexer/history storage, chart library (biliquid uses
  lightweight-charts).
- Whether graduated tokens get a swap UI (through the PancakeSwap V2 router on the fork). It's a
  stretch goal: the token must at least be shown as live with a pool price.
- Salt mining (offchain, in the frontend or sequencer; the token address must end in `0x7777`).

## Build organisation

Three independent tracks behind `SPEC.md`: contracts (Foundry), sequencer (Rust), frontend
(React). They run as parallel agents once the plan exists, with no agent starting its own agents
(user's instruction). A final track wires the dev script: fork anvil, deploy, start the feed
relay, sequencer, seed bots and frontend.
