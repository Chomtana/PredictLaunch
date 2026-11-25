//! JSON views (SPEC "Sequencer HTTP/WS API"). Amounts are decimal strings in wei; prices are
//! cents (numbers); outcome/side are small ints.

use std::collections::{HashMap, VecDeque};

use alloy_primitives::{Address, Bytes, B256, U256};
use bilauncher_core::state::{Launch, Msg, State};
use bilauncher_core::{Order, Outcome, Side};
use serde_json::{json, Value};

/// Per feed: (t unix seconds, 18-dec price, source `"atlas-api"` | `"onchain"`), ascending.
pub type Prices = HashMap<Address, VecDeque<(u64, U256, &'static str)>>;

fn to_f64(x: U256) -> f64 {
    x.to_string().parse().unwrap_or(0.0)
}

fn s<T: ToString>(v: T) -> Value {
    Value::String(v.to_string())
}

/// Best mid in Up cents: (bid + ask) / 2, else the last trade, else null.
pub fn up_price(st: &State, id: u64) -> Value {
    if let Some(b) = st.books.get(&id) {
        if let (Some(bid), Some(ask)) = (b.best_bid(), b.best_ask()) {
            return json!((bid as f64 + ask as f64) / 2.0);
        }
    }
    st.trades
        .iter()
        .rev()
        .find(|t| t.launch == id)
        .map_or(Value::Null, |t| json!(t.up_price))
}

pub fn launch_summary(st: &State, l: &Launch, now: u64) -> Value {
    let projected = st.projected_raised(l.id);
    let basis = if l.resolved { l.raised } else { projected };
    let progress = if l.target.is_zero() {
        0.0
    } else {
        to_f64(basis) / to_f64(l.target)
    };
    let pairs = if l.resolved {
        l.resolved_pairs
    } else {
        U256::from(st.ledger.pairs(l.id))
    };
    json!({
        "id": l.id,
        "launchId": l.id,
        "creator": l.creator,
        "rail": l.rail,
        "feed": l.feed,
        "strike": s(l.strike),
        "settleTime": l.settle_time,
        "createdAt": l.created_at,
        "cutBps": l.cut_bps,
        "target": s(l.target),
        "pairs": s(pairs),
        "raised": s(l.raised),
        "status": l.status as u8,
        "statusName": l.status.name(),
        "outcome": l.outcome,
        "settlePrice": s(l.settle_price),
        "settleUpdatedAt": l.settle_updated_at,
        "snapped": l.snapped,
        "resolved": l.resolved,
        "token": l.token,
        "totalLoserShares": s(l.total_loser_shares),
        "name": l.name,
        "symbol": l.symbol,
        "imageURI": l.image_uri,
        "upPrice": up_price(st, l.id),
        "projectedRaised": s(projected),
        "progress": progress,
        "tradable": st.tradable(l.id, now),
    })
}

pub fn launches(st: &State, now: u64) -> Value {
    Value::Array(
        st.launches
            .values()
            .rev()
            .map(|l| launch_summary(st, l, now))
            .collect(),
    )
}

pub fn launch_detail(st: &State, prices: &Prices, id: u64, now: u64) -> Option<Value> {
    let l = st.launches.get(&id)?;
    let mut v = launch_summary(st, l, now);
    v["currentPrice"] = prices.get(&l.feed).and_then(|q| q.back()).map_or(
        Value::Null,
        |(t, p, src)| json!({"t": t, "price": s(p), "source": src}),
    );
    v["lastTrades"] = trades(st, id, 20);
    Some(v)
}

pub fn book(st: &State, id: u64) -> Value {
    let (bids, asks) = st.books.get(&id).map(|b| b.levels()).unwrap_or_default();
    let lv = |v: Vec<bilauncher_core::book::Level>| -> Vec<Value> {
        v.into_iter()
            .map(|l| json!({"price": l.price, "amount": s(l.amount)}))
            .collect()
    };
    json!({ "bids": lv(bids), "asks": lv(asks) })
}

/// Newest first.
pub fn trades(st: &State, id: u64, limit: usize) -> Value {
    Value::Array(
        st.trades
            .iter()
            .rev()
            .filter(|t| t.launch == id)
            .take(limit)
            .map(|t| {
                json!({
                    "price": t.up_price,
                    "amount": s(t.amount),
                    "side": if t.taker_bid { "buy" } else { "sell" },
                    "ts": t.ts,
                    "kind": t.kind.name(),
                })
            })
            .collect(),
    )
}

/// Ascending by `t`.
pub fn prices(p: &Prices, feed: Address, since: u64) -> Value {
    Value::Array(
        p.get(&feed)
            .map(|q| {
                q.iter()
                    .filter(|(t, _, _)| *t >= since)
                    .map(|(t, price, src)| json!({"t": t, "price": s(price), "source": src}))
                    .collect()
            })
            .unwrap_or_default(),
    )
}

pub fn order_view(st: &State, h: &B256) -> Option<Value> {
    let e = st.orders.get(h)?;
    let o = &e.order;
    let status = st.order_status(h);
    let filled = st.ledger.filled(h);
    let remaining = if status == "open" {
        st.books
            .get(&o.launch())
            .and_then(|b| b.get(h))
            .map_or(0, |r| r.remaining)
    } else {
        0
    };
    Some(json!({
        "orderHash": h,
        "launchId": o.launch(),
        "outcome": o.outcome.as_u8(),
        "side": o.side.as_u8(),
        "price": o.price,
        "amount": s(o.amount),
        "filled": s(filled),
        "remaining": s(remaining),
        "status": status,
        "expiry": s(o.expiry),
        "nonce": s(o.nonce),
        "signer": e.signer,
    }))
}

pub fn user(st: &State, u: Address) -> Value {
    let pending: Vec<Value> = st
        .withdrawals
        .values()
        .filter(|w| w.user == u && w.paid.is_none() && w.idx >= st.withdraw_processed)
        .map(|w| json!({"idx": w.idx, "amount": s(w.amount)}))
        .collect();
    let orders: Vec<Value> = st
        .user_orders
        .get(&u)
        .map(|v| {
            v.iter()
                .rev()
                .take(200)
                .filter_map(|h| order_view(st, h))
                .collect()
        })
        .unwrap_or_default();
    let mut positions: Vec<(u64, u128, u128)> = st
        .ledger
        .positions
        .iter()
        .filter(|((_, who), (up, down))| *who == u && (*up > 0 || *down > 0))
        .map(|((l, _), (up, down))| (*l, *up, *down))
        .collect();
    positions.sort();
    let mut launches: Vec<Value> = st
        .launches
        .keys()
        .filter_map(|id| {
            let ls = st.loser_shares.get(&(*id, u)).copied().unwrap_or_default();
            (!ls.is_zero()).then(|| {
                json!({
                    "launchId": id,
                    "loserShares": s(ls),
                    "claimableTokens": s(st.claimable_tokens(*id, u)),
                })
            })
        })
        .collect();
    launches.reverse();
    let balance = st.ledger.balance(u);
    let locked = st.locked_bnb(u);
    json!({
        "address": u,
        "balance": s(balance),
        "locked": s(locked),
        "free": s(balance.saturating_sub(locked)),
        "confirmedBalance": s(st.confirmed.balance(u)),
        "pendingWithdrawals": pending,
        "orders": orders,
        "positions": positions
            .into_iter()
            .map(|(l, up, down)| json!({"launchId": l, "up": s(up), "down": s(down)}))
            .collect::<Vec<_>>(),
        "launches": launches,
    })
}

pub fn status(st: &State, last_error: Option<&str>) -> Value {
    json!({
        "lastBatchId": st.last_batch_id,
        "lastBatchTs": st.last_batch_ts,
        "pendingFills": st.pending_fills(),
        "inflight": st.inflight(),
        "softReversals": st.soft_reversals,
        "lastError": last_error,
    })
}

// ------------------------------------------------------------------------------- parsing

fn field<'a>(v: &'a Value, k: &str) -> Result<&'a Value, String> {
    v.get(k)
        .filter(|x| !x.is_null())
        .ok_or_else(|| format!("missing field {k}"))
}

