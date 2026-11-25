# bilauncher — design

Date: 2026-11-25. Status: draft for approval.

## Intent

A hackathon pivot from biliquid (`../../biliquid`, a ZK-proven spot orderbook on BSC). The secret
problem statement calls for a prediction market, so we rebuild on the same skeleton without ZK.

**The pitch:** a memecoin launchpad where the launch's liquidity is raised by a prediction game.
A creator launches a memecoin and attaches a binary "Up or Down" price game (for example "BTC Up or
Down, 5m"). People bet on rounds of that game through a Polymarket-style order book. Winners are
paid **0.90 per winning share instead of 1.00**. The other 0.10 fills the memecoin's launch pool.
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
- Low latency: a whitelisted backend sequencer matches orders and confirms them instantly. Every
  fill is settled and **fully checked onchain**, with no ZK proof.
- One wallet signature per session (trading keys), then popup-free betting.
- Memecoin launch through a **mock** of Flap's Pool Launch flow (Launcher → Portal), shaped so the
  real Flap Portal can replace it later.

## Non-goals

- ZK proofs, encrypted order data, recovery keys (all of biliquid's ZK machinery is dropped).
- The real Flap integration. Flap's Pool Launch needs a factory audited and enabled by Flap
  (docs.flap.sh, "Pool Launch → Basic mechanism"), so we mock it.
- Mainnet, fees beyond the 10% haircut, multiple collateral tokens, ERC-1155 share tokens.
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

**Flap Pool Launch** (mocked): a Launcher raises funds under its own rules. When the target is met
it calls the Portal's `launchTaxTokenV2`. That single transaction creates the token, adds the raised
quote plus the pool's share of supply as DEX liquidity, and burns the LP. In Flap's `MintLauncher`
example, half the supply goes to the pool and half goes back to contributors pro rata. We mirror
that split.

**Chains.** The demo runs on BSC testnet, against the real Atlas feeds. Local dev runs on anvil with
`MockFeed` contracts. A small script copies live testnet prices into them, because a fork of
testnet would freeze the feeds.

## Approaches considered

- **A. Polymarket-style exchange, one transaction per match.** ERC-1155 shares in user wallets,
  USDT pulled by approval, operator calls `matchOrders` per match. Closest to Polymarket, but one
  transaction (about 3 s) per fill, gas per fill, and a wallet approval per token.
- **B. Deposit balance with batched settlement (chosen).** Deposit USDT once and sign orders with a
  browser trading key. The sequencer matches and confirms instantly, then submits a batch of fills
  every few seconds. The contract re-verifies every fill. Shares are internal balances. Reuses
  biliquid's sequencer soft-confirm design, trading keys, deposit/withdraw flow and frontend shell.
- **C. Fully onchain book, no sequencer.** Rejected: an onchain transaction per order or cancel
  defeats the latency goal.

The user picked B.

## Decided design

### Launch lifecycle

1. **Create** (anyone, one transaction): memecoin name, symbol, image URI; game feed + interval,
   where the interval must be allowed for that feed; **graduation target** in USDT (creator's
   choice, minimum 100 USDT). The game's round 0 starts at the next interval boundary (rounds align
   to wall clock: 5m rounds at :00, :05, ...).
2. **Active**: rounds run back to back. Each round's 10% haircut adds to `raised`.
3. **Graduate**: when the resolve that pushes `raised ≥ target` lands, the launch graduates in the
   same transaction. That round is the last one, and every round after it is untradable. The whole
   `raised` amount (overshoot included) becomes pool liquidity through the mock Portal. Total
   supply is fixed (1,000,000,000 tokens): 50% to the pool, 50% claimable by losers.
4. **Claim**: a loser's allocation = `loserShares[user] / totalLoserShares × 50% of supply`, where
   `loserShares` sums the losing shares the user held at the resolution of each of the launch's
   rounds.

### Rounds

- Round k of a launch covers `[start + k·interval, start + (k+1)·interval)`.
- **Price snapshots.** At each boundary t, the keeper (the sequencer; also callable by anyone) calls
  `snapshot(launchId, k)` within `GRACE = 60 s` after t. The contract reads `latestRoundData` and
  stores `answer`. Round k's end price is the snapshot at its end boundary, which is also round
  k+1's start price ("price to beat").
- **Outcome**: Up if `endPrice >= startPrice`, else Down.
- **Void**: if either snapshot was missed (no call within GRACE), the round is void. Every share,
  Up or Down, redeems at 0.50, with no haircut, no pool contribution and no loser shares.
- **Tradable** only while live: `startTime <= batchTimestamp < endTime`. Trading on upcoming rounds
  is not in scope.
- **Resolve** after `endTime + MAX_LAG` (so every batch stamped before end has landed). Resolve
  adds `0.10 × outstandingPairs` to `raised`. outstandingPairs = pairs minted − pairs merged, so
  each outstanding winning share sits across from exactly one losing share.
- **Redeem** (permissionless, for any user list; the keeper batches it): a winning share credits
  0.90 USDT to the holder's balance; a losing share adds to the holder's `loserShares` for the
  launch.

### Order book (Polymarket model)

- One book per round, shown in Up terms. A Down order is the mirror image: Buy Down @ p ≡ Sell Up
  @ (1 − p). The UI shows a single ladder and lets users act in either outcome.
- Prices in whole cents, 0.01–0.99. Shares are 18-decimal amounts. A pair of shares (1 Up + 1
  Down) is always backed by exactly 1 USDT.
- Three fill types, priced at the maker's price:
  - **Transfer**: Buy X vs Sell X. Shares move one way, USDT the other.
  - **Mint**: Buy Up @ a + Buy Down @ b, with a + b ≥ 1. Both pay, a new pair is created.
  - **Merge**: Sell Up @ a + Sell Down @ b, with a + b ≤ 1. A pair is burned and its 1 USDT is
    paid out.
- Limit orders (resting) and market orders. A market order is IOC with a slippage cap, done the way
  biliquid does it: a place plus a cancel-if-resting group.

### Onchain settlement (contract `Exchange`)

- **Collateral**: mock USDT (18 dec, mintable by a faucet on testnet). `deposit` credits the
  internal balance immediately. Withdrawals go through a queue the sequencer must process in its
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
- Price stream: polls each used feed (about every 2 s), keeps a short in-memory history, and pushes
  ticks over WebSocket for the chart.
- HTTP + WS API in the style of biliquid `api.rs`: launches, book per round, trades, user, msgs.

### Frontend (React/Vite, adapted from biliquid `frontend/`)

- **Home**: launch cards with coin, game ("BTC · 5m"), progress bar `raised / target`, live
  round's Up price, and a "Create launch" button.
- **Create launch**: form (name, symbol, image URL, feed, interval filtered by feed, target ≥
  100).
- **Launch page**: the Polymarket layout in the reference screenshot. Header with coin + game; price
  to beat, current price with delta, countdown; live chart with the target line; round strip (past
  outcomes as ▲/▼ dots, live, upcoming); right panel with Buy/Sell, Up/Down prices, amount
  presets, a "win $X" preview **that shows the 0.90 payout**, and the order book. Below that:
  launch progress, "your loser shares → est. tokens", and positions.
- **Graduated launch page**: game stopped; token address, pool price, "Claim N tokens".
- **Account**: deposit/withdraw, faucet (testnet), trading-key session.

### Mock Flap

- `MockFlapPortal.launchTaxTokenV2`-shaped function: deploys a plain ERC20, seeds a minimal
  constant-product `MockPool` (USDT/token), and burns the LP.
- `MemeLauncher` (one per launch, created by a `MemeLauncherFactory` the way Flap's
  `LauncherFactoryBase` works): receives the haircut USDT, calls the Portal at graduation, holds the
  losers' 50% and serves claims.

## Left to the builder

- Exact struct layouts, EIP-712 type strings, error names, events, API shapes (record them in a
  `SPEC.md` like biliquid's, which is the single source of truth between contracts, sequencer and
  frontend).
- Rounding: costs are `shares × cents / 100`. Pick rounding that never lets the contract owe more
  than it holds, and test it.
- Gas limits per batch (cap fills per batch), indexer/history storage, chart library (biliquid uses
  lightweight-charts).
- Whether `MockPool` gets a swap UI. It's a stretch goal: the token must at least be shown as
  live with a pool price.

## Build organisation

Three independent tracks behind `SPEC.md`: contracts (Foundry), sequencer (Rust), frontend
(React). They run as parallel agents once the plan exists, with no agent starting its own agents
(user's instruction). A final track wires the local dev script and the BSC testnet deploy.
