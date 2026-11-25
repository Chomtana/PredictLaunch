# Sequencer notes on SPEC.md

Where the sequencer reads SPEC.md in a way that isn't spelled out, or adds to it.

## Addenda from the orchestrator
- `GET /api/config` returns `factory` (BilauncherLauncherFactory). It comes from `--factory` /
  `BILAUNCHER_FACTORY` (default `0x0…0`). It also returns `devFaucet: bool`.
- Amendment A1 (one market per launch) is implemented: one book per launch, `Order.round` must be 0
  (otherwise `not_tradable`), the keeper runs snapshot → resolve → redeem → graduate per launch, and no
  batch holds a fill whose `ts ≥ settleTime`.

## Contract assumptions (check these during integration)
- **Event `indexed` flags are not in SPEC.** The sequencer decodes logs by signature (topic0) with
  `alloy-dyn-abi`. It tries the leading parameters as the indexed ones first, then every other
  choice, and keeps the first layout that re-encodes exactly to the log data. Any indexing works,
  except an indexed `string`, which is hashed and can't be decoded. The parameter types are the ones
  in `core/src/abi.rs` (for example `WithdrawRequested(uint64,address,uint256)`,
  `LaunchCreated(uint256,address,address,address,address,uint256,uint64,uint16,uint256,string,string,string)`,
  `BatchSubmitted(uint64,uint64,uint256)`). If the contract uses other types, topic0 changes and the
  event is ignored, so the types must match.
- `BatchSubmitted` is completed by decoding the `submitBatch(Batch)` calldata of its transaction.
  That only works when the operator EOA calls the Exchange directly.
- `forceWithdraw` is assumed to emit `WithdrawPaid(idx, user, requested, paid)`. If it doesn't, the
  mirror keeps reserving that withdrawal (the balance shows too low).
- `minTarget()` is assumed to be a public view (the variable behind `setMinTarget`). If the call
  fails, 2.15 BNB is used. `SALT_LOCK_FEE()` is read from the Portal (fallback 0.005 BNB). Both are
  read once at startup.
- `LaunchView.createdAt` comes from the `LaunchCreated` log's `blockTimestamp` (0 if the node omits
  it).
- `LaunchCreated` has no `pairs` field, so `pairs` is the mirror's open pairs (resolved: `Resolved.pairs`).

## API details
- Every amount is a decimal string in wei. Prices are cents (numbers), and `outcome`/`side` are small
  ints. `upPrice` is the best mid ((bid + ask) / 2, which can be x.5), else the last trade, else
  `null`. Addresses are serialized as lowercase hex.
- `POST /api/msgs` result `fills[].price` is the price per share the message's owner paid or received,
  in its own outcome terms: Transfer = maker price; Mint/Merge = 100 − maker price. Results also
  carry `omitted: true` for an `ifResting` cancel whose order no longer rested. The body may be
  `[Msg]` or `{msgs:[Msg]}`.
- Error codes beyond SPEC: `bad_request` (malformed JSON or field, with `index`), `not_found`
  (unknown launch), `faucet_disabled` (404 when `--dev-faucet` is off), `faucet_failed`,
  `poll_failed`. Mapping choices: a duplicate resting order or a fully filled order →
  `bad_amount`; an order cancelled onchain or with `nonce < minNonce` → `expired`; a group larger
  than 16 → `group_too_large` with `index: 16`.
- Extra fields: config `domain`; status `lastError`; LaunchSummary `id` (= `launchId`), `statusName`,
  `tradable`, `projectedRaised`, `progress`; LaunchDetail `currentPrice {t, price}|null`,
  `lastTrades`; trades `kind`; user `free`, `confirmedBalance`, `address`; OrderView
  `{orderHash, launchId, outcome, side, price, amount, filled, remaining, status, expiry, nonce,
  signer}` with `status` one of `open|filled|cancelled|expired` (last 200, newest first; `remaining`
  is non-zero only while open). `POST /api/poke` re-reads the chain at once (useful right after a
  deposit tx).
- WS: the snapshot also carries `status` and `launches`. Both `{sub:{...}}` and a bare
  `{launchId, user}` are accepted, and `launchId` may be a number or a string.
- `/api/prices/:feed` (integration change): points come from the Atlas offchain API (`src/prices.rs`, one
  request per 2 s poll, 5 s timeout, own task so batching never waits) tagged `source: "atlas-api"` with `t` =
  the API timestamp (appended only when it moves); a feed missing from the API or older than 30 s is read
  onchain (`source: "onchain"`, `t` = poll time). `--price-api` / `BILAUNCHER_PRICE_API` (`off` disables).
  `currentPrice` carries `source` too.
- `/api/prices/:feed`: all 18 feeds of the table (plus any other feed a launch uses) are polled every
  2 s. `t` is the poll time (unix seconds), not the feed's `updatedAt`. 24 h of history, ascending.

## Sequencer behaviour worth knowing
- `--batch-ms` is capped at 8 s inside the batcher, so `block.timestamp − ts ≤ MAX_LAG` holds.
- Batches are simulated with `eth_call` at the `pending` block, so anvil uses the current time and
  `ts ≤ block.timestamp` holds.
- A failed batch (simulation or tx) is reversed in the mirror (`softReversals += 1`), and any later
  unsent fill that no longer passes the contract's checks is dropped too (`+1` each). Trading-key
  authorizations carried in a failed batch are dropped as well, so the client has to authorize again.
- A withdrawal request is reserved in the speculative balance right away (`min(requested,
  balance)`), and the user's newest resting orders are cancelled until locks fit (Policy A). The next
  batch carries `withdrawTo` = the known queue length, even if it has no fills.
- After a `Resolved` event the launch shows Graduating/Failed straight away (trading stops). The
  `Graduating`/`LaunchFailed` events confirm it.
- On startup the mirror replays every Exchange log from `--start-block`. Without that flag, it
  binary-searches the first block where the Exchange has code.