/// A number given as a JSON number, a decimal string or a 0x-hex string.
fn num<T: TryFrom<U256>>(v: &Value, k: &str) -> Result<T, String> {
    let x = field(v, k)?;
    let u = match x {
        Value::Number(n) => n
            .as_u64()
            .map(U256::from)
            .ok_or_else(|| format!("{k}: not a non-negative integer"))?,
        Value::String(st) => st.parse::<U256>().map_err(|e| format!("{k}: {e}"))?,
        _ => return Err(format!("{k}: expected a number or string")),
    };
    T::try_from(u).map_err(|_| format!("{k}: out of range"))
}

fn address(v: &Value, k: &str) -> Result<Address, String> {
    field(v, k)?
        .as_str()
        .ok_or_else(|| format!("{k}: expected a string"))?
        .parse()
        .map_err(|e| format!("{k}: {e}"))
}

fn bytes(v: &Value, k: &str) -> Result<Vec<u8>, String> {
    let b: Bytes = field(v, k)?
        .as_str()
        .ok_or_else(|| format!("{k}: expected a hex string"))?
        .parse()
        .map_err(|e| format!("{k}: {e}"))?;
    Ok(b.to_vec())
}

pub fn parse_order(o: &Value) -> Result<Order, String> {
    Ok(Order {
        owner: address(o, "owner")?,
        launch_id: num(o, "launchId")?,
        round: num(o, "round").unwrap_or(0),
        outcome: Outcome::from_u8(num(o, "outcome")?).ok_or("outcome must be 0 or 1")?,
        side: Side::from_u8(num(o, "side")?).ok_or("side must be 0 or 1")?,
        price: num(o, "price").map_err(|_| "price must be 1..99".to_string())?,
        amount: num(o, "amount")?,
        expiry: num(o, "expiry")?,
        nonce: num(o, "nonce")?,
    })
}

pub fn parse_msg(v: &Value) -> Result<Msg, String> {
    let kind = field(v, "kind")?.as_str().unwrap_or_default();
    let if_resting = v.get("ifResting").and_then(Value::as_bool).unwrap_or(false);
    match kind {
        "place" => Ok(Msg::Place {
            order: parse_order(field(v, "order")?)?,
            sig: bytes(v, "sig")?,
        }),
        "cancel" => Ok(Msg::Cancel {
            owner: address(v, "owner")?,
            order_hash: field(v, "orderHash")?
                .as_str()
                .unwrap_or_default()
                .parse()
                .map_err(|e| format!("orderHash: {e}"))?,
            nonce: num(v, "nonce").unwrap_or(0),
            sig: bytes(v, "sig")?,
            if_resting,
        }),
        "authorizeKey" => Ok(Msg::AuthorizeKey {
            owner: address(v, "owner")?,
            key: address(v, "key")?,
            expiry: num(v, "expiry")?,
            nonce: num(v, "nonce")?,
            sig: bytes(v, "sig")?,
        }),
        other => Err(format!("unknown kind {other:?}")),
    }
}
