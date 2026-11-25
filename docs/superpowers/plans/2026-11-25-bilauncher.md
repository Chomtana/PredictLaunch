# bilauncher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A memecoin launchpad on a BSC-testnet fork. Each launch runs a Polymarket-style Up/Down
price game. Winners are paid 1 − cut, the cut fills the launch's pool, losers claim the memecoin,
and graduation launches the token through the real Flap Portal.

**Architecture:** One Solidity contract (`Exchange`) holds native-BNB balances, round positions and
launches. It re-verifies every signed order in batches submitted by whitelisted operators and reads
Atlas feeds for round prices. Launches are created through Flap's Pool Launch Portal and **our
Launcher Factory** (required by the Flap track). At graduation, `Exchange` hands the raised BNB to
the launch's **rail** (our `BilauncherLauncher`), which calls `launchTaxTokenV2`. The rail
interface lets an OpenFour rail be added later. A Rust
sequencer matches orders instantly (soft confirmation), cuts batches, and runs the keeper (snapshot,
resolve, redeem, graduate). A React/Vite frontend talks to the sequencer API and the fork RPC. A
feed relay keeps fork prices live.

**Tech Stack:** Foundry (solc 0.8.39 via Soldeer, as in biliquid), Rust (alloy 2.x, axum 0.8,
tokio), React 19 + Vite 8 + viem 2 + lightweight-charts 5, Node ≥ 23 scripts
(`--experimental-strip-types`), anvil fork of BSC testnet.

**Spec:** `docs/superpowers/specs/2026-11-25-bilauncher-design.md` (read it first). Reference
code to adapt: `../biliquid` (`contracts/`, `sequencer/`, `frontend/`, `scripts/dev.sh`, `SPEC.md`).


## ⚠ Amendment A1 (2026-11-25): one market per launch (creator strike + settlement time)

**This overrides every task below wherever they mention rounds.** SPEC.md is already updated; it wins
over any text here. The user replaced recurring Up/Down rounds with: the creator sets a **strike**
and a **settleTime**; Up wins iff the Atlas price at settlement ≥ strike. One order book per launch.
Unchanged: funds, withdrawals, trading keys, EIP-712 (`Order.round` must be 0), signed orders, batch
fills (transfer/mint/merge), Flap factory/launcher rail, graduation, loser claims, the API style.

Per-track changes:
- **C1, C2:** unchanged (`setFeed(address,bool)`).
- **C3 → "Launch registration, settlement snapshot, resolution":** tests become
  `test_registerValidates` (non-factory, unlisted feed, strike 0, duration < 300 s or > 30 days,
  cut 1200, target < minTarget), `test_snapshotWindow` (same window rules at `settleTime`),
  `test_resolveOutcomes` (price == strike → Up; below → Down; raised = pairs × cut; ≥ target →
  Graduating, else Failed), `test_missedSnapshotVoids` (no snapshot → resolvable after
  settleTime+GRACE, Void, Failed), `test_tradableUntilSettle` (ts < settleTime only, not after
  resolve).
- **C4:** `test_fillAtOrAfterEndReverts` → `test_fillAtOrAfterSettleReverts` (ts == settleTime
  reverts, settleTime−1 passes); `round != 0` reverts (add to `test_rejectsBadOrders`).
- **C5:** remove `refundHaircut`/`haircutPaid`; `test_redeemAfterFailurePaysFull` = a non-void
  market whose raised < target pays winners 1.00; `test_incrementalClaimsSumToLoserSupply` uses one
  market with 3 losers claiming before and after other losers redeem.
- **C6:** the fork test drives the BTCB slot `0x32` once at settlement.
- **S2:** a book per launch (not per round).
- **S3:** a fill joins a batch only if `batch.ts < settleTime` of its launch; cut the open batch
  at any settleTime; drop resting orders at settleTime. Tests `cuts_batch_at_settle_time`,
  `no_fill_at_or_after_settle`, `orders_dropped_at_settle` replace the round ones.
- **S4 keeper:** `snapshot(id)` at the first block ≥ settleTime (retry until +GRACE), `resolve(id)`
  after +MAX_LAG, then redeem all holders, then `graduate` if Graduating. Tests
  `keeper_snapshots_at_settle`, `keeper_resolves_after_lag`, `keeper_redeems_all_holders`,
  `keeper_graduates`, `failed_batch_restores_state`.
- **S5:** API shapes per the updated SPEC (no `:round`; config feeds without intervals).
- **F2 create form:** name, symbol, image URL, feed, **strike** (prefilled with the feed's current
  price, shown in USD), **settlement date/time** (≥ now + 5 min, ≤ 30 days), cut, target. No interval
  or deadline. The card shows "BTC ≥ $100,000 by Nov 26 12:00", a countdown, and projected-raised
  progress.
- **F3 trading page:** the title is the question ("Will BTC be ≥ $100,000 at Nov 26, 12:00?"),
  "Price to beat" = strike, current price with its delta vs strike, a countdown to settlement, and a
  chart with a dashed strike line. **No round strip.** Projected pool = cut × open pairs. After
  settlement: "Settling…" until resolved.
- **F4:** drop the haircut refund. Failed: "Target not reached: winners were paid in full." Void:
  "No settlement price: everyone redeemed at 0.50."
- **I1 seed:** 2 launches, e.g. BTCB strike = current price, settle in 15 min, cut 10%, target
  2.15; and BNB strike = current +1%, settle in 30 min, cut 30%, target 3. The bots quote
  `pUp = Φ((price − strike) / (σ·price·sqrt(timeLeft)))` (σ a constant).
- **I2 e2e:** a launch settling 10 min out; bots mint ≥ 22 BNB of pairs before settlement →
  graduation.
- **Review Focus 1/2** now read "settlement time" instead of "round boundary/round".

---

## Execution layout (user's instruction: parallel agents, no nesting)

```
Task 0 (serial, unblocks all) ──► Track C (contracts: C1→C6) ─┐
                              ├─► Track S (sequencer: S1→S5) ─┼─► Track I (integration: I1→I2)
                              └─► Track F (frontend: F1→F4) ──┘
```
Tracks C, S and F run as three parallel agents after Task 0. Each works only in its own directory
(`contracts/`, `sequencer/` + `core/`, `frontend/`). Every cross-track contract lives in `SPEC.md`
(Task 0). No agent may spawn agents. Any change to `SPEC.md` after Task 0 needs the orchestrator.

## Global Constraints

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
- Timing: `SNAP_TOLERANCE = 5 s`, `GRACE = 60 s`, `MAX_LAG = 15 s`, `FORCE_DELAY = 600 s`; rounds
  align to wall clock (`startTime = (now / interval + 1) * interval`).
