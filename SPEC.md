# PredictLaunch — shared interface spec (single source of truth)

Everything that crosses the contracts ⇄ sequencer ⇄ frontend boundary is defined here. If you change it,
every side changes. Design rationale: `docs/superpowers/specs/2026-11-25-predictlaunch-design.md`.
Build plan: `docs/superpowers/plans/2026-11-25-predictlaunch.md`.

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
- Collateral: the Exchange's `quoteToken`, fixed at deploy: `address(0)` = native BNB, otherwise an
  18-decimal ERC20 (the dev stack uses Flap's testnet faucet USDT `0x190C989D5665a0e404B444b53CAE9AbCfb600157`,
  on-chain symbol "USD", public `mint`). 1 Up share + 1 Down share are always backed by exactly 1 quote unit
  (1e18). Below, "BNB" amounts mean quote units.
- Prices: whole hundredths (`uint8` 1..99), in the order's own outcome terms.
- Share amounts: 18-decimal, **must be a multiple of `SHARE_UNIT = 1e16`**. This makes every cost
  (`amount × price / 100`), payout (`amount × (10000 − cutBps) / 10000`) and void payout
  (`amount / 2`) exact, with no rounding anywhere. Anything else is rejected.
- Cut (bps): one of `1000, 1500, 2000, 2500, 3000`, default 1000, fixed per launch.
- `minTarget`: admin-configurable, default `2.15 ether`. The Portal refuses a pool quote under ~$1500
  (2.15 BNB native; `1500e18` for the USD token: error `0xa32ef056(provided, min)`), so the deploy script
  sets `1500 ether` for an ERC20 quote.
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
- EIP-712 domain: `name "predictlaunch"`, `version "1"`, `chainId 97`, `verifyingContract = Exchange`.
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
constructor(address owner, address quoteToken);                      // quoteToken: 0 = native; else 18 decimals
function quoteToken() external view returns (address);
function setMinTarget(uint256 amount) external;                      // default 2.15 ether
function setFallbackFeed(address atlasFeed, address chainlinkFeed) external; // Chainlink AggregatorV3 fallback; 0 clears
function fallbackFeed(address atlasFeed) external view returns (address);

// funds
function deposit(uint256 amount) external payable;                   // native: msg.value == amount; ERC20: approve, no value
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
                      uint64 settleTime; uint16 cutBps; uint256 target; bytes32 salt;
                      string question; uint256 marketId; }      // question/marketId: see "Question launches"
// Users create a launch with Portal.newLauncher{value: SALT_LOCK_FEE}(factory, abi.encode(LaunchConfig)).
// The factory deploys a PredictLaunchLauncher (beacon proxy), whose initialize locks the salt, then calls:
function registerLaunch(address rail, address creator, address token, LaunchConfig calldata c)
    external returns (uint256 launchId);                             // onlyFactory; validates c (see rules)
function snapshot(uint256 launchId) external;                        // settlement price, window [settleTime, settleTime+GRACE]
function resolve(uint256 launchId) external;                         // after settleTime+MAX_LAG -> Graduating | Failed
function redeem(uint256 launchId, address[] calldata users) external;
function graduate(uint256 launchId) external;                        // Graduating -> Graduated: rail.launch(launchId, raised) (see below)
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
interface ILaunchRail { function launch(uint256 launchId, uint256 quoteAmount) external payable returns (address token, address pool); }

// contracts/src/flap/PredictLaunchLauncherFactory.sol  (is LauncherFactoryBase)
constructor(address hub, address guardian, address exchange);
// _newLauncher(creator, data): c = abi.decode(data, (LaunchConfig)); deploy BeaconProxy;
//   PredictLaunchLauncher(l).initialize{value: msg.value}(hub, creator, exchange, c);   // locks salt
//   id = Exchange.registerLaunch(l, creator, predictedToken(c.salt), c); PredictLaunchLauncher(l).setLaunchId(id)
// launcherDataSchema(): fields name, symbol, imageURI, feed, strike, settleTime, cutBps, target, salt

