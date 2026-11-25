# Frontend: SPEC readings and assumptions

Where SPEC.md leaves a shape open, the frontend took the readings below. The sequencer should match
them, or tell us so we can change the client (`src/lib/api.ts` is the only place that parses them).

1. **`LaunchSummary.id`.** SPEC says "LaunchView fields + upPrice, projectedRaised, progress", and
   LaunchView has no id. The UI reads `id` (number or decimal string) from every summary/detail and
   from the WS `snapshot.launch`.
2. **Numeric fields** (`id`, `status`, `outcome`, `settleTime`, `createdAt`, `cutBps`, `launchId`)
   are accepted as JSON numbers or decimal strings. Wei amounts and 18-dec prices are decimal strings.
3. **`progress`** is not trusted for display: the UI recomputes it from `projectedRaised` (Active)
   or `raised` (otherwise) over `target`, so it doesn't depend on whether `progress` is 0..1 or %.
4. **`OrderView`** is not defined in SPEC. Assumed `{orderHash, launchId, outcome, side, price
   (cents, own outcome terms), amount, remaining?, filled?, status?}`. Orders with no `status`, or
   `status: "open"`, show as open.
5. **`pendingWithdrawals`** entries are only counted (shape not needed).
6. **Faucet.** `/api/config` has no "faucet enabled" flag in SPEC. The button is always shown; a
   400/404 from `POST /api/faucet` shows an error toast. (An optional `faucet: boolean` is typed.)
7. **BNB/USD price** for USD estimates = the latest `/api/prices/<feed>` point of the feed whose
   `symbol` starts with `BNB/` in `config.feeds`. Feed symbols are expected as `"BTCB/USD"`, etc.
8. **`/api/prices`** is expected in ascending `t` (unix seconds). Trades `ts` may be seconds or ms.
9. **Market orders**: walk the Up-terms book for the stake, then send `[place, cancel ifResting]`
   with `price` = the worst level touched (outcome terms), `amount` floored to 1e16, expiry now + 1 h.
   Limit orders expire at `settleTime`. `round` is always 0.
10. **Graduated view**: PancakeSwap/BscScan links only work for live-testnet launches.
11. **A1 amendment**: no rounds, no interval/deadline, no `refundHaircut` (the original F1 plan listed
    a `refundHaircut` writer; it was dropped with the amendment). The F2 "slow feed hides 5m/15m" test
    became "switching feed re-prefills the strike" and "settlement < 5 min disables submit". The F3
    "Next round opening…" test became "after settlement shows Settling…". The F4 "failed panel shows
    haircutPaid" test became the A1 failed/void messages.