- Intervals: 300, 900, 3600, 86400 s, as a bitmask `1=5m 2=15m 4=1h 8=1d`. Fast feeds (BTCB, BNB,
  ANKR) mask `15`; slow feeds mask `12`. The feed list and addresses are in the spec's feed table.
  FDUSD and VAI are excluded.
- Atlas feed state: storage slot `0x32` = `updatedAt(uint48) | startedAt(uint48) | answer(uint80)`,
  high bits to low.
- EIP-712 domain: `name "bilauncher"`, `version "1"`, `chainId 97`, `verifyingContract = Exchange`.
- UI shows amounts in BNB, with a USD estimate from the BNB/USD feed. Use Polymarket's layout only,
  never its name or branding.
- Commit after every task step marked "Commit". Never commit `.env`.

## Review Focus

1. **An order filled right at a round boundary.** A batch whose timestamp is at or after the
   round's end must never settle that round's fills; the sequencer must close the batch at the
   boundary. Pinned by `test_fillAtOrAfterEndReverts` (C4) and `cuts_batch_at_round_start_boundary`
   (S3).
2. **The keeper is late or misses a snapshot.** The round goes void, both sides redeem at 0.50, and
   the next round still opens once its own start snapshot exists. Pinned by
   `test_missedSnapshotVoidsRound` and `test_lateKeeperCatchesUp` (C3).
3. **A withdrawal requested while orders rest.** It is paid `min(requested, balance)`, the
   sequencer cancels the user's resting orders newest-first so it can be paid in full, and nothing
   double-spends. Pinned by `test_withdrawPaysMinOfBalance` (C4) and `withdraw_cancels_newest_first`
   (S3).
4. **Redeem after graduation or failure, and claims made before every round is redeemed.** Loser
   claims are incremental and add up exactly to `LOSER_SUPPLY`. Rounds redeemed after a failure pay
   the full 1.00. Pinned by `test_incrementalClaimsSumToLoserSupply` and
   `test_redeemAfterFailurePaysFull` (C5).
5. **Dust and bad amounts.** Share amounts that aren't multiples of `1e16`, price 0 or 100, an
   expired trading key, and a replayed fill beyond `order.amount` are all rejected by the contract,
   and the sequencer refuses them up front. Pinned by `test_rejectsBadOrders` (C4) and
   `rejects_dust_and_bad_price` (S2).

---

## Shared interface (Task 0 writes this into `SPEC.md` verbatim; it is the cross-track contract)

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
function setFeed(address feed, uint8 intervalMask) external;         // mask 0 = disabled
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

// launches and rounds
struct LaunchConfig { string name; string symbol; string imageURI; address feed; uint32 interval;
                      uint16 cutBps; uint256 target; uint64 deadline; bytes32 salt; }
// Users create a launch with Portal.newLauncher{value: SALT_LOCK_FEE}(factory, abi.encode(LaunchConfig)).
// The factory deploys a BilauncherLauncher (beacon proxy), whose initialize locks the salt, then calls:
function registerLaunch(address rail, address creator, address token, LaunchConfig calldata c)
    external returns (uint256 launchId);                             // onlyFactory; validates c (see rules)
function snapshot(uint256 launchId, uint32 boundary) external;       // boundary k at startTime + k*interval
function resolve(uint256 launchId, uint32 round) external;           // sequential: round-1 must be resolved
function redeem(uint256 launchId, uint32 round, address[] calldata users) external;
function graduate(uint256 launchId) external;                        // Graduating -> Graduated: ILaunchRail(rail).launch{value: raised}(launchId)
function receiveLoserTokens(uint256 launchId, address token, uint256 amount) external; // rail only: pulls 500M
function refundHaircut(uint256 launchId) external;                   // Failed launches, caller's own
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
function roundInfo(uint256 id, uint32 round) external view returns (RoundView memory);
function isTradable(uint256 id, uint32 round, uint64 ts) external view returns (bool);
function balanceOf(address u) external view returns (uint256);
function position(uint256 id, uint32 round, address u) external view returns (uint128 up, uint128 down);
function filled(bytes32 orderHash) external view returns (uint128);
function orderHash(Order calldata o) external view returns (bytes32);
function withdrawQueueLength() external view returns (uint64);
function withdrawProcessed() external view returns (uint64);
```
`LaunchView { creator, rail, feed, interval, cutBps, startTime, deadline, target, raised, status
(0 Active, 1 Graduating, 2 Graduated, 3 Failed), token, totalLoserShares, lastResolved (rounds
resolved count), name, symbol, imageURI }`.

### Rail and Flap contracts

```solidity
interface ILaunchRail { function launch(uint256 launchId) external payable returns (address token, address pool); }

// contracts/src/flap/BilauncherLauncherFactory.sol  (is LauncherFactoryBase)
constructor(address hub, address guardian, address exchange);
// _newLauncher(creator, data): c = abi.decode(data, (LaunchConfig)); deploy BeaconProxy;
//   BilauncherLauncher(l).initialize{value: msg.value}(hub, creator, exchange, c);   // locks salt
//   id = Exchange.registerLaunch(l, creator, predictedToken(c.salt), c); BilauncherLauncher(l).setLaunchId(id)
// launcherDataSchema(): fields name, symbol, imageURI, feed, interval, cutBps, target, deadline, salt

