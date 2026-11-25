# Contracts: notes against SPEC.md

Things the SPEC left open, or that the real chain forced, and how the contracts handle them.

## Facts found on the BSC-testnet fork

1. **Atlas feeds refuse contract readers.** `latestRoundData()` reverts `OnlyAuthorizedCallerAllowed()` unless
   `msg.sender == tx.origin` or `msg.sender` is an authorized caller (`isAuthorizedCaller`, set by the feed admin
   with `setAuthorizedCallers(address[],bool[])`). The design's "contract reads work" check used `eth_call --from
   <contract>`, where sender == origin. The authorized-caller mapping is storage **slot 1**:
   `keccak256(abi.encode(caller, uint256(1))) = 1` (same on BTCB, BNB, ANKR; pinned by
   `test/fork/FeedFork.t.sol::test_contractReadsNeedAuthorization`).
   - Fork: `script/fork-setup.sh` writes that slot for the Exchange on every feed in `script/feeds.json`.
   - **Live testnet: the Exchange cannot `snapshot` until Atlas authorizes it** (ask the Atlas team to call
     `setAuthorizedCallers([exchange],[true])` on the feed used). Without it `snapshot` reverts, the market goes
     Void at `settleTime + GRACE` and the launch fails (everyone redeems at 0.50), so no graduation.
   - **Chainlink fallback (added in integration):** `setFallbackFeed(atlas, chainlink)`; `snapshot` reads Atlas
     first and, if it reverts or answers <= 0, the Chainlink AggregatorV3 (scaled from `decimals()` to 18). So on live
     testnet BTCB, BNB, CAKE and USDT launches settle on Chainlink until Atlas authorizes the Exchange; the other feeds
     still need Atlas. Pinned by `test/Fallback.t.sol` and `test/fork/ChainlinkFork.t.sol` (live state, Exchange not
     authorized). Note the Chainlink testnet heartbeat is slow: its `updatedAt` can be minutes old at settlement
     (allowed: the rule only bounds it above by `settleTime + SNAP_TOLERANCE`).
2. **The testnet Portal (v1.2.0) does not gate unopened factories.** `newLauncher` and the Launcher's
   `launchTaxTokenV2` both succeed for a factory that was never passed to `setLauncherFactoryMultiplier`, even
   with creation paused. The plan's `test_unopenedFactoryRejected` is therefore impossible; it became
   `test_unopenedFactoryNotGatedOnTestnetPortal`, which pins the observed behaviour (it will fail if Flap adds
   the gate). `test_graduateOnRealPortal` pauses creation and opens the factory, as on mainnet. The dev script
   still opens the factory (`script/fork-setup.sh`).
3. Transfers of the Flap tax token between non-pool addresses are untaxed: the Launcher -> Exchange 500M lands in
   full (`receiveLoserTokens` checks the balance delta).

## Choices where the SPEC was open

- `batchId` in `BatchSubmitted` starts at 1 (`batchCount` after the increment).
- `submitBatch` with `withdrawTo <= withdrawProcessed` processes no withdrawals (no revert);
  `withdrawTo > withdrawQueueLength()` reverts `BadIndex`.
- `requestWithdraw` locks nothing; the batch (or `forceWithdraw`) pays `min(requested, balance)` at processing.
  `forceWithdraw` may only be called by the requester and emits `WithdrawPaid`.
- Every order in `Batch.orders` is fully validated (signature, round == 0, price 1..99, amount multiple of 1e16,
  expiry >= ts, not cancelled, nonce >= minNonce), even if no fill references it.
- `bumpMinNonce` must strictly increase.
- `registerLaunch` also requires `rail != 0` and `creator != 0`; cut must be 1000..3000 in steps of 500.
- `snapshot` only while Active and unresolved. `resolve` can run once.
- `claimTokens` reverts `NothingToClaim` when nothing is owed. `claimableTokens(id, user)` is an extra view.
- `graduate` sets status Graduated before calling the rail (so `receiveLoserTokens` can check it) and reverts
  `LoserTokensMissing` if the rail did not deliver; also checks the returned token equals the registered one.
- Events: no parameter is indexed (matches the sequencer's `core/src/abi.rs`). `Snapshot.updatedAt` is `uint64`
  and `LaunchView.pairs` / `Resolved.pairs` are `uint256`, as in `abi.rs`. Signatures pinned by `test/Abi.t.sol`.
- Extra public views beyond SPEC: `factory`, `operators`, `feedEnabled`, `pendingPayout`, `keyExpiry`,
  `usedKeyNonce`, `cancelled`, `minNonce`, `lastBatchTs`, `batchCount`, `loserShares`, `claimedShares`,
  `loserTokensIn`, `withdrawRequest(idx)`, `DOMAIN_SEPARATOR`, constants.
- Factory extras: `predictedToken(salt)`, `predictedLauncher(salt)`, `beaconImplementation()`.

## Open risk

- The Launcher locks its salt at creation and launches at graduation (up to 30 days later). The fork test covers
  a 10-minute gap; whether the Portal expires salt locks over longer gaps was not checked.