// contracts/src/flap/PredictLaunchLauncher.sol  (is LauncherBase, IStrategy, ILaunchRail)
function initialize(address hub, address creator, address exchange, LaunchConfig calldata c) external payable; // once
function launch(uint256 launchId, uint256 quoteAmount) external payable returns (address token, address pool); // only exchange; native: launchTaxTokenV2{value: quoteAmount}; ERC20: approve the Portal for quoteAmount, launchTaxTokenV2 pulls it
function quoteToken() external view returns (address);               // read from the Exchange in initialize
function initializeDistribution(address token, uint256 amount, bytes calldata, bytes32) external; // onlyHub, during launch only
// after the Portal call returns, launch() approves and calls exchange.receiveLoserTokens(launchId, token, 500M)
// _description(): name, symbol, quote address(0), target, poolTokenRatio 0.5e18, title "predictlaunch prediction launch"
```
**Rules the contract enforces** (from the spec; one line each):
- `registerLaunch` (factory only): feed enabled, `strike > 0`, `settleTime − now ∈ [MIN_DURATION,
  MAX_DURATION]`, cut in the allowed set, `target ≥ minTarget`, name 1–32 bytes, symbol 1–10 bytes.
- Tradable(id, ts): status Active ∧ ts < settleTime.
- `snapshot(id)`: block.timestamp ∈ [settleTime, settleTime + GRACE], feed `updatedAt ≤ settleTime +
  SNAP_TOLERANCE`, answer > 0, first accepted call wins (stores settlePrice, settleUpdatedAt).
  Source: the Atlas feed first; if its `latestRoundData()` reverts (live Atlas feeds refuse
  unauthorized contracts) or answers ≤ 0, and `fallbackFeed(feed) != 0`, the Chainlink fallback's
  `latestRoundData()` scaled from its `decimals()` to 18 decimals (strike units). The same
  updatedAt/answer/window rules apply to whichever source is used; with no fallback the Atlas revert
  bubbles up. Emits `Snapshot` (unchanged) then `SnapshotSource(launchId, source)`. Deploy sets
  fallbacks from `contracts/script/feeds.json` (`chainlink` field): BTCB/USD, BNB/USD, BTC/USD, ETH/USD,
  CAKE/USD, USDT/USD (8-decimal testnet aggregators). The Atlas BNB/USD (`0x3957…788d`, replaced
  `0xb3d1…256f` on 2026-11-26), BTC/USD and ETH/USD feeds are open-read (`isOpenRead() == true`), so the
  Exchange reads them directly and their fallback is only a backstop.
- `resolve(id)`: block.timestamp ≥ settleTime + MAX_LAG and (snapped ∨ block.timestamp > settleTime
  + GRACE). Outcome: Void if not snapped; else Up iff settlePrice ≥ strike. Non-void: `raised =
  pairs × cut / 10000`, `totalLoserShares = pairs`; then `raised ≥ target` → Graduating, else →
  Failed (raised = 0: nothing is held back). Void → Failed.
- `redeem` (permissionless, idempotent per user, clears the position): Void → `(up + down) / 2`.
  Graduating/Graduated → winner credit `win × (10000 − cut) / 10000`, loser `loserShares += lose`.
  Failed (non-void) → winner credit `win` in full (the user's rule: a failed launch pays winners
  1.00).
- `graduate`: native: `ILaunchRail(rail).launch{value: raised}(id, raised)`; ERC20: `safeTransfer(rail, raised)`
  then `launch(id, raised)`. Payouts: native pushes with a 10k-gas call, ERC20 with a non-reverting transfer;
  either way a failure goes to `pendingPayout`. The rail must call
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
symbol, imageURI)`, `Snapshot(launchId, price, updatedAt)`, `SnapshotSource(launchId, source)` (not
indexed by the sequencer), `FallbackFeedSet(feed, fallbackFeed)`, `Resolved(launchId, outcome, pairs,
raised)`, `Graduating(launchId)`, `Graduated(launchId, token, raised)`, `LaunchFailed(launchId)`,
`Redeemed(launchId, user, credit, loserShares)`, `TokensClaimed(launchId, user, amount)`,
`BatchSubmitted(batchId, ts, fills)`, `Trade(launchId, takerHash, makerHash, kind, makerPrice,
amount)`.

### Question launches (Cournot) — added 2026-11-26, user's decision

Two launch kinds share everything (Exchange, book, cut, graduation, loser claims, redeem). They differ
only in how the market is defined and settled.