// contracts/src/flap/BilauncherLauncher.sol  (is LauncherBase, IStrategy, ILaunchRail)
function initialize(address hub, address creator, address exchange, LaunchConfig calldata c) external payable; // once
function launch(uint256 launchId) external payable returns (address token, address pool); // only exchange; launchTaxTokenV2{value: msg.value}
function initializeDistribution(address token, uint256 amount, bytes calldata, bytes32) external; // onlyHub, during launch only
// after the Portal call returns, launch() approves and calls exchange.receiveLoserTokens(launchId, token, 500M)
// _description(): name, symbol, quote address(0), target, poolTokenRatio 0.5e18, title "bilauncher prediction launch"
```
`RoundView { startTime, endTime, startPrice, endPrice, startSet, endSet, resolved, outcome (0 Up,
1 Down, 2 Void), pairs }`.

**Rules the contract enforces** (from the spec; one line each):
- Tradable(id, k, ts): status Active ∧ start_k < deadline ∧ start_k ≤ ts < end_k ∧ snapSet[k] ∧
  (k == 0 ∨ resolved[k−1]).
- `snapshot`: block.timestamp ∈ [t, t + GRACE], `updatedAt ≤ t + SNAP_TOLERANCE`, answer > 0, first
  accepted call wins.
- `resolve(k)`: resolved[k−1] (or k == 0), block.timestamp ≥ end + MAX_LAG, and (endSet ∨
  block.timestamp > end + GRACE). Outcome: Void if either snap is missing; else Up iff end ≥ start.
  Non-void: `raised += pairs × cut / 10000` (if not Failed), `totalLoserShares += pairs`. Then
  `raised ≥ target` → Graduating; else if `end_k ≥ deadline` → Failed.
- `redeem`: Up/Down winner credit `win × (10000 − cut) / 10000` and `haircutPaid += win × cut /
  10000` (Failed launch: credit `win` in full); loser `loserShares += lose`; Void: credit
  `(up + down) / 2`. Clears the position. Idempotent per user.
- `registerLaunch` (factory only): feed enabled and interval in its mask, cut in the allowed set,
  `target ≥ minTarget`, `deadline > startTime + interval`, name 1–32 bytes, symbol 1–10 bytes;
  `startTime = (now / interval + 1) * interval`.
- `graduate`: `ILaunchRail(rail).launch{value: raised}(id)`; the rail must call
  `receiveLoserTokens` for exactly `LOSER_SUPPLY` before returning, or `graduate` reverts.
- `claimTokens`: pays `(loserShares − claimedShares) × LOSER_SUPPLY / totalLoserShares`.
- Batch: `lastBatchTs ≤ ts ≤ block.timestamp`, `block.timestamp − ts ≤ MAX_LAG`; apply keys, then
  fills in order, then withdrawals `[withdrawProcessed, withdrawTo)` paid `min(requested,
  balance)` (push with a 10k-gas call; on failure, credit `pendingPayout`). Any failed check
  reverts the whole batch.
- Fill checks: both orders' signatures, not cancelled, `nonce ≥ minNonce[owner]`,
  `expiry ≥ ts`, same launch + round, tradable at ts, `amount % 1e16 == 0`,
  `filled + amount ≤ order.amount` for both. Prices: maker gets exactly `pm`. Transfer: same
  outcome, opposite sides, taker buy ⇒ `pm ≤ pt`, taker sell ⇒ `pm ≥ pt`. Mint: both Buy, opposite
  outcomes, `pt + pm ≥ 100`, taker pays `100 − pm`, `pairs += amount`. Merge: both Sell, opposite
  outcomes, `pt + pm ≤ 100`, taker receives `100 − pm`, `pairs −= amount`.

**Events** (the sequencer indexes these): `Deposited(user, amount)`, `WithdrawRequested(idx, user,
amount)`, `WithdrawPaid(idx, user, requested, paid)`, `KeyAuthorized(owner, key, expiry)`,
`KeyRevoked(owner, key)`, `OrderCancelled(owner, orderHash)`, `MinNonceBumped(owner, minNonce)`,
`LaunchCreated(launchId, creator, feed, interval, cutBps, target, deadline, startTime, token, name,
symbol, imageURI)`, `Snapshot(launchId, boundary, price, updatedAt)`, `RoundResolved(launchId,
round, outcome, pairs, raised)`, `Graduating(launchId)`, `Graduated(launchId, token, raised)`,
`LaunchFailed(launchId)`, `Redeemed(launchId, round, user, credit, loserShares)`,
`TokensClaimed(launchId, user, amount)`, `HaircutRefunded(launchId, user, amount)`,
`BatchSubmitted(batchId, ts, fills)`, `Trade(launchId, round, takerHash, makerHash, kind,
makerPrice, amount)`.

### Sequencer HTTP/WS API (default port 8787; JSON; amounts are decimal strings in wei)

```
GET  /api/status            {lastBatchId, lastBatchTs, pendingFills, inflight:bool, softReversals}
GET  /api/config            {chainId, rpc, exchange, factory, portal, saltLockFee, minTarget, cuts:[1000..3000],
                             feeds:[{address, symbol, intervals:[300,...], fast:bool}], batchMs}
GET  /api/launches          [LaunchSummary]   (launch fields + liveRound, upPrice (best mid, cents|null), progress)
GET  /api/launch/:id        LaunchDetail      (LaunchSummary + rounds: last 20 RoundView + current/next times)
GET  /api/book/:id/:round   {bids:[{price, amount}], asks:[...]}   Up terms, price cents, best first
GET  /api/trades/:id?limit= [{round, price (Up terms), amount, side:"buy"|"sell" (taker, Up terms), ts}]
GET  /api/prices/:feed?since=unixSec  [{t, price}]   price = 18-dec decimal string
GET  /api/user/:addr        {balance, locked, pendingWithdrawals:[...], orders:[OrderView],
                             positions:[{launchId, round, up, down}], launches:[{launchId, loserShares,
                             claimableTokens, haircutPaid}]}
POST /api/msgs              body: [Msg] (atomic group, ≤ 16). Msg =
                             {kind:"place", order:{...all Order fields as strings}, sig, ifResting?:false}
                           | {kind:"cancel", owner, orderHash, nonce, sig, ifResting?:bool}
                           | {kind:"authorizeKey", owner, key, expiry, nonce, sig}
                            → 200 {results:[{orderHash?, fills:[{price, amount, kind}], resting:amount}]}
                            → 400 {error:"code", message, index}
POST /api/faucet            {address} → anvil_setBalance(address, 1000 BNB)   (only with --dev-faucet)
WS   /ws                    client sends {sub:{launchId?, round?, user?}};
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

---

## Task 0: Repo scaffold, SPEC.md, EIP-712 library, shared vectors (orchestrator, serial)

(Also vendors the Flap base contracts into `contracts/src/flap/vendor/`, so Track C starts from them.)

**Files:**
- Create: `SPEC.md`, `README.md`, `Cargo.toml` (workspace: `core`, `sequencer`), `contracts/foundry.toml`,
  `contracts/remappings.txt`, `contracts/src/lib/Eip712.sol`, `contracts/test/Vectors.t.sol`,
  `fixtures/eip712-vectors.json`
- Modify: `.gitignore` (already present)

**Interfaces:**
- Produces: `library Eip712 { struct Order {...}; function hashOrder(Order memory) internal pure returns (bytes32);
  function hashAuthorizeKey(address owner,address key,uint64 expiry,uint64 nonce) internal pure returns (bytes32); }`
  plus the `ORDER_TYPEHASH`, `AUTHORIZE_KEY_TYPEHASH` and `CANCEL_TYPEHASH` constants; the vectors file.

- [ ] **Step 1:** Write `SPEC.md`: copy the "Shared interface" section of this plan plus the Global
  Constraints, under the title "bilauncher — shared interface spec (single source of truth)".
- [ ] **Step 2:** Create `contracts/foundry.toml` copying biliquid's (solc 0.8.39, prague, optimizer
  200, Soldeer deps `forge-std 1.17.0`, `@openzeppelin-contracts 5.7.0`, no SP1), with
  `via_ir = true` and `fs_permissions = [{access="read-write", path="../fixtures"}]`. Run
  `forge soldeer install`.
