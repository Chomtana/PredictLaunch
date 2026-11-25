//! One Polymarket-style order book per launch, shown in Up terms.
//!
//! Buy Up @p → bid p; Sell Up @p → ask p; Buy Down @p → ask 100−p; Sell Down @p → bid 100−p.
//! The fill kind comes from the two real orders (same outcome → Transfer; both Buy → Mint; both
//! Sell → Merge), price-time priority, and the maker's price (in the maker's own outcome terms)
//! applies. These crossing rules are exactly the contract's: Transfer `pm ≤ pt` (taker buy) /
//! `pm ≥ pt` (taker sell); Mint `pt + pm ≥ 100`; Merge `pt + pm ≤ 100`.

use std::collections::{BTreeMap, HashMap, VecDeque};

use alloy_primitives::{Address, B256};

use crate::types::{FillKind, Outcome, Side, SHARE_UNIT};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RestingOrder {
    pub hash: B256,
    pub owner: Address,
    pub outcome: Outcome,
    pub side: Side,
    /// In the order's own outcome terms.
    pub price: u8,
    pub remaining: u128,
}

impl RestingOrder {
    pub fn is_bid(&self) -> bool {
        matches!(
            (self.outcome, self.side),
            (Outcome::Up, Side::Buy) | (Outcome::Down, Side::Sell)
        )
    }
    pub fn up_price(&self) -> u8 {
        match self.outcome {
            Outcome::Up => self.price,
            Outcome::Down => 100 - self.price,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlannedFill {
    pub taker: B256,
    pub maker: B256,
    pub kind: FillKind,
    /// The maker's price in the maker's own outcome terms.
    pub maker_price: u8,
    pub amount: u128,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MatchResult {
    pub fills: Vec<PlannedFill>,
    /// What is left of the taker and now rests in the book (0 = nothing rests).
    pub resting: u128,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub struct Level {
    /// Up terms, cents.
    pub price: u8,
    pub amount: u128,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum BookError {
    #[error("amount must be a positive multiple of 1e16")]
    BadAmount,
    #[error("price must be 1..99")]
    BadPrice,
    #[error("order already rests in the book")]
    Duplicate,
}

pub fn validate(amount: u128, price: u8) -> Result<(), BookError> {
    if amount == 0 || !amount.is_multiple_of(SHARE_UNIT) {
        return Err(BookError::BadAmount);
    }
    if !(1..=99).contains(&price) {
        return Err(BookError::BadPrice);
    }
    Ok(())
}

#[derive(Clone, Debug, Default)]
pub struct Book {
    /// Up price → FIFO queue.
    bids: BTreeMap<u8, VecDeque<RestingOrder>>,
    asks: BTreeMap<u8, VecDeque<RestingOrder>>,
    /// hash → (is_bid, up price).
    index: HashMap<B256, (bool, u8)>,
}

impl Book {
    /// Match `o` as the taker against the book, then rest whatever is left.
    pub fn place(&mut self, mut o: RestingOrder) -> Result<MatchResult, BookError> {
        validate(o.remaining, o.price)?;
        if self.index.contains_key(&o.hash) {
            return Err(BookError::Duplicate);
        }
        let bid = o.is_bid();
        let limit = o.up_price();
        let mut fills = Vec::new();
        let taker_k = (o.outcome, o.side);
        while o.remaining > 0 {
            let opp = if bid { &mut self.asks } else { &mut self.bids };
            let best = if bid {
                opp.keys().next().copied()
            } else {
                opp.keys().next_back().copied()
            };
            let Some(p) = best else { break };
            if (bid && p > limit) || (!bid && p < limit) {
                break;
            }
            let q = opp.get_mut(&p).expect("level exists");
            let m = q.front_mut().expect("non-empty level");
            let amount = m.remaining.min(o.remaining);
            let kind = FillKind::of(taker_k, (m.outcome, m.side)).expect("opposite book sides trade");
            fills.push(PlannedFill {
                taker: o.hash,
                maker: m.hash,
                kind,
                maker_price: m.price,
                amount,
            });
            m.remaining -= amount;
            o.remaining -= amount;
            if m.remaining == 0 {
                let h = m.hash;
                q.pop_front();
                if q.is_empty() {
                    opp.remove(&p);
                }
                self.index.remove(&h);
            }
        }
        let resting = o.remaining;
        if resting > 0 {
            self.index.insert(o.hash, (bid, limit));
            let side = if bid { &mut self.bids } else { &mut self.asks };
            side.entry(limit).or_default().push_back(o);
        }
        Ok(MatchResult { fills, resting })
    }

    pub fn cancel(&mut self, hash: &B256) -> Option<RestingOrder> {
        let (bid, p) = self.index.remove(hash)?;
        let side = if bid { &mut self.bids } else { &mut self.asks };
        let q = side.get_mut(&p)?;
        let i = q.iter().position(|o| &o.hash == hash)?;
        let o = q.remove(i);
        if q.is_empty() {
            side.remove(&p);
        }
        o
    }

    pub fn get(&self, hash: &B256) -> Option<&RestingOrder> {
        let (bid, p) = self.index.get(hash)?;
        let side = if *bid { &self.bids } else { &self.asks };
        side.get(p)?.iter().find(|o| &o.hash == hash)
    }

    /// Reduce a resting order's remaining amount (0 removes it).
    pub fn set_remaining(&mut self, hash: &B256, remaining: u128) {
        if remaining == 0 {
            self.cancel(hash);
            return;
        }
        let Some((bid, p)) = self.index.get(hash).copied() else {
            return;
        };
        let side = if bid { &mut self.bids } else { &mut self.asks };
        if let Some(o) = side
            .get_mut(&p)
            .and_then(|q| q.iter_mut().find(|o| &o.hash == hash))
        {
            o.remaining = remaining;
        }
    }

    pub fn contains(&self, hash: &B256) -> bool {
        self.index.contains_key(hash)
    }

    pub fn is_empty(&self) -> bool {
        self.index.is_empty()
    }

    pub fn orders(&self) -> impl Iterator<Item = &RestingOrder> {
        self.bids.values().chain(self.asks.values()).flatten()
    }

    pub fn hashes(&self) -> Vec<B256> {
        self.index.keys().copied().collect()
    }

    /// (bids best first = descending, asks best first = ascending), Up terms.
    pub fn levels(&self) -> (Vec<Level>, Vec<Level>) {
        let lvl = |(p, q): (&u8, &VecDeque<RestingOrder>)| Level {
            price: *p,
            amount: q.iter().map(|o| o.remaining).sum(),
        };
        (
            self.bids.iter().rev().map(lvl).collect(),
            self.asks.iter().map(lvl).collect(),
        )
    }

    pub fn best_bid(&self) -> Option<u8> {
        self.bids.keys().next_back().copied()
    }

    pub fn best_ask(&self) -> Option<u8> {
        self.asks.keys().next().copied()
    }
}
