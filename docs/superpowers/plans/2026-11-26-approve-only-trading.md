# Approve-only Trading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With an ERC20 quote token, a user trades straight from their wallet: one unlimited `approve` (done by "Enable trading"), no deposit, no withdraw.

**Architecture:** In ERC20 mode the Exchange spends a payer's internal `balanceOf` first and pulls the rest from the wallet with `transferFrom`; every credit (sale, merge, redeem) is pushed to the wallet. A fill whose payer can no longer pay is skipped (`FillSkipped`), not reverted, so one user moving funds can't sink a batch. The sequencer's per-user balance becomes `Exchange.funds(u)` = internal + min(wallet, allowance), read at the polled head block. Native-BNB mode keeps today's behaviour exactly.

**Tech Stack:** Solidity 0.8.26 / Foundry, Rust (alloy, axum), React + viem.

**Spec:** this plan (design agreed in chat, 2026-11-26).

## Global Constraints

- Native mode (`quoteToken == address(0)`) behaviour and existing native tests unchanged.
- `deposit` / `requestWithdraw` / `forceWithdraw` / `claimPayout` stay (escape hatch, native mode, leftover internal balance).
- Event ABI additions only: `FillSkipped(uint64 batchId, uint256 index, address user)`; no existing event changes.
- Funds check happens before any state change of a fill (including `filled[]`).

## Review Focus

- User revokes allowance / transfers USDT away after the sequencer matched → that fill skipped, rest of the batch settles, orders of the skipped fill end.
- Same owner on both mint legs → funds check must sum both legs.
- Seller proceeds go to wallet; blocked receiver → `pendingPayout` (existing `_payOut`).
- User who only approved (no events yet) → becomes visible to the sequencer once their user view is fetched (watch set) and polled.
- Funds read fails (RPC hiccup) → keep event-derived balances, don't crash poll.

---

### Task 1: Contract — wallet pull, wallet payout, skip unfundable fills

**Files:**
- Modify: `contracts/src/Exchange.sol` (`_applyFill`, `_transfer`, `_debit`, `redeem` credit, `submitBatch`, new `funds` view, new event)
- Test: `contracts/test/QuoteToken.t.sol`

**Interfaces — Produces:**
- `event FillSkipped(uint64 batchId, uint256 index, address user);`
- `function funds(address[] calldata users) external view returns (uint256[] memory)` — internal + (ERC20: min(token.balanceOf, allowance)).
- `function spendable(address u) public view returns (uint256)` — same for one user.

Steps:
- [ ] Tests (ERC20 mode, users approve but never deposit): `test_tradeFromWalletWithoutDeposit` (mint pulls both legs, exchange token balance == 1e18*pairs), `test_saleProceedsGoToWallet`, `test_mergeProceedsGoToWallet`, `test_redeemPaysWallet`, `test_internalBalanceSpentFirst`, `test_unfundedFillSkippedOthersSettle` (2 fills, payer of fill 0 revoked → FillSkipped(id,0,payer), fill 1 settles, `filled` of fill 0 orders unchanged), `test_sameOwnerMintNeedsBothLegs`, `test_fundsView`.
- [ ] `forge test --match-contract QuoteTokenTest` → new tests fail.
- [ ] Implement: `_canPay(u, amt)` / combined check in `_applyFill` after `isTradable`, before `_addFilled`; on failure emit `FillSkipped(batchCount, i, u)` and return. `_debit` pulls shortfall via `safeTransferFrom` in ERC20 mode. `_credit(u, amt)` = ERC20 → `_payOut`, native → `balanceOf += amt`. Pass fill index into `_applyFill`.
- [ ] Full `forge test` green (native suites untouched).
- [ ] Commit.

### Task 2: Core state — FillSkipped + funds snapshot

**Files:** `core/src/state.rs`, `core/src/abi.rs`

**Interfaces — Produces:**
- `ChainEvent::FillSkipped { batch_id: u64, index: u64, user: Address }`
- `State::tracked_users(&self) -> Vec<Address>` (confirmed balance holders, key owners, order owners, watched)
- `State::watch(&mut self, u: Address)`
- `State::apply_poll(&mut self, events: Vec<ChainEvent>, funds: Option<Vec<(Address, U256)>>, now_ms: u64)` — applies events, overwrites `confirmed.balances` with funds, rebuilds if anything changed.

Steps:
- [ ] Tests: `fill_skipped_not_settled` (FillSkipped then BatchSubmitted of our in-flight batch → skipped fill's effects absent from confirmed, other fill present, trade removed), `funds_snapshot_overrides_balance` (funds lower than locks → Policy A cancels newest buy).
- [ ] Implement; `pending_skips: Vec<u64>` consumed by the next `BatchSubmitted` in `settle_front` / `apply_foreign_batch`.
- [ ] `cargo test -p predictlaunch-core` green. Commit.

### Task 3: Sequencer — read funds at poll head

**Files:** `sequencer/src/chain.rs`, `sequencer/src/app.rs`, `sequencer/src/api.rs`, `sequencer/src/testutil.rs`

**Interfaces — Consumes:** Task 1 `funds`, Task 2 `apply_poll`, `watch`, `tracked_users`, `FillSkipped`.
**Produces:** `Chain::read_funds(&self, users: Vec<Address>, block: u64) -> Result<Option<Vec<U256>>>` (RpcChain: None for native quote; FakeChain: `Inner.funds` map when set, else None).

Steps:
- [ ] Decode `FillSkipped` (EVENTS table + `decode_log`, signature test).
- [ ] `App::poll` reads funds at `next - 1` for `tracked_users()`, logs and ignores read errors, calls `apply_poll`.
- [ ] `GET /api/user/:addr` calls `watch(addr)`; faucet triggers a poll.
- [ ] Test in sequencer: fake funds map drives `/api/user` balance. `cargo test` green. Commit.

### Task 4: Frontend — approve in "Enable trading", remove deposit/withdraw

**Files:** `frontend/src/state.tsx`, `frontend/src/lib/chain.ts`, `frontend/src/components/Account.tsx`, `frontend/src/components/TradePanel.tsx`, `frontend/src/components/FailedPanel.tsx`, `LaunchPage.tsx` copy

Steps:
- [ ] `chain.ts`: `ensureApproval(wallet, pc, account, exchange, quote)` approves `maxUint256` when allowance < 2^128; no-op native.
- [ ] `enableTrading`: ERC20 → `ensureApproval` first, then key signature. Expose `approved` (allowance check) so a missing approval shows "Enable trading".
- [ ] Account: ERC20 mode shows "Available to trade" (wallet funds) and no Deposit/Withdraw tabs; a small "Withdraw leftover exchange balance" only when internal balance > 0. Native mode unchanged.
- [ ] Copy: "deposit first" → "not enough {q} in wallet"; payouts "sent to your wallet".
- [ ] `npm test` + `npx tsc -b` green. Commit.

### Task 5: Docs + end-to-end check

- [ ] SPEC.md / README: approve-only flow, `FillSkipped`, `funds`.
- [ ] Run contracts + Rust + frontend suites; commit.