| | Price launch (unchanged) | Question launch (new) |
|---|---|---|
| Config | `feed` enabled, `strike > 0`, `question = ""`, `marketId = 0` | `feed = address(0)`, `strike = 0`, `question` 1–280 bytes, `marketId` = Cournot market id (0 = no match) |
| Outcome 0 / 1 | Up / Down | **YES / NO** (same storage, UI labels differ) |
| Settled by | `snapshot` (Atlas, Chainlink fallback) | resolver `proposeOutcome` + challenge window, or owner `overrideOutcome` |
| Opening price (bots) | `fairUpCents` volatility model | Cournot probability |

The creator sets `settleTime` (same `MIN_DURATION..MAX_DURATION` rule) and is trusted to choose a sensible
one (user's decision, hackathon scope). Cournot is offchain only; nothing about it is verified onchain.

**Contract additions (Exchange):**
```solidity
uint256 public constant QUESTION_DEADLINE = 7 days;   // no proposal by settleTime + this -> resolve() voids
address public resolver;                               // the sequencer operator in the dev stack
uint64  public challengeWindow;                        // default 3600; owner-settable, <= 7 days
function setResolver(address r) external;              // onlyOwner
function setChallengeWindow(uint64 s) external;        // onlyOwner; reverts BadConfig if > 7 days
struct QuestionView { string question; uint256 marketId; bool proposed; uint8 proposedOutcome;
                      uint64 proposedAt; bytes32 evidenceHash; bool final_; }
function getQuestion(uint256 id) external view returns (QuestionView memory); // empty for price launches
function isQuestion(uint256 id) external view returns (bool);                  // feed == address(0)
function proposeOutcome(uint256 id, uint8 outcome, bytes32 evidenceHash) external; // only resolver
function overrideOutcome(uint256 id, uint8 outcome, bytes32 evidenceHash) external; // onlyOwner
event QuestionSet(uint256 launchId, string question, uint256 marketId);   // right after LaunchCreated
event OutcomeProposed(uint256 launchId, uint8 outcome, bytes32 evidenceHash, address by, bool final_);
event ResolverSet(address resolver);
event ChallengeWindowSet(uint64 seconds_);
```
Rules (one line each):
- `registerLaunch`: if `question` is empty → the price rules as before and `marketId` must be 0. Else
  `feed == address(0)`, `strike == 0`, `question` 1–280 bytes; duration, cut, target, name, symbol as
  before. `LaunchView` is unchanged (feed = 0 marks a question launch); question data lives in a
  separate mapping read by `getQuestion`. Emits `LaunchCreated` (feed 0, strike 0) then `QuestionSet`.
- `snapshot` on a question launch reverts `NotPriceLaunch`. `proposeOutcome`/`overrideOutcome` on a
  price launch revert `NotQuestionLaunch`.
- `proposeOutcome`: `msg.sender == resolver` (else `NotResolver`), not resolved, not already proposed
  (`AlreadyProposed`), `block.timestamp >= settleTime + MAX_LAG` (else `TooEarly`), outcome ∈ {0 YES,
  1 NO, 2 VOID} (else `BadOutcome`). Stores proposal with `proposedAt = now`, `final_ = false`.
- `overrideOutcome`: owner, not resolved, `block.timestamp >= settleTime + MAX_LAG`, outcome ∈ {0,1,2};
  replaces any proposal and sets `final_ = true` (resolvable immediately).
- `resolve` for a question launch: `now >= settleTime + MAX_LAG` and one of: `final_`; or `proposed` and
  `now >= proposedAt + challengeWindow`; or no proposal and `now > settleTime + QUESTION_DEADLINE`
  (→ VOID). Else `TooEarly`. The chosen outcome then goes through the same code path as a price launch
  (VOID → Failed; else raised = pairs × cut, ≥ target → Graduating, else Failed).
- `LaunchConfig` gains `string question; uint256 marketId` at the **end**; the factory's
  `launcherDataSchema()` lists them too. Every encoder (frontend, seed, e2e, fork tests) passes them.
- Deploy: `setResolver(operator)`; dev stack `setChallengeWindow(120)` so a demo settles in minutes.

**Cournot client (sequencer, `sequencer/src/cournot.rs`).** Base `COURNOT_API_BASE` (default
`https://interface.cournot.ai`), paths `/intelligence/v1/resolve` and `/intelligence/v1/probability`
(from Cournot's own client, `github.com/Cournot-AI/cournot-skills`). `COURNOT_MODE=live|mock` (**default
live**), `COURNOT_API_KEY` optional (header `COURNOT-API-KEY`; never logged). No x402 wallet flow: a 402
in live mode is reported as `payment_required`.
- `resolve(message, limit≤10)` → POST `{message, limit}` → `{code:0, data:{markets:[{matching_confidence,
  market_info:{id, title, description, start_time, end_time, market_outcome, market_outcome_price}}]}}`.
  Free. **Always live, in both modes** (it costs nothing). Facts from the 2026-11-26 probe:
  `market_outcome` is the side label ("YES"), `market_outcome_price` the live YES price, not a result;
  closed markets disappear; confidence is not a reliable filter (wrong cities scored 0.76).
  **`market_info.id` is a per-response handle, not a stable id** (found on the fork run 2026-11-26: the
  same Boston market came back as 6 different ids). The stable key is `(title, end_time)`. Whenever the
  sequencer needs a launch's market it re-resolves the claim (limit 10) and matches: same id → same
  (title, end_time) as the remembered market; only when no market is remembered yet: title equal to the
  claim → top result if confidence ≥ 0.9; else none (a remembered market that is no longer listed
  matches nothing, so a launch is never tracked or settled on another market). The fresh id is what
  goes into `market_ids`; the matched `market_info` is remembered in `launch-<id>.json`. The onchain `marketId` is the id seen at creation
  (informational only). `POST /api/cournot/probability` accepts an optional `market: {title, endTime}`
  (the creator's pick) so a preview remembers it.
- `probability(message, [marketId])` → POST `{message, market_ids}`. Live: parse leniently,
  `point = data.result.point_estimate ?? data.probability.point_estimate ?? data.probability (number)`,
  `basis = data.basis ?? data.probability.basis`, `result = data.result ?? data.probability`; keep the
  raw body. Mock: no network call to `probability`; `point` = the matched market's live
  `market_outcome_price` from a `resolve` (0.5 if not found), `result = {point_estimate, mock:true}`,
  `basis = {primary_anchor:{source:"mock", summary:"<market title> trades at <p>", market_id},
  limitations:["Simulated oracle (COURNOT_MODE=mock): no Cournot probability call was made."]}`.

**Oracle record** (normalized; what the API serves and what the UI shows):
```
OracleRecord { launchId|null, claim (exact text sent), marketId, market (market_info|null),
               probability (0..1|null), result (object|null), basis (object|array|null),
               source: "cournot-live" | "mock", fetchedAt (unix s), error|null, raw|null }
```
Stored as JSON under `--oracle-dir` (default `.dev/oracle`): `launch-<id>.json`, `price-<id>.json`
(`[{t, price}]` from the tracker), `settle-<id>.json` (the evidence the resolver proposed, whose
`keccak256` of the exact file bytes is `evidenceHash`).

**Sequencer behaviour.**
- On a new question launch: reuse a cached preview record for the same `(claim, marketId)` if one
  exists (so a creator's preview isn't charged twice), else call `probability` once. Never more than one
  opening call per launch, even across restarts (the file is the cache).
- Tracker: every 60 s, for each unresolved question launch with `marketId > 0`, `resolve(question)`;
  if the market id is in the results, append `{t, price: market_outcome_price}`.
- Resolver (keeper): for an unresolved, unproposed question launch with `now >= settleTime + MAX_LAG`:
  take the last tracked price; ≥ 0.97 → YES, ≤ 0.03 → NO. Else, at most once per launch and only if
  `mode == mock` or `COURNOT_API_KEY` is set, call `probability` again; ≥ 0.97 / ≤ 0.03 decides. Else do
  nothing (the owner settles with `overrideOutcome`, e.g. `frontend/scripts/settle.ts`). On a decision,
  write `settle-<id>.json` and send `proposeOutcome(id, outcome, keccak256(file))`. After that the normal
  keeper resolves (once the window passes), redeems and graduates.
- Keeper: never `snapshot` a question launch; `resolve` it per the question rule above.

**API additions.**
```
POST /api/cournot/resolve      {message}            → {markets:[{matchingConfidence, id, title, description,
                                                       startTime, endTime, yesPrice}]}   (free; live)
POST /api/cournot/probability  {message, marketId}  → OracleRecord (launchId null; cached by (message, marketId))
GET  /api/launch/:id/oracle    → {opening: OracleRecord|null, prices:[{t, price}], settlement: OracleRecord|null,
                                  proposal: {proposed, outcome, proposedAt, evidenceHash, final, challengeEndsAt}|null}
GET  /api/config               + {cournotMode: "live"|"mock", challengeWindow, questionDeadline}
LaunchSummary                  + {kind: "price"|"question", question|null, marketId|null,
                                  oracleProbability (0..1|null), oracleSource|null}
```
Errors: `cournot_unavailable` (network/5xx), `payment_required` (402), `bad_question` (empty or > 280
bytes, or Cournot code 4100). Rate-limit both POSTs (e.g. 1 request / 2 s per IP).

**Frontend.** Create form: a "Price" / "Question" switch. Question mode: question text → "Find
markets" (resolve) → list (title, end time, YES price, confidence; the creator must pick one, or "no
match" → marketId 0) → "Get Cournot odds" (probability preview: headline %, `result` fields, the full
`basis` as tables with links, a "simulated" badge when `source == "mock"`) → settlement time (prefilled
with the market's end time when it is within limits) → launch. Launch page for a question launch:
question as the title, YES/NO in place of Up/Down everywhere, a Cournot panel (exact claim, probability,
evidence, limitations, fetched at, source badge, oracle-vs-book gap in cents) in place of the price
chart, and a settlement panel (proposal, outcome, challenge countdown, evidence link). Cards show the
question and "YES x¢".

**Bots.** `seed.ts` also creates one question launch: it resolves `"Will it rain in Boston on <tomorrow>?"`
via `/api/cournot/resolve`, takes the first result, settles in 20 min, and quotes around
`round(oracleProbability × 100)` (clamped 3..97) instead of `fairUpCents`. `settle.ts --launch N
--outcome yes|no|void` (owner key) calls `overrideOutcome`.

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
GET  /api/prices/:feed?since=unixSec  [{t, price, source?}]   price = 18-dec decimal string;
                             source "atlas-api" (Atlas offchain API, CoinMarketCap-backed: one POST
                             https://api.atlasoracle.io/oracle/user/v1/oracle-feed/search
                             {"page":1,"rows":50,"platformId":293} every 2 s, matched by
                             supportPlatform[platformId 293].contractAddress, t = API timestamp) or
                             "onchain" (latestRoundData, t = poll time) when the API fails or its point
                             is > 30 s old. Chart only: settlement always uses the onchain snapshot.
GET  /api/user/:addr        {balance, locked, pendingWithdrawals:[...], orders:[OrderView],
                             positions:[{launchId, up, down}], launches:[{launchId, loserShares,
                             claimableTokens}], keys:[{key, expiry}]}  (keys: trading keys the
                             sequencer accepts, onchain or pending; the UI drops a stored key
                             missing here, e.g. after a dev-fork restart)
POST /api/msgs              body: [Msg] (atomic group, ≤ 16). Msg =
                             {kind:"place", order:{...all Order fields as strings}, sig, ifResting?:false}
                           | {kind:"cancel", owner, orderHash, nonce, sig, ifResting?:bool}
                           | {kind:"authorizeKey", owner, key, expiry, nonce, sig}
                            → 200 {results:[{orderHash?, fills:[{price, amount, kind}], resting:amount}]}
                            → 400 {error:"code", message, index}
POST /api/faucet            {address} → anvil_setBalance(address, 1000 BNB)   (only with --dev-faucet)
WS   /ws                    client sends {sub:{launchId?, user?}};
                            server pushes {type:"snapshot", launch?, book?, trades?, user?} on change and
                            {type:"price", feed, t, price, source} per tick
```
Error codes: `bad_signature, bad_amount, bad_price, not_tradable, insufficient_balance,
insufficient_shares, unknown_order, expired, key_expired, group_too_large`.

### Shared fixture

`fixtures/eip712-vectors.json` (written by Task 0, consumed by the C, S and F tests):
`{domain:{name,version,chainId,verifyingContract}, orders:[{order, hash, signer, sig}],
keys:[{auth, hash, sig}], cancels:[{cancel, hash, sig}]}`. Signers: anvil keys #0 (Alice) and #1
(Bob), plus a trading key generated from `keccak256("predictlaunch-key")`.