- [ ] **Step 3:** Write the failing test `contracts/test/Vectors.t.sol::test_writeVectors`. It
  builds 3 orders (Up/Buy/50, Down/Sell/37, amount 2.5e18), 1 AuthorizeKey and 1 Cancel on the
  domain `(bilauncher, 1, 97, 0x00000000000000000000000000000000000E8C4A)`, signs them with
  `vm.sign`, writes `../fixtures/eip712-vectors.json`, and asserts `ecrecover(hash, sig) ==
  signer` for each.
- [ ] **Step 4:** Implement `contracts/src/lib/Eip712.sol` (typehash strings exactly as in the spec,
  domain separator from params).
- [ ] **Step 5:** Run `cd contracts && forge test --mt test_writeVectors -vv`. Expected: PASS, and the
  vectors file exists.
- [ ] **Step 6:** Create the root `Cargo.toml` workspace (members `core`, `sequencer`; workspace deps
  copied from biliquid minus k256 pin/borsh) and a `README.md` stub with the `.env` instructions.
- [ ] **Step 7: Commit** `chore: scaffold, SPEC.md, EIP-712 lib and shared vectors`.

---

## Track C — contracts (`contracts/`)

Test helpers (C1 creates them, later tasks reuse): `test/helpers/MockFeed.sol` (settable
`answer/updatedAt`, AggregatorV3 `latestRoundData`), `test/helpers/MockRail.sol` (an
`ILaunchRail` that keeps the BNB, mints a 1B OZ ERC20 and calls `receiveLoserTokens`), and
`test/helpers/Base.t.sol` (deploys `Exchange(owner)`, `setFactory(address(this))` so tests call
`registerLaunch` directly with a MockRail, registers a MockFeed with mask 15, funds Alice/Bob/Carol,
and has helpers `_sign(order, pk)` and `_warpTo(t)`). The real Flap factory and launcher are tested
in C6 on the fork.

### Task C1: Admin, deposits, withdrawal queue

**Files:** Create `contracts/src/Exchange.sol`, `contracts/src/interfaces/{ISingleFeed.sol,
ILaunchRail.sol}`, the test helpers above, `contracts/test/Funds.t.sol`.

**Interfaces:** Produces the constructor, `setOperator/setFeed/setMinTarget`, `deposit`,
`requestWithdraw`, `forceWithdraw`, `claimPayout`, `balanceOf`, the withdraw queue views, and the
internal `_payOut(address,uint256)` (10k-gas push, fallback `pendingPayout`).

- [ ] **Step 1:** Failing tests in `Funds.t.sol`: `test_depositCredits`;
  `test_requestWithdrawQueues` (idx 0, 1…); `test_forceWithdrawAfterDelay` (reverts before 600 s,
  pays `min(amount, balance)` after it, and `submitBatch` later skips it);
  `test_onlyOwnerAdmin`; `test_payoutToRevertingReceiverGoesPending`.
- [ ] **Step 2:** Run `forge test --mc Funds`. Expected: FAIL (missing symbols).
- [ ] **Step 3:** Implement. Withdraw queue entries `{user, amount, requestedAt, done}`;
  `ReentrancyGuard` on all payouts; `minTarget = 2.15 ether` in the constructor.
- [ ] **Step 4:** Run `forge test --mc Funds`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(contracts): admin, deposits, withdrawal queue`.

### Task C2: Trading keys and order validity

**Files:** Modify `Exchange.sol`; Test `contracts/test/Keys.t.sol`.

**Interfaces:** Consumes `Eip712` (Task 0). Produces `authorizeKey`, `revokeKey`, `cancelOrder`,
`bumpMinNonce`, `orderHash`, and internal `_checkSig(Order, bytes sig, uint64 ts) returns (bytes32
hash)` and `_applyKeyAuth(KeyAuth)` (replay-protected by `usedKeyNonce[owner][nonce]`).

- [ ] **Step 1:** Failing tests: `test_vectorsMatch` (reads `../fixtures/eip712-vectors.json`, and
  `orderHash` equals the vector after deploying at the vector's `verifyingContract` with
  `deployCodeTo`); `test_keySignsUntilExpiry`; `test_revokedKeyRejected`; `test_keyAuthReplayRejected`;
  `test_cancelledAndBelowMinNonceRejected`.
- [ ] **Step 2:** Run `forge test --mc Keys`. Expected: FAIL.
- [ ] **Step 3:** Implement (OZ `ECDSA.recover`, signatures 65 bytes).
- [ ] **Step 4:** Run `forge test --mc Keys`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(contracts): trading keys, onchain cancels`.

### Task C3: Launch creation, snapshots, resolution

**Files:** Modify `Exchange.sol`; Test `contracts/test/Rounds.t.sol`.

**Interfaces:** Produces `registerLaunch`, `snapshot`, `resolve`, `isTradable`, `getLaunch`,
`roundInfo`, `launchCount`.

- [ ] **Step 1:** Failing tests:
  - `test_registerValidates`: rejects a non-factory caller, unlisted feed, an interval not in the
    mask (slow feed with 300), cut 1200, `target < minTarget`, `deadline ≤ startTime + interval`.
    Accepts a valid one: `startTime == (now/300+1)*300`.
  - `test_snapshotWindow`: before t reverts; `updatedAt = t+6` reverts; `updatedAt = t+5` accepted;
    a second call reverts; after `t+61` reverts.
  - `test_resolveOutcomes`: end == start → Up; end < start → Down; `raised` grows by `pairs × cut`
    (set pairs through a batch in C4, or a test-only harness `ExchangeHarness.setPairs`).
  - `test_missedSnapshotVoidsRound`: no end snap; resolve allowed only after `end+GRACE`; outcome
    Void.
  - `test_lateKeeperCatchesUp`: warp 5 rounds ahead, resolve 0..4 in order; resolve(3) before
    resolve(2) reverts; round 5 tradable only after its snapshot.
  - `test_tradableGating`: not before the start snap; not before the previous round resolves; not
    once `start ≥ deadline`; not after Graduating.
  - `test_failsAtDeadline`: resolving the round whose end ≥ deadline with `raised < target` →
    Failed and emits `LaunchFailed`.
