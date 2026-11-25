# bilauncher — shared interface spec (single source of truth)

Everything that crosses the contracts ⇄ sequencer ⇄ frontend boundary is defined here. If you change it,
every side changes. Design rationale: `docs/superpowers/specs/2026-11-25-bilauncher-design.md`.
Build plan: `docs/superpowers/plans/2026-11-25-bilauncher.md`.

## Layout

```
contracts/   Foundry: Exchange, Flap Launcher Factory + Launcher (rail), vendored Flap bases (src/flap/)
core/        Rust lib: types, ABI bindings, EIP-712, book/matcher, state mirror, batcher (pure)
sequencer/   Rust bin: chain I/O, keeper, HTTP/WS API, price stream
frontend/    React/Vite UI + scripts (feed relay, seed bots)
fixtures/    eip712-vectors.json (written by contracts/test/Vectors.t.sol; read by all three)
scripts/     dev.sh (fork demo), e2e.sh
```

## Constants and global rules

- Chain: anvil fork of BSC testnet, `chainId 97`, RPC from `.env` `BSC_TESTNET_RPC_URL`. Fork tests
  `vm.createSelectFork(vm.envString("BSC_TESTNET_RPC_URL"))` and **skip** when it's unset.
- Collateral: **native BNB only**. 1 Up share + 1 Down share are always backed by exactly 1 BNB.
- Prices: whole hundredths (`uint8` 1..99), in the order's own outcome terms.
- Share amounts: 18-decimal, **must be a multiple of `SHARE_UNIT = 1e16`**. This makes every cost
  (`amount × price / 100`), payout (`amount × (10000 − cutBps) / 10000`) and void payout
  (`amount / 2`) exact, with no rounding anywhere. Anything else is rejected.