- [ ] **Step 2:** Run `forge test --mc Rounds`. Expected: FAIL.
- [ ] **Step 3:** Implement per the SPEC rules (snapshots keyed by boundary index).
- [ ] **Step 4:** Run `forge test --mc Rounds`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(contracts): launches, snapshots, round resolution`.

### Task C4: `submitBatch` — fills and withdrawals

**Files:** Modify `Exchange.sol`; Test `contracts/test/Batch.t.sol`.

**Interfaces:** Produces `submitBatch`, `position`, `filled`, the `Trade` and `BatchSubmitted`
events.

- [ ] **Step 1:** Failing tests (each builds orders with `_sign`):
  - `test_mintFill`: Alice Buy Up @60 ×1e18 (maker), Bob Buy Down @45 (taker) → Alice pays 0.60,
    Bob pays 0.40, pairs = 1e18, positions up = 1e18 / down = 1e18.
  - `test_transferFill`: Bob Sell Down @50 → Carol Buy Down @55 (taker): Carol pays 0.50 (maker
    price), shares move.
  - `test_mergeFill`: Sell Up @70 + Sell Down @25 → payouts 0.70 / 0.30, pairs decrease.
  - `test_limitViolationsRevert`: each fill type with a crossing condition off by 1 cent reverts.
  - `test_fillAtOrAfterEndReverts`: `ts == end` reverts; `ts == end − 1` passes.
  - `test_batchTsBounds`: ts > block.timestamp, ts < lastBatchTs, `block.timestamp − ts = 16` all
    revert.
  - `test_rejectsBadOrders`: amount 1e16+1, price 0, price 100, an expired key, overfill (two fills
    summing > `order.amount`), a cancelled order. Each reverts the batch.
  - `test_withdrawPaysMinOfBalance`: request 5 BNB with balance 3 → paid 3, `WithdrawPaid(…,5,3)`.
  - `test_onlyOperator`.
  - `test_solvencyInvariant`: after a mixed batch of mint/transfer/merge fills and withdrawals
    (no resolution in between), `address(this).balance == Σ balances + Σ pendingPayout + Σ pairs ×
    1 BNB` over every round touched (sum the test's own users and rounds).
- [ ] **Step 2:** Run `forge test --mc Batch`. Expected: FAIL.
- [ ] **Step 3:** Implement. Verify each order's signature once per batch (memory cache by index).
  Positions are packed `{uint128 up; uint128 down}`.
- [ ] **Step 4:** Run `forge test --mc Batch` and `forge build --sizes`. Expected: PASS and Exchange
  < 24,576 bytes. If over, move launch/round logic into `abstract contract Launches` plus external
  library `RoundsLib`. Don't raise the size limit.
- [ ] **Step 5: Commit** `feat(contracts): batch settlement with full onchain checks`.

### Task C5: Redeem, graduation, failure refund, claims

**Files:** Modify `Exchange.sol`; Test `contracts/test/Lifecycle.t.sol`.

**Interfaces:** Produces `redeem`, `graduate`, `receiveLoserTokens`, `claimTokens`,
`refundHaircut`.

- [ ] **Step 1:** Failing tests:
  - `test_redeemWinnerGetsOneMinusCut`: cut 2500, winner of 2e18 shares is credited 1.5 BNB,
    `haircutPaid` = 0.5.
  - `test_graduationCallsRail`: target 2.15, trade enough pairs, resolve → Graduating;
    `graduate` → MockRail received exactly `raised` BNB; Exchange holds 500M; status Graduated; no
    round after it is tradable; a rail that skips `receiveLoserTokens` makes `graduate` revert.
  - `test_incrementalClaimsSumToLoserSupply`: 3 losers across 2 rounds, claims made before and
    after redeeming the second round; the total paid equals 500M exactly (allow ≤ 2 wei of dust per
    claimer, and assert the dust stays in Exchange).
  - `test_receiveLoserTokensOnlyRailOnce`.
  - `test_redeemAfterFailurePaysFull` and `test_refundHaircutAfterFailure`: winners of earlier
    rounds reclaim exactly `haircutPaid`; a second refund pays 0.
  - `test_voidRedeemsHalf`.
- [ ] **Step 2:** Run `forge test --mc Lifecycle`. Expected: FAIL.
- [ ] **Step 3:** Implement (`graduate` is permissionless, `nonReentrant`).
- [ ] **Step 4:** Run `forge test --mc Lifecycle`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(contracts): redeem, Flap graduation, loser claims, failure refunds`.

### Task C6: Flap Launcher Factory + Launcher, fork tests, deploy script

**Files:** Create `contracts/src/flap/BilauncherLauncherFactory.sol`,
`contracts/src/flap/BilauncherLauncher.sol`, `contracts/test/fork/FlapFork.t.sol`,
`contracts/test/fork/FeedFork.t.sol`, `contracts/script/Deploy.s.sol`, `contracts/script/feeds.json`
(the spec's feed table: symbol, address, mask).

**Interfaces:** Consumes the vendored Flap bases (Task 0) and `ILaunchRail`. Produces the factory
and launcher exactly as in SPEC "Rail and Flap contracts", and `Deploy.s.sol` (env `OWNER`,
`OPERATOR`, `OPEN_FACTORY=1` on forks only: impersonation isn't possible in a script, so the dev
script opens it with `cast rpc anvil_impersonateAccount`). It deploys `Exchange(OWNER)` and the
factory `(PORTAL, GUARDIAN, exchange)`, then calls `setFactory`, `setFeed` for every row of
`feeds.json` and `setOperator(OPERATOR)`, and writes `../.dev/deploy.json` `{exchange, factory,
chainId, owner, operator}`.

- [ ] **Step 1:** Failing fork tests (skip without `BSC_TESTNET_RPC_URL`):
  - `FeedFork.test_slot32Layout`: for BTCB, BNB and ANKR, decoding `vm.load(feed, 0x32)` gives
    `latestRoundData` `answer/startedAt/updatedAt`.
  - `FlapFork.test_unopenedFactoryRejected`: `newLauncher` reverts before Flap opens the factory.
  - `FlapFork.test_graduateOnRealPortal`: deploy Exchange + factory, open the factory
    (`vm.prank(IProxyAdmin(0x0000Ed588dfc01749C20bA69b5f8c77d706E0000).owner())`,
    `setLauncherFactoryMultiplier(factory, 10_000, true)`), create a launch through
    `portal.newLauncher{value: fee}(factory, abi.encode(cfg))` with a mined salt (as in
    `ForkBase._mineSalt`), `vm.store` the BTCB feed slot `0x32` to drive snapshots, run rounds
    through batches until `raised ≥ 2.15 BNB`, then `graduate`. Afterwards the token ends in `7777`,
    `portal.getLauncher(launcher).launcherFactory == factory`, Exchange holds 500M, the
    PancakeSwap pair is non-zero (router `0xc9D63ddCB9549578057EAB6A83a543DdFEE2b8c3`
    `factory().getPair(token, WBNB 0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd)`), and
    `description()` parses as Flap's v1 JSON.
- [ ] **Step 2:** Run `forge test --mp "test/fork/*"` with the env set. Expected: FAIL first, PASS
  after Step 3.
- [ ] **Step 3:** Implement the factory and launcher (copy `MintLauncherFactory`/`MintLauncher`
  structure), and fix whatever the real Portal rejects. Write `Deploy.s.sol`.
- [ ] **Step 4:** Run `forge test` (all) and `forge script script/Deploy.s.sol` against a local
  `anvil --fork-url $BSC_TESTNET_RPC_URL`. Expected: all PASS; deploy.json written.
- [ ] **Step 5: Commit** `feat(contracts): Flap Launcher Factory rail, fork tests, deploy script`.

---

## Track S — sequencer (`core/` pure crate, `sequencer/` service)

Adapt biliquid's `sequencer/` (axum app, WS fan-out, chain polling) and the *ideas* of its
`core.rs`. The engine is gone: the contract is the validator, and the sequencer mirrors its rules.

### Task S1: `bilauncher-core` types, ABI, EIP-712

**Files:** Create `core/Cargo.toml`, `core/src/{lib.rs, types.rs, abi.rs, eip712.rs}`, Test
`core/tests/vectors.rs`.

**Interfaces:** Produces `struct Order { owner: Address, launch_id: U256, round: u32, outcome:
Outcome, side: Side, price: u8, amount: u128, expiry: u64, nonce: u64 }`, `enum Outcome { Up,
Down }`, `enum Side { Buy, Sell }`, `enum FillKind { Transfer, Mint, Merge }`, `fn
order_hash(&Domain, &Order) -> B256`, `fn recover(&B256, &[u8]) -> Result<Address>`, and
`alloy_sol_types::sol!` bindings for every SPEC struct, function and event (`abi.rs`).

- [ ] **Step 1:** Failing test `vectors.rs::matches_fixture`: parse `../fixtures/eip712-vectors.json`;
  for every order/key/cancel, the hash equals and `recover` returns the signer.
- [ ] **Step 2:** Run `cargo test -p bilauncher-core`. Expected: FAIL.
- [ ] **Step 3:** Implement (alloy `sol!` `Eip712` derive for the typed structs).
- [ ] **Step 4:** Run `cargo test -p bilauncher-core`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): types, ABI bindings, EIP-712`.

### Task S2: Book and matcher (Up terms)

**Files:** Create `core/src/book.rs`; Test `core/tests/book.rs`.

**Interfaces:** Produces `struct Book` (one per (launch, round)) with `fn place(&mut self, o:
RestingOrder) -> MatchResult`, `fn cancel(&mut self, hash) -> Option<RestingOrder>`, `fn
levels(&self) -> (Vec<Level>, Vec<Level>)`; `MatchResult { fills: Vec<PlannedFill { taker: B256,
maker: B256, kind: FillKind, maker_price: u8, amount: u128 }>, resting: u128 }`. Up-terms mapping:
Buy Up @p → bid p; Sell Up @p → ask p; Buy Down @p → ask 100−p; Sell Down @p → bid 100−p. Fill kind
from the two real orders: same outcome → Transfer; both Buy → Mint; both Sell → Merge.
Price-time priority, maker price.

- [ ] **Step 1:** Failing tests: `buy_up_crosses_buy_down_as_mint`; `sell_up_crosses_sell_down_as_merge`;
  `transfer_same_outcome`; `price_time_priority`; `partial_fill_rests_remainder`; `levels_in_up_terms`
  (a Buy Down @30 shows as ask 70); `rejects_dust_and_bad_price` (amount % 1e16 != 0, price 0/100).
- [ ] **Step 2:** Run `cargo test -p bilauncher-core --test book`. Expected: FAIL.
- [ ] **Step 3:** Implement (`BTreeMap<u8, VecDeque<RestingOrder>>` per side).
- [ ] **Step 4:** Run it again. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): Polymarket-style book with transfer/mint/merge`.

### Task S3: State mirror, acceptance, batch cutting

**Files:** Create `core/src/state.rs`, `core/src/batcher.rs`; Test `core/tests/state.rs`.

**Interfaces:** Produces `struct State` (mirror of `balanceOf`, positions, `filled`, `keyExpiry`,
launches/rounds from chain events, locks for resting orders), `fn accept_group(&mut self, msgs:
Vec<Msg>, now: u64) -> Result<Vec<MsgResult>, AcceptError>` (all-or-nothing: run on a clone, commit
on success), `fn on_withdraw_requested(&mut self, idx, user, amount)` (Policy A: cancel the user's
newest resting Buy orders until `free ≥ amount`), and `fn cut(&mut self, now: u64) -> Option<Batch>`.
Batch rules: `ts` = the time of the batch's first fill (or `now` with no fills); a fill joins the
open batch only if its round satisfies `start ≤ batch.ts`, otherwise the open batch is cut first;
the open batch is cut when `now ≥ ts + batch_ms`, at any round end, or when it reaches 200 fills.
Resting orders for round k are dropped at `end_k`. The market order group is `[place, cancel
ifResting]` (as in biliquid: the cancel is kept only if a remainder rests).

- [ ] **Step 1:** Failing tests: `soft_confirm_matches_contract_rules` (the free balance after
  locks is never negative across random place/cancel sequences); `group_is_atomic`;
  `market_order_never_rests`; `withdraw_cancels_newest_first`;
  `cuts_batch_at_round_start_boundary` (two launches, B's round starts after the open batch's ts →
  two batches); `no_fill_at_or_after_round_end`; `orders_dropped_at_round_end`.
- [ ] **Step 2:** Run `cargo test -p bilauncher-core --test state`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it again. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): state mirror, atomic acceptance, boundary-safe batching`.

### Task S4: Chain I/O and keeper

**Files:** Create `sequencer/Cargo.toml`, `sequencer/src/{lib.rs, chain.rs, keeper.rs}`; Test
`sequencer/tests/keeper.rs` (pure schedule tests against a fake `Chain` trait, as in biliquid's
`testutil.rs`).

**Interfaces:** Produces `trait Chain { async fn poll_events(&self, from: u64) -> Result<(Vec<Event>,
u64)>; async fn simulate_batch(&self, &Batch) -> Result<()>; async fn submit_batch(&self, &Batch)
-> Result<B256>; async fn snapshot/resolve/redeem/graduate(...); async fn read_feed(&self, feed) ->
Result<(U256, u64)>; }`, `RpcChain` (alloy, operator key), and `fn keeper_actions(state: &State, now:
u64) -> Vec<KeeperAction>` (pure: snapshot boundaries in `[t, t+GRACE]`, resolve after
`end+MAX_LAG`, in order and catching up, redeem every holder of each resolved round in chunks of
50, graduate when Graduating, include `withdrawTo` = queue length in the next batch).

- [ ] **Step 1:** Failing tests: `keeper_snapshots_on_boundary`; `keeper_resolves_in_order_and_catches_up`;
  `keeper_redeems_all_holders`; `keeper_graduates`; `failed_batch_restores_state` (simulate fails →
  the batch's fills are reverted in the mirror, `soft_reversals += 1`).
- [ ] **Step 2:** Run `cargo test -p bilauncher-sequencer --test keeper`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it again. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sequencer): chain I/O and keeper`.