- Cut (bps): one of `1000, 1500, 2000, 2500, 3000`, default 1000, fixed per launch.
- `minTarget`: admin-configurable, default `2.15 ether` (BNB).
- Memecoin: `totalSupply = 1_000_000_000e18`, `poolToken = 500_000_000e18`, losers'
  `LOSER_SUPPLY = 500_000_000e18`; tax 100 bps buy and sell (the Portal rejects < 100), `taxDuration
  30 days`, `antiFarmerDuration 1 days`, one DEFLATION slot of 10000 bps; quote `address(0)`;
  `dexId 0`; distribution EXPLICIT to the Launcher itself (as in Flap's `MintLauncher`), and the
  Launcher forwards the 500M to `Exchange`; creator shown via `LaunchExtensionHelper.encodeCreator`.
- Flap (same address on 56/97): Portal `0x000042108465206185A077Edc3F3fd2b49060000`, testnet Guardian
  `0x00004d58290854c5E9880F4b5B1993c6Ad8b0000`, token impl
  `0x7777c57ff7dc441c1715b2e36fa581c48B782222`; token address must end in `0x7777`;
  `SALT_LOCK_FEE()` read live (0.005 BNB on testnet). **Launches must go through
  `Portal.newLauncher(ourFactory, data)`** (Flap track rule: "must use a Launcher Factory,
  demonstrate a complete token launch on BSC Testnet, and provide a custom launch UI"). A factory
  must be enabled by Flap (`setLauncherFactoryMultiplier`): on the fork we impersonate the
  ProxyAdmin `owner()`; on live testnet the user asks Flap's team.
- Flap base contracts are vendored from `github.com/flap-sh/FlapPoolLaunchVaultExample` `src/flap/`
  (`LauncherBase`, `LauncherFactoryBase`, `LauncherHelper`, `LaunchExtensionHelper`, `ILauncher`,
  `IPortal`, `IStrategy`, `Distribution`, `IVaultSchemas`, `LaunchVaultAddresses`). The reference
  pair is `src/launcher/MintLauncher.sol` + `MintLauncherFactory.sol` (beacon proxy per launch).
- **Market model (changed 2026-11-25, user's decision): one binary market per launch.** The creator
  sets a **strike** (price to beat, same 18-decimal units as the feed's `answer`) and a **settlement
  time**. Up (outcome 0) wins iff the settlement price ≥ strike; otherwise Down (outcome 1) wins.
  No recurring rounds. `Order.round` stays in the EIP-712 type for vector stability and **must be
  0**.
- Timing: `SNAP_TOLERANCE = 5 s`, `GRACE = 60 s`, `MAX_LAG = 15 s`, `FORCE_DELAY = 600 s`;
  `MIN_DURATION = 300 s`, `MAX_DURATION = 30 days` (settleTime − creation time).
- Feeds: any enabled feed (the spec's feed table: BTCB, BNB, ANKR and the slow feeds; FDUSD and VAI
  excluded). `setFeed(feed, enabled)`.
- Atlas feed state: storage slot `0x32` = `updatedAt(uint48) | startedAt(uint48) | answer(uint80)`,
  high bits to low.
- EIP-712 domain: `name "bilauncher"`, `version "1"`, `chainId 97`, `verifyingContract = Exchange`.
- UI shows amounts in BNB, with a USD estimate from the BNB/USD feed. Use Polymarket's layout only,
  never its name or branding.
- Commit after every task step marked "Commit". Never commit `.env`.

## Interfaces

### EIP-712 (domain above)

```
Order(address owner,uint256 launchId,uint32 round,uint8 outcome,uint8 side,uint8 price,uint128 amount,uint64 expiry,uint64 nonce)
    outcome 0=Up 1=Down; side 0=Buy 1=Sell; price 1..99; amount multiple of 1e16
AuthorizeKey(address owner,address key,uint64 expiry,uint64 nonce)     signed by owner only
Cancel(address owner,bytes32 orderHash,uint64 nonce)                    offchain only (sequencer), owner or key
```
`orderHash` = the EIP-712 digest of the Order. A signature is valid if `recover == owner`, or
`recover` is a key with `keyExpiry[owner][key] >= batch.ts`.

### Contract `Exchange` (contracts/src/Exchange.sol) — external surface

```solidity
constructor(address owner);

// admin (owner)
function setFactory(address factory) external;                       // the only address allowed to registerLaunch
function setOperator(address op, bool on) external;
function setFeed(address feed, bool enabled) external;
function setMinTarget(uint256 bnb) external;                         // default 2.15 ether

// funds
function deposit() external payable;
function requestWithdraw(uint256 amount) external returns (uint64 idx);
function forceWithdraw(uint64 idx) external;                         // after FORCE_DELAY, if unprocessed
function claimPayout() external;                                     // pulls `pendingPayout` when a push failed

// keys and onchain cancels
function authorizeKey(address key, uint64 expiry) external;
function revokeKey(address key) external;
function cancelOrder(Order calldata o) external;                     // owner only
function bumpMinNonce(uint64 minNonce) external;                     // orders with nonce < minNonce are dead

// launches (one binary market each)
struct LaunchConfig { string name; string symbol; string imageURI; address feed; uint256 strike;
                      uint64 settleTime; uint16 cutBps; uint256 target; bytes32 salt; }
// Users create a launch with Portal.newLauncher{value: SALT_LOCK_FEE}(factory, abi.encode(LaunchConfig)).
// The factory deploys a BilauncherLauncher (beacon proxy), whose initialize locks the salt, then calls:
function registerLaunch(address rail, address creator, address token, LaunchConfig calldata c)
    external returns (uint256 launchId);                             // onlyFactory; validates c (see rules)
function snapshot(uint256 launchId) external;                        // settlement price, window [settleTime, settleTime+GRACE]
function resolve(uint256 launchId) external;                         // after settleTime+MAX_LAG -> Graduating | Failed
function redeem(uint256 launchId, address[] calldata users) external;
function graduate(uint256 launchId) external;                        // Graduating -> Graduated: ILaunchRail(rail).launch{value: raised}(launchId)
function receiveLoserTokens(uint256 launchId, address token, uint256 amount) external; // rail only: pulls 500M
function claimTokens(uint256 launchId) external;                     // Graduated launches, incremental

// batches
struct SignedOrder { Order order; bytes sig; }
struct KeyAuth { address owner; address key; uint64 expiry; uint64 nonce; bytes sig; }
struct Fill { uint16 taker; uint16 maker; uint8 kind; uint128 amount; } // kind 0 Transfer 1 Mint 2 Merge; indexes into orders
struct Batch { uint64 ts; KeyAuth[] keys; SignedOrder[] orders; Fill[] fills; uint64 withdrawTo; }
function submitBatch(Batch calldata b) external;                     // onlyOperator

// views
function launchCount() external view returns (uint256);
function getLaunch(uint256 id) external view returns (LaunchView memory);
function isTradable(uint256 id, uint64 ts) external view returns (bool);
function projectedRaised(uint256 id) external view returns (uint256); // pairs × cut / 10000 while Active
function balanceOf(address u) external view returns (uint256);
function position(uint256 id, address u) external view returns (uint128 up, uint128 down);
function filled(bytes32 orderHash) external view returns (uint128);
function orderHash(Order calldata o) external view returns (bytes32);
function withdrawQueueLength() external view returns (uint64);
function withdrawProcessed() external view returns (uint64);
```
`LaunchView { creator, rail, feed, strike, settleTime, createdAt, cutBps, target, pairs, raised,
status (0 Active, 1 Graduating, 2 Graduated, 3 Failed), outcome (0 Up, 1 Down, 2 Void; valid once
resolved), settlePrice, settleUpdatedAt, snapped, resolved, token, totalLoserShares, name, symbol,
imageURI }`.

### Rail and Flap contracts

```solidity
interface ILaunchRail { function launch(uint256 launchId) external payable returns (address token, address pool); }

// contracts/src/flap/BilauncherLauncherFactory.sol  (is LauncherFactoryBase)
constructor(address hub, address guardian, address exchange);
// _newLauncher(creator, data): c = abi.decode(data, (LaunchConfig)); deploy BeaconProxy;
//   BilauncherLauncher(l).initialize{value: msg.value}(hub, creator, exchange, c);   // locks salt
//   id = Exchange.registerLaunch(l, creator, predictedToken(c.salt), c); BilauncherLauncher(l).setLaunchId(id)
// launcherDataSchema(): fields name, symbol, imageURI, feed, strike, settleTime, cutBps, target, salt

// contracts/src/flap/BilauncherLauncher.sol  (is LauncherBase, IStrategy, ILaunchRail)
function initialize(address hub, address creator, address exchange, LaunchConfig calldata c) external payable; // once
function launch(uint256 launchId) external payable returns (address token, address pool); // only exchange; launchTaxTokenV2{value: msg.value}
function initializeDistribution(address token, uint256 amount, bytes calldata, bytes32) external; // onlyHub, during launch only
// after the Portal call returns, launch() approves and calls exchange.receiveLoserTokens(launchId, token, 500M)
// _description(): name, symbol, quote address(0), target, poolTokenRatio 0.5e18, title "bilauncher prediction launch"
```
**Rules the contract enforces** (from the spec; one line each):
- `registerLaunch` (factory only): feed enabled, `strike > 0`, `settleTime − now ∈ [MIN_DURATION,
  MAX_DURATION]`, cut in the allowed set, `target ≥ minTarget`, name 1–32 bytes, symbol 1–10 bytes.
- Tradable(id, ts): status Active ∧ ts < settleTime.
- `snapshot(id)`: block.timestamp ∈ [settleTime, settleTime + GRACE], feed `updatedAt ≤ settleTime +
  SNAP_TOLERANCE`, answer > 0, first accepted call wins (stores settlePrice, settleUpdatedAt).
- `resolve(id)`: block.timestamp ≥ settleTime + MAX_LAG and (snapped ∨ block.timestamp > settleTime
  + GRACE). Outcome: Void if not snapped; else Up iff settlePrice ≥ strike. Non-void: `raised =
  pairs × cut / 10000`, `totalLoserShares = pairs`; then `raised ≥ target` → Graduating, else →
  Failed (raised = 0: nothing is held back). Void → Failed.
- `redeem` (permissionless, idempotent per user, clears the position): Void → `(up + down) / 2`.
  Graduating/Graduated → winner credit `win × (10000 − cut) / 10000`, loser `loserShares += lose`.
  Failed (non-void) → winner credit `win` in full (the user's rule: a failed launch pays winners
  1.00).
- `graduate`: `ILaunchRail(rail).launch{value: raised}(id)`; the rail must call
  `receiveLoserTokens` for exactly `LOSER_SUPPLY` before returning, or `graduate` reverts.
- `claimTokens`: pays `(loserShares − claimedShares) × LOSER_SUPPLY / totalLoserShares`.
- Batch: `lastBatchTs ≤ ts ≤ block.timestamp`, `block.timestamp − ts ≤ MAX_LAG`; apply keys, then
  fills in order, then withdrawals `[withdrawProcessed, withdrawTo)` paid `min(requested,
  balance)` (push with a 10k-gas call; on failure, credit `pendingPayout`). Any failed check
  reverts the whole batch.
- Fill checks: both orders' signatures, not cancelled, `nonce ≥ minNonce[owner]`,
  `expiry ≥ ts`, same launch, `round == 0`, tradable at ts, `amount % 1e16 == 0`,
  `filled + amount ≤ order.amount` for both. Prices: maker gets exactly `pm`. Transfer: same
  outcome, opposite sides, taker buy ⇒ `pm ≤ pt`, taker sell ⇒ `pm ≥ pt`. Mint: both Buy, opposite
  outcomes, `pt + pm ≥ 100`, taker pays `100 − pm`, `pairs += amount`. Merge: both Sell, opposite
  outcomes, `pt + pm ≤ 100`, taker receives `100 − pm`, `pairs −= amount`.

**Events** (the sequencer indexes these): `Deposited(user, amount)`, `WithdrawRequested(idx, user,
amount)`, `WithdrawPaid(idx, user, requested, paid)`, `KeyAuthorized(owner, key, expiry)`,
`KeyRevoked(owner, key)`, `OrderCancelled(owner, orderHash)`, `MinNonceBumped(owner, minNonce)`,
`LaunchCreated(launchId, creator, rail, token, feed, strike, settleTime, cutBps, target, name,
symbol, imageURI)`, `Snapshot(launchId, price, updatedAt)`, `Resolved(launchId, outcome, pairs,
raised)`, `Graduating(launchId)`, `Graduated(launchId, token, raised)`, `LaunchFailed(launchId)`,
`Redeemed(launchId, user, credit, loserShares)`, `TokensClaimed(launchId, user, amount)`,
`BatchSubmitted(batchId, ts, fills)`, `Trade(launchId, takerHash, makerHash, kind, makerPrice,
amount)`.

### Sequencer HTTP/WS API (default port 8787; JSON; amounts are decimal strings in wei)

```
GET  /api/status            {lastBatchId, lastBatchTs, pendingFills, inflight:bool, softReversals}
GET  /api/config            {chainId, rpc, exchange, factory, portal, saltLockFee, minTarget, cuts:[1000..3000],
                             feeds:[{address, symbol}], minDuration, maxDuration, batchMs}
GET  /api/launches          [LaunchSummary]   (LaunchView fields + upPrice (best mid, cents|null),
                                               projectedRaised, progress = raised-or-projected / target)
GET  /api/launch/:id        LaunchDetail      (LaunchSummary + currentPrice, lastTrades)
GET  /api/book/:id          {bids:[{price, amount}], asks:[...]}   Up terms, price cents, best first
GET  /api/trades/:id?limit= [{price (Up terms), amount, side:"buy"|"sell" (taker, Up terms), ts}]
GET  /api/prices/:feed?since=unixSec  [{t, price}]   price = 18-dec decimal string
GET  /api/user/:addr        {balance, locked, pendingWithdrawals:[...], orders:[OrderView],
                             positions:[{launchId, up, down}], launches:[{launchId, loserShares,
                             claimableTokens}]}
POST /api/msgs              body: [Msg] (atomic group, ≤ 16). Msg =
                             {kind:"place", order:{...all Order fields as strings}, sig, ifResting?:false}
                           | {kind:"cancel", owner, orderHash, nonce, sig, ifResting?:bool}
                           | {kind:"authorizeKey", owner, key, expiry, nonce, sig}
                            → 200 {results:[{orderHash?, fills:[{price, amount, kind}], resting:amount}]}
                            → 400 {error:"code", message, index}
POST /api/faucet            {address} → anvil_setBalance(address, 1000 BNB)   (only with --dev-faucet)
WS   /ws                    client sends {sub:{launchId?, user?}};
                            server pushes {type:"snapshot", launch?, book?, trades?, user?} on change and
                            {type:"price", feed, t, price} per tick
```
Error codes: `bad_signature, bad_amount, bad_price, not_tradable, insufficient_balance,
insufficient_shares, unknown_order, expired, key_expired, group_too_large`.

### Shared fixture

`fixtures/eip712-vectors.json` (written by Task 0, consumed by the C, S and F tests):
`{domain:{name,version,chainId,verifyingContract}, orders:[{order, hash, signer, sig}],
keys:[{auth, hash, sig}], cancels:[{cancel, hash, sig}]}`. Signers: anvil keys #0 (Alice) and #1
(Bob), plus a trading key generated from `keccak256("bilauncher-key")`.