### Task S5: API, WebSocket, price stream, dev faucet, binary

**Files:** Create `sequencer/src/{api.rs, app.rs, prices.rs, main.rs}`; Test `sequencer/tests/api.rs`.

**Interfaces:** Implements every endpoint in the SPEC API section exactly. CLI (env prefix
`BILAUNCHER_`): `--rpc`, `--public-rpc`, `--exchange`, `--operator-key`, `--port 8787`, `--batch-ms
2000`, `--poll-ms 1000`, `--dev-faucet`. The price stream polls `latestRoundData` for every feed
used by a launch, plus BNB/USD, every 2 s; it keeps 24 h of ticks in memory and pushes them over WS.

- [ ] **Step 1:** Failing tests (tower `oneshot` against the fake chain): `status_shape`; `config_shape`; `place_and_book`;
  `group_error_reports_index`; `user_view_after_fill`; `ws_pushes_on_change`; `faucet_disabled_by_default`.
- [ ] **Step 2:** Run `cargo test -p bilauncher-sequencer --test api`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `cargo test --workspace`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sequencer): HTTP/WS API, price stream, dev faucet`.

---

## Track F — frontend (`frontend/`)

Start from a copy of biliquid's `frontend/` config: `package.json` deps (rename the package to
`bilauncher-frontend`), `vite.config.ts` (proxy `/api` and `/ws` to `BILAUNCHER_API`),
`tsconfig.json`, oxlint, vitest, and fonts. Reuse `lib/wallet.ts` (including the dev wallet),
`lib/tradingKey.ts` (storage key prefix `bilauncher:`) and `lib/format.ts`. Dark theme in the spirit
of the reference screenshot (`docs/superpowers/specs/assets/polymarket-btc-5m.png`), with our own
name "bilauncher".

### Task F1: Libraries — config, API client, EIP-712, units, salt mining

**Files:** Create `frontend/src/lib/{api.ts, eip712.ts, units.ts, salt.ts, chain.ts}` and tests
`*.test.ts`.

**Interfaces:** Produces TS types mirroring every SPEC API shape; `orderHash(domain, order)`,
`signOrder`, `signCancel`, `signAuthorizeKey`; `units.ts`: `cost(amount, price)`, `payout(amount,
cutBps)`, `toShares(bnbStake, price)` (rounded down to 1e16), `upTerms(outcome, side, price)`;
`salt.ts`: `mineSalt(seed): Promise<Hex>` in a Web Worker (CREATE2 clone address of TOKEN_IMPL by
PORTAL ends in `7777`); `chain.ts`: viem `exchangeAbi` and `portalAbi` (`newLauncher`,
`SALT_LOCK_FEE`) plus `createLaunch(cfg)` (encodes `LaunchConfig`, calls `newLauncher`), `deposit`,
`requestWithdraw`, `claimTokens` and `refundHaircut` writers.

- [ ] **Step 1:** Failing tests: `eip712.test.ts` matches `../fixtures/eip712-vectors.json`;
  `units.test.ts` (cost 1e18 @60 = 0.6e18; payout 2e18 at 2500 = 1.5e18; `toShares` floors to
  1e16; `upTerms(Down, Buy, 30) = {side: ask, price: 70}`); `salt.test.ts` (the mined salt's
  predicted address ends in `7777`, checked against viem `getContractAddress` with opcode CREATE2
  and the EIP-1167 bytecode for TOKEN_IMPL).
- [ ] **Step 2:** Run `pnpm vitest run`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm vitest run && pnpm lint && pnpm build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(frontend): libs for API, EIP-712, units, salt mining`.

### Task F2: App shell, home (launch list), create launch

**Files:** Create `frontend/src/{App.tsx, main.tsx, state.tsx, styles.css}`,
`components/{Header.tsx, LaunchCard.tsx, CreateLaunch.tsx, Account.tsx}`; Test
`components/CreateLaunch.test.tsx`.

**Interfaces:** Hash routing: `#/` home, `#/launch/:id`, `#/create`. Home is a grid of
`LaunchCard`s (image, name/symbol, "BTC · 5m", cut badge "10% to launch", progress `raised /
target` BNB with a USD estimate, live round Up ¢, status chip Active/Graduated/Failed, deadline
countdown). Create form: name ≤ 32, symbol ≤ 10, image URL, feed select (from `/api/config`),
interval options filtered by the feed's intervals, cut picker 10/15/20/25/30 (default 10), target ≥
`minTarget`, deadline (datetime, > first round end); submit mines a salt, then creates the launch
through `Portal.newLauncher{value: saltLockFee}(factory, abi.encode(LaunchConfig))` (Portal ABI
from SPEC). The Account drawer has deposit/withdraw BNB, the faucet button (when
the API allows it), and trading-key session status with an "Enable trading" button (one
AuthorizeKey signature).

- [ ] **Step 1:** Failing test `CreateLaunch.test.tsx`: picking a slow feed hides 5m/15m; target
  below minTarget disables submit; the default cut is 10%.
- [ ] **Step 2:** Run `pnpm vitest run`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm vitest run && pnpm build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(frontend): home launch list, create launch, account`.

### Task F3: Launch trading page

**Files:** Create `components/{LaunchPage.tsx, PriceHeader.tsx, PriceChart.tsx, RoundStrip.tsx,
TradePanel.tsx, OrderBook.tsx, Positions.tsx, LaunchProgress.tsx}`; Test
`components/TradePanel.test.tsx`.

**Interfaces:** Layout as in the reference screenshot. The header shows coin + game title
("BTC Up or Down 5m") and the round time range. "Price to beat" (round start snapshot), "Current
price" with ▲/▼ delta, and an MM:SS countdown to round end, or "Next round opening…" while not
tradable. The chart is a lightweight-charts line of `/api/prices` + WS ticks, with a dashed price
line at the price to beat. The round strip shows past outcomes as ▲/▼ dots (Void as ●), the live
round, and the next 3 times. The trade panel has Buy/Sell tabs; Up ¢ / Down ¢ buttons from the best
prices; a market mode with presets 0.05/0.25/1 BNB and "win X BNB" = `payout(toShares(stake,
price), cutBps)`; a limit mode with price + shares; and the cut badge. The order book is a single
Up-terms ladder with an Up/Down toggle (Down = mirrored). Below: Positions (current and unredeemed
rounds) and LaunchProgress (raised/target bar, "your loser shares → ≈ N tokens" = `loserShares /
totalLoserShares × 500M`). Market orders are sent as the `[place, cancel ifResting]` group.

- [ ] **Step 1:** Failing test `TradePanel.test.tsx`: stake 1 BNB at Up 60¢ with cut 10% shows "win
  1.49 BNB" (1.66 shares floored to 1.66e18 → payout 1.494 → shown at 2 dp); Sell tab with no
  position disables submit; not tradable shows "Next round opening…".
- [ ] **Step 2:** Run `pnpm vitest run`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm vitest run && pnpm build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(frontend): Up/Down trading page`.

### Task F4: Graduated and failed states

**Files:** Create `components/{GraduatedPanel.tsx, FailedPanel.tsx}`; Modify `LaunchPage.tsx`; Test
`components/GraduatedPanel.test.tsx`.

**Interfaces:** Graduated: the game area is replaced by the token address (copy button), the pool
price `raised / 500M` BNB, "Claim N tokens" (`claimTokens`), and a stretch link to swap through
PancakeSwap V2. Failed: "Launch did not reach its target. Winners are refunded the cut." with
"Refund X BNB" (`refundHaircut`). Graduating: "Launching on Flap…".

- [ ] **Step 1:** Failing tests: the claim button shows `claimableTokens` from `/api/user`; it's
  disabled at 0; the failed panel shows `haircutPaid`.
- [ ] **Step 2:** Run `pnpm vitest run`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm vitest run && pnpm lint && pnpm build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(frontend): graduated and failed launch views`.

---

## Track I — integration (after C, S and F; orchestrator or one agent)

### Task I1: Feed relay, seed bots, dev script

**Files:** Create `frontend/scripts/feed-relay.ts`, `frontend/scripts/seed.ts`, `scripts/dev.sh`;
Test `frontend/scripts/feed-relay.test.ts`.

**Interfaces:**
- `feed-relay.ts --live <BSC_TESTNET_RPC_URL> --fork <rpc> --feeds <addr,...>`: every 2 s, it reads
  slot `0x32` from live, and if it changed, calls `anvil_setStorageAt` on the fork. At startup, it
  asserts the decoded answer equals the live `latestAnswer()` for every feed (exits non-zero
  otherwise).
- `seed.ts --api --rpc --deploy .dev/deploy.json [--live]`: creates 2 launches (BTCB 5m cut 10%
  target 2.15; BNB 15m cut 30% target 3), funds 3 bots (anvil #5–#7) with 1000 BNB, deposits 200
  each, authorizes keys, and in `--live` mode quotes both sides around `pUp = clamp(0.5 + k·(price −
  priceToBeat)/priceToBeat · sqrt(roundLen/timeLeft), 0.03, 0.97)`. The bots take liquidity often
  enough that a launch graduates within ~30 rounds.
- `scripts/dev.sh` (adapt biliquid's): `source .env` (fail if `BSC_TESTNET_RPC_URL` is unset) →
  `anvil --fork-url $BSC_TESTNET_RPC_URL --chain-id 97 --block-time 1` → `forge script Deploy`
  (OWNER = anvil #0, OPERATOR = anvil #9) → open the factory on the fork (`anvil_impersonateAccount`
  the Portal ProxyAdmin owner, `cast send … setLauncherFactoryMultiplier(factory, 10000, true)`)
  → feed relay → sequencer `--dev-faucet` → seed `--live` →
  Vite. Same flags as biliquid (`--no-seed`, `--no-live`, `--no-frontend`).

- [ ] **Step 1:** Failing test `feed-relay.test.ts`: `decodeSlot32(word)` returns `{answer, startedAt,
  updatedAt}` for the live sample `0x…6b06acdc00006b06acdb0c7761a96bd5c96d58f0` = `{58870597613665873910000n,
  1795599579, 1795599580}`.
- [ ] **Step 2:** Run `pnpm vitest run scripts`. Expected: FAIL.
- [ ] **Step 3:** Implement the three files.
- [ ] **Step 4:** Run `scripts/dev.sh --no-frontend`. Expected: "bilauncher local demo is up",
  `/api/launches` lists 2 launches, and within 1 round `/api/launch/0` shows a resolved round.
- [ ] **Step 5: Commit** `feat: feed relay, seed bots, one-command fork demo`.

### Task I2: End-to-end smoke and README

**Files:** Create `scripts/e2e.sh`; Modify `README.md`.

- [ ] **Step 1:** `scripts/e2e.sh` runs dev.sh with `--no-frontend --no-live`. A driver
  (`frontend/scripts/e2e.ts`) creates a BTCB 5m launch (cut 10%, target 2.15 BNB) and has bots
  mint at least 11 BNB of pairs per round, so the target is reached in 2 rounds. It waits for
  Graduated, then asserts: the token ends in `7777`, a PancakeSwap pair exists, a loser claims > 0
  tokens, a winner's balance rose by `(1 − cut)` per winning share, and
  `/api/status.softReversals == 0`. No time-scaling shortcuts: real 300 s rounds.
- [ ] **Step 2:** Run `scripts/e2e.sh`. Expected: "E2E OK" in under 15 minutes.
- [ ] **Step 3:** README: what it is, the `.env` setup, `scripts/dev.sh`, the MetaMask custom network
  (chain 97, `http://127.0.0.1:8545`, never mix it with the real testnet), and the dev wallet.
- [ ] **Step 4: Commit** `test: end-to-end graduation on the fork; README`.

### Task I3: Live BSC testnet launch (Flap track requirement)

**Prerequisites (user):** Flap's team has opened our factory on testnet, and the deployer holds
≥ 2.5 tBNB (2.15 target + fees + gas).

- [ ] **Step 1:** `forge script Deploy --rpc-url $BSC_TESTNET_RPC_URL --broadcast` (without
  `OPEN_FACTORY`), and record the addresses in `deployments/bsc-testnet.json`.
- [ ] **Step 2:** Run the sequencer and frontend against live testnet (no feed relay needed), create
  one BTCB 5m launch with target 2.15, trade it to graduation with the bots, and confirm on BscScan
  testnet: the `newLauncher` tx, the `launchTaxTokenV2` tx, the token `…7777`, and the PancakeSwap pair.
- [ ] **Step 3:** Put the tx links in the README "Live testnet launch" section. **Commit**.

### Stretch (only after I3): OpenFour rail

An `OpenFourRail` implementing `ILaunchRail` on a BSC-mainnet fork with a custom preset (OpenFour
is deployed only on mainnet; custom presets need their governance). Not planned in detail; open a
new brainstorm when the core is done.
