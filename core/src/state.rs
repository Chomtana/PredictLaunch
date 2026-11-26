//! The sequencer's mirror of `Exchange`, soft confirmation and atomic acceptance.
//!
//! * `confirmed` is the chain's state as far as we know it: built only from events (and the
//!   decoded calldata of `submitBatch` transactions).
//! * `ledger` is the speculative state users see: `confirmed`, minus pending withdrawals
//!   (`min(requested, balance)`, reserved up front), plus every accepted fill not yet settled, in
//!   batch order. It is rebuilt from scratch whenever the chain moves (`rebuild`), re-checking each
//!   unsent fill against the contract's rules; a fill that no longer passes is dropped (a soft
//!   reversal). Fills of a batch already handed to the chain are kept as they are until the chain
//!   accepts (`BatchSubmitted`) or refuses (`on_batch_failed`) it.
//! * Resting orders lock funds offchain: a resting Buy locks `remaining × price / 100` BNB, a
//!   resting Sell locks `remaining` shares. Free = ledger − locks is never negative: when it would
//!   be (a withdrawal request, a reversal), the user's newest resting orders are cancelled first
//!   (Policy A).

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

use alloy_primitives::{Address, B256, U256};

use crate::abi;
use crate::batcher::{self, CancelRec, FillRec, KeyRec, OrderData, PendingBatch};
use crate::book::{self, Book, BookError, RestingOrder};
use crate::eip712::{authorize_key_hash, cancel_hash, order_hash, recover, Domain, KeyAuthMsg};
use crate::types::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Config {
    pub domain: Domain,
    pub batch_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LaunchStatus {
    Active = 0,
    Graduating = 1,
    Graduated = 2,
    Failed = 3,
}

impl LaunchStatus {
    pub fn name(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Graduating => "graduating",
            Self::Graduated => "graduated",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Launch {
    pub id: u64,
    pub creator: Address,
    pub rail: Address,
    pub token: Address,
    pub feed: Address,
    pub strike: U256,
    pub settle_time: u64,
    pub created_at: u64,
    pub cut_bps: u16,
    pub target: U256,
    pub name: String,
    pub symbol: String,
    pub image_uri: String,
    pub status: LaunchStatus,
    /// 0 Up, 1 Down, 2 Void (once resolved).
    pub outcome: Option<u8>,
    pub settle_price: U256,
    pub settle_updated_at: u64,
    pub snapped: bool,
    pub resolved: bool,
    pub raised: U256,
    pub total_loser_shares: U256,
    /// Open pairs at resolution.
    pub resolved_pairs: U256,
    /// Question launches: the question text (from `QuestionSet`).
    pub question: Option<String>,
    /// Question launches: the Cournot market id (0 = no match).
    pub market_id: u64,
    /// Question launches: the current resolver proposal or owner override.
    pub proposal: Option<Proposal>,
}

impl Launch {
    /// A question launch has `feed == address(0)` (SPEC).
    pub fn is_question(&self) -> bool {
        self.feed.is_zero()
    }
}

/// `OutcomeProposed` state of a question launch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Proposal {
    /// 0 YES, 1 NO, 2 VOID.
    pub outcome: u8,
    /// Block timestamp of the `OutcomeProposed` event.
    pub proposed_at: u64,
    pub evidence_hash: B256,
    /// Owner override: resolvable immediately.
    pub final_: bool,
}

/// Decoded `Exchange` events (SPEC "Events"), in chain order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ChainEvent {
    Deposited {
        user: Address,
        amount: U256,
    },
    WithdrawRequested {
        idx: u64,
        user: Address,
        amount: U256,
    },
    WithdrawPaid {
        idx: u64,
        user: Address,
        requested: U256,
        paid: U256,
    },
    KeyAuthorized {
        owner: Address,
        key: Address,
        expiry: u64,
    },
    KeyRevoked {
        owner: Address,
        key: Address,
    },
    OrderCancelled {
        owner: Address,
        order_hash: B256,
    },
    /// A resting order published to the onchain book.
    OrderPosted {
        order_hash: B256,
    },
    MinNonceBumped {
        owner: Address,
        min_nonce: u64,
    },
    LaunchCreated {
        launch_id: u64,
        creator: Address,
        rail: Address,
        token: Address,
        feed: Address,
        strike: U256,
        settle_time: u64,
        cut_bps: u16,
        target: U256,
        name: String,
        symbol: String,
        image_uri: String,
        /// Block timestamp of the event (0 if unknown).
        created_at: u64,
    },
    Snapshot {
        launch_id: u64,
        price: U256,
        updated_at: u64,
    },
    QuestionSet {
        launch_id: u64,
        question: String,
        market_id: u64,
    },
    OutcomeProposed {
        launch_id: u64,
        outcome: u8,
        evidence_hash: B256,
        by: Address,
        final_: bool,
        /// Block timestamp of the event (0 if unknown).
        proposed_at: u64,
    },
    ChallengeWindowSet {
        seconds: u64,
    },
    Resolved {
        launch_id: u64,
        outcome: u8,
        pairs: U256,
        raised: U256,
    },
    Graduating {
        launch_id: u64,
    },
    Graduated {
        launch_id: u64,
        token: Address,
        raised: U256,
    },
    LaunchFailed {
        launch_id: u64,
    },
    Redeemed {
        launch_id: u64,
        user: Address,
        credit: U256,
        loser_shares: U256,
    },
    TokensClaimed {
        launch_id: u64,
        user: Address,
        amount: U256,
    },
    /// ERC20 quote: fill `index` of batch `batch_id` was not applied (its payer could no longer pay). Emitted
    /// before that batch's `BatchSubmitted`.
    FillSkipped {
        batch_id: u64,
        index: u64,
        user: Address,
    },
    /// `batch` is the decoded `submitBatch` calldata, when available.
    BatchSubmitted {
        batch_id: u64,
        ts: u64,
        fills: u64,
        batch: Option<abi::Batch>,
    },
}

// ------------------------------------------------------------------------------------ ledger

/// Balances, positions, `filled` and open pairs: the parts of the contract that fills change.
#[derive(Clone, Debug, Default)]
pub struct Ledger {
    pub balances: HashMap<Address, U256>,
    /// (launch, user) → (up, down)
    pub positions: HashMap<(u64, Address), (u128, u128)>,
    pub filled: HashMap<B256, u128>,
    pub pairs: HashMap<u64, u128>,
}

impl Ledger {
    pub fn balance(&self, u: Address) -> U256 {
        self.balances.get(&u).copied().unwrap_or_default()
    }
    pub fn position(&self, launch: u64, u: Address) -> (u128, u128) {
        self.positions.get(&(launch, u)).copied().unwrap_or_default()
    }
    pub fn shares(&self, launch: u64, u: Address, o: Outcome) -> u128 {
        let (up, down) = self.position(launch, u);
        match o {
            Outcome::Up => up,
            Outcome::Down => down,
        }
    }
    pub fn filled(&self, h: &B256) -> u128 {
        self.filled.get(h).copied().unwrap_or_default()
    }
    pub fn pairs(&self, launch: u64) -> u128 {
        self.pairs.get(&launch).copied().unwrap_or_default()
    }

    pub fn credit(&mut self, u: Address, amount: U256) {
        *self.balances.entry(u).or_default() += amount;
    }
    pub fn debit_saturating(&mut self, u: Address, amount: U256) {
        let b = self.balances.entry(u).or_default();
        *b = b.saturating_sub(amount);
    }
    fn shares_mut(&mut self, launch: u64, u: Address, o: Outcome) -> &mut u128 {
        let p = self.positions.entry((launch, u)).or_default();
        match o {
            Outcome::Up => &mut p.0,
            Outcome::Down => &mut p.1,
        }
    }

    /// Apply one fill with the contract's rules. `checked` = verify crossing, `filled` and that
    /// nothing goes negative (all checks happen before any change). Unchecked = chain truth,
    /// saturating.
    #[allow(clippy::too_many_arguments)]
    pub fn apply_fill(
        &mut self,
        t: &Order,
        th: B256,
        m: &Order,
        mh: B256,
        kind: FillKind,
        a: u128,
        checked: bool,
    ) -> Result<(), ErrorCode> {
        let launch = t.launch();
        let pm = m.price;
        // (user, BNB debit) and (user, outcome, shares debit) this fill needs.
        let mut bnb: Vec<(Address, U256)> = Vec::new();
        let mut sh: Vec<(Address, Outcome, u128)> = Vec::new();
        let mut credits: Vec<(Address, U256)> = Vec::new();
        let mut adds: Vec<(Address, Outcome, u128)> = Vec::new();
        match kind {
            FillKind::Transfer => {
                let (buyer, seller) = if t.side == Side::Buy {
                    (t.owner, m.owner)
                } else {
                    (m.owner, t.owner)
                };
                let c = cost(a, pm);
                bnb.push((buyer, c));
                sh.push((seller, t.outcome, a));
                credits.push((seller, c));
                adds.push((buyer, t.outcome, a));
            }
            FillKind::Mint => {
                bnb.push((m.owner, cost(a, pm)));
                bnb.push((t.owner, cost(a, 100 - pm)));
                adds.push((m.owner, m.outcome, a));
                adds.push((t.owner, t.outcome, a));
            }
            FillKind::Merge => {
                sh.push((m.owner, m.outcome, a));
                sh.push((t.owner, t.outcome, a));
                credits.push((m.owner, cost(a, pm)));
                credits.push((t.owner, cost(a, 100 - pm)));
            }
        }
        if checked {
            let pt = t.price;
            let cross_ok = match kind {
                FillKind::Transfer => {
                    if t.side == Side::Buy {
                        pm <= pt
                    } else {
                        pm >= pt
                    }
                }
                FillKind::Mint => pt as u16 + pm as u16 >= 100,
                FillKind::Merge => pt as u16 + pm as u16 <= 100,
            };
            if t.launch_id != m.launch_id
                || t.round != 0
                || m.round != 0
                || FillKind::of((t.outcome, t.side), (m.outcome, m.side)) != Some(kind)
                || !cross_ok
            {
                return Err(ErrorCode::BadPrice);
            }
            if a == 0 || !a.is_multiple_of(SHARE_UNIT) {
                return Err(ErrorCode::BadAmount);
            }
            if th == mh {
                return Err(ErrorCode::BadRequest);
            }
            if self.filled(&th) + a > t.amount || self.filled(&mh) + a > m.amount {
                return Err(ErrorCode::BadAmount);
            }
            let mut need: HashMap<Address, U256> = HashMap::new();
            for (u, c) in &bnb {
                *need.entry(*u).or_default() += *c;
            }
            if need.iter().any(|(u, c)| self.balance(*u) < *c) {
                return Err(ErrorCode::InsufficientBalance);
            }
            let mut need_sh: HashMap<(Address, Outcome), u128> = HashMap::new();
            for (u, o, s) in &sh {
                *need_sh.entry((*u, *o)).or_default() += *s;
            }
            if need_sh
                .iter()
                .any(|((u, o), s)| self.shares(launch, *u, *o) < *s)
            {
                return Err(ErrorCode::InsufficientShares);
            }
        }
        for (u, c) in bnb {
            self.debit_saturating(u, c);
        }
        for (u, o, s) in sh {
            let x = self.shares_mut(launch, u, o);
            *x = x.saturating_sub(s);
        }
        for (u, c) in credits {
            self.credit(u, c);
        }
        for (u, o, s) in adds {
            *self.shares_mut(launch, u, o) += s;
        }
        *self.filled.entry(th).or_default() += a;
        *self.filled.entry(mh).or_default() += a;
        let p = self.pairs.entry(launch).or_default();
        match kind {
            FillKind::Mint => *p += a,
            FillKind::Merge => *p = p.saturating_sub(a),
            FillKind::Transfer => {}
        }
        Ok(())
    }
}

// ------------------------------------------------------------------------------------ messages

/// One message of an atomic group (`POST /api/msgs`).
#[derive(Clone, Debug)]
pub enum Msg {
    Place {
        order: Order,
        sig: Vec<u8>,
    },
    Cancel {
        owner: Address,
        order_hash: B256,
        nonce: u64,
        sig: Vec<u8>,
        /// Market orders: skip silently when the order no longer rests.
        if_resting: bool,
    },
    AuthorizeKey {
        owner: Address,
        key: Address,
        expiry: u64,
        nonce: u64,
        sig: Vec<u8>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FillView {
    /// Price per share the message's owner paid / received, in its own outcome terms.
    pub price: u8,
    pub amount: u128,
    pub kind: FillKind,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MsgResult {
    pub order_hash: Option<B256>,
    pub fills: Vec<FillView>,
    pub resting: u128,
    /// An `ifResting` cancel whose order no longer rested.
    pub omitted: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{code} (message {index}): {message}")]
pub struct AcceptError {
    pub index: usize,
    pub code: ErrorCode,
    pub message: String,
}

type Reject = (ErrorCode, String);

fn rej(code: ErrorCode, m: impl Into<String>) -> Reject {
    (code, m.into())
}

// ------------------------------------------------------------------------------------ state

#[derive(Clone, Debug)]
pub struct OrderEntry {
    pub order: Order,
    pub hash: B256,
    pub sig: Vec<u8>,
    pub signer: Address,
    pub seq: u64,
    /// Cancelled offchain (by its owner or Policy A) or onchain.
    pub cancelled: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Withdrawal {
    pub idx: u64,
    pub user: Address,
    pub amount: U256,
    pub paid: Option<U256>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TradeRec {
    pub fill_id: u64,
    pub launch: u64,
    /// Up terms (the maker's price mapped to Up).
    pub up_price: u8,
    pub amount: u128,
    /// The taker was a bid in Up terms ("buy").
    pub taker_bid: bool,
    pub ts: u64,
    pub kind: FillKind,
}

pub const MAX_TRADES: usize = 20_000;

#[derive(Clone, Debug)]
pub struct State {
    pub cfg: Config,
    pub confirmed: Ledger,
    pub ledger: Ledger,
    pub launches: BTreeMap<u64, Launch>,
    pub books: HashMap<u64, Book>,
    pub orders: HashMap<B256, OrderEntry>,
    /// user → seq → hash of their resting orders (newest = last).
    pub resting: HashMap<Address, BTreeMap<u64, B256>>,
    /// user → every order hash they placed (oldest first), for the user view.
    pub user_orders: HashMap<Address, Vec<B256>>,
    pub chain_keys: HashMap<(Address, Address), u64>,
    pub pending_keys: HashMap<(Address, Address), u64>,
    pub cancelled: HashSet<B256>,
    /// Orders already on the onchain book (`OrderPosted`, or in a batch of ours that landed).
    pub posted: HashSet<B256>,
    pub min_nonce: HashMap<Address, u64>,
    pub withdrawals: BTreeMap<u64, Withdrawal>,
    pub withdraw_processed: u64,
    pub batches: VecDeque<PendingBatch>,
    pub last_batch_id: u64,
    pub last_batch_ts: u64,
    pub soft_reversals: u64,
    pub trades: VecDeque<TradeRec>,
    pub loser_shares: HashMap<(u64, Address), U256>,
    pub claimed_shares: HashMap<(u64, Address), U256>,
    /// `Exchange.challengeWindow` (read at startup, then from `ChallengeWindowSet`).
    pub challenge_window: u64,
    /// Fill indices of the next `BatchSubmitted` that the chain skipped (`FillSkipped`).
    pending_skips: HashSet<u64>,
    /// Users whose funds are read every poll even before they have any Exchange activity.
    pub watched: HashSet<Address>,
    next_seq: u64,
    next_fill_id: u64,
}

impl State {
    pub fn new(cfg: Config) -> Self {
        State {
            cfg,
            confirmed: Ledger::default(),
            ledger: Ledger::default(),
            launches: BTreeMap::new(),
            books: HashMap::new(),
            orders: HashMap::new(),
            resting: HashMap::new(),
            user_orders: HashMap::new(),
            chain_keys: HashMap::new(),
            pending_keys: HashMap::new(),
            cancelled: HashSet::new(),
            posted: HashSet::new(),
            min_nonce: HashMap::new(),
            withdrawals: BTreeMap::new(),
            withdraw_processed: 0,
            batches: VecDeque::new(),
            last_batch_id: 0,
            last_batch_ts: 0,
            soft_reversals: 0,
            trades: VecDeque::new(),
            loser_shares: HashMap::new(),
            claimed_shares: HashMap::new(),
            challenge_window: DEFAULT_CHALLENGE_WINDOW,
            pending_skips: HashSet::new(),
            watched: HashSet::new(),
            next_seq: 0,
            next_fill_id: 0,
        }
    }

    // -------------------------------------------------------------------------------- queries

    pub fn tradable(&self, launch: u64, ts: u64) -> bool {
        self.launches
            .get(&launch)
            .is_some_and(|l| l.status == LaunchStatus::Active && ts < l.settle_time)
    }

    pub fn key_expiry(&self, owner: Address, key: Address) -> Option<u64> {
        let a = self.chain_keys.get(&(owner, key)).copied();
        let b = self.pending_keys.get(&(owner, key)).copied();
        a.max(b)
    }

    pub fn withdraw_queue_len(&self) -> u64 {
        self.withdrawals
            .keys()
            .next_back()
            .map_or(self.withdraw_processed, |i| (i + 1).max(self.withdraw_processed))
    }

    pub fn pending_fills(&self) -> usize {
        self.batches.iter().map(|b| b.fills.len()).sum()
    }

    pub fn inflight(&self) -> bool {
        self.batches.iter().any(|b| b.sent.is_some())
    }

    /// Resting orders of `u` (oldest first) with their book remaining.
    pub fn resting_orders(&self, u: Address) -> Vec<(&OrderEntry, u128)> {
        let Some(idx) = self.resting.get(&u) else {
            return vec![];
        };
        idx.values()
            .filter_map(|h| {
                let e = self.orders.get(h)?;
                let r = self.books.get(&e.order.launch())?.get(h)?.remaining;
                Some((e, r))
            })
            .collect()
    }

    pub fn locked_bnb(&self, u: Address) -> U256 {
        self.resting_orders(u)
            .iter()
            .filter(|(e, _)| e.order.side == Side::Buy)
            .map(|(e, r)| cost(*r, e.order.price))
            .sum()
    }

    pub fn locked_shares(&self, u: Address, launch: u64, o: Outcome) -> u128 {
        self.resting_orders(u)
            .iter()
            .filter(|(e, _)| {
                e.order.side == Side::Sell && e.order.outcome == o && e.order.launch() == launch
            })
            .map(|(_, r)| *r)
            .sum()
    }

    pub fn free_bnb(&self, u: Address) -> U256 {
        self.ledger.balance(u).saturating_sub(self.locked_bnb(u))
    }

    /// Users with a non-zero confirmed position in `launch` (redeem targets).
    pub fn holders(&self, launch: u64) -> Vec<Address> {
        let mut v: Vec<Address> = self
            .confirmed
            .positions
            .iter()
            .filter(|((l, _), (up, down))| *l == launch && (*up > 0 || *down > 0))
            .map(|((_, u), _)| *u)
            .collect();
        v.sort();
        v
    }

    /// `pairs × cut / 10000` while Active (speculative), else the resolved `raised`.
    pub fn projected_raised(&self, launch: u64) -> U256 {
        let Some(l) = self.launches.get(&launch) else {
            return U256::ZERO;
        };
        if l.resolved {
            return l.raised;
        }
        U256::from(self.ledger.pairs(launch)) * U256::from(l.cut_bps) / U256::from(10_000u16)
    }

    pub fn claimable_tokens(&self, launch: u64, u: Address) -> U256 {
        let Some(l) = self.launches.get(&launch) else {
            return U256::ZERO;
        };
        if l.total_loser_shares.is_zero() {
            return U256::ZERO;
        }
        let ls = self
            .loser_shares
            .get(&(launch, u))
            .copied()
            .unwrap_or_default();
        let cl = self
            .claimed_shares
            .get(&(launch, u))
            .copied()
            .unwrap_or_default();
        ls.saturating_sub(cl) * U256::from(LOSER_SUPPLY) / l.total_loser_shares
    }

    // -------------------------------------------------------------------------------- resting

    fn remove_resting(&mut self, h: &B256) -> Option<RestingOrder> {
        let e = self.orders.get(h)?;
        let (launch, owner, seq) = (e.order.launch(), e.order.owner, e.seq);
        if let Some(idx) = self.resting.get_mut(&owner) {
            idx.remove(&seq);
            if idx.is_empty() {
                self.resting.remove(&owner);
            }
        }
        self.books.get_mut(&launch)?.cancel(h)
    }

    /// Remove a resting order as cancelled (shown as "cancelled" rather than "expired").
    fn cancel_resting(&mut self, h: &B256) {
        if let Some(e) = self.orders.get_mut(h) {
            e.cancelled = true;
        }
        self.remove_resting(h);
    }

    /// "open" | "filled" | "cancelled" | "expired" for the user view.
    pub fn order_status(&self, h: &B256) -> &'static str {
        let Some(e) = self.orders.get(h) else {
            return "expired";
        };
        if self.books.get(&e.order.launch()).is_some_and(|b| b.contains(h)) {
            "open"
        } else if self.ledger.filled(h) >= e.order.amount {
            "filled"
        } else if e.cancelled || self.cancelled.contains(h) {
            "cancelled"
        } else {
            "expired"
        }
    }

    /// Drop resting orders of launches that are no longer tradable (settleTime reached or status
    /// changed).
    pub fn drop_settled(&mut self, now_ms: u64) {
        let now = now_ms / 1000;
        let dead: Vec<u64> = self
            .books
            .iter()
            .filter(|(l, b)| !b.is_empty() && !self.tradable(**l, now))
            .map(|(l, _)| *l)
            .collect();
        for l in dead {
            for h in self.books[&l].hashes() {
                self.remove_resting(&h);
            }
        }
    }

    /// Cancel newest-first until locks fit the speculative ledger (Policy A).
    fn enforce_locks(&mut self, u: Address) {
        loop {
            if self.locked_bnb(u) <= self.ledger.balance(u) {
                break;
            }
            let newest = self.resting_orders(u).iter().rev().find_map(|(e, _)| {
                (e.order.side == Side::Buy).then_some(e.hash)
            });
            match newest {
                Some(h) => {
                    self.cancel_resting(&h);
                }
                None => break,
            }
        }
        loop {
            let over = self.resting_orders(u).iter().rev().find_map(|(e, _)| {
                let (l, o) = (e.order.launch(), e.order.outcome);
                (e.order.side == Side::Sell
                    && self.locked_shares(u, l, o) > self.ledger.shares(l, u, o))
                .then_some(e.hash)
            });
            match over {
                Some(h) => {
                    self.cancel_resting(&h);
                }
                None => break,
            }
        }
    }

    // -------------------------------------------------------------------------------- events

    /// Apply polled chain events, then rebuild the speculative state.
    pub fn apply_events(&mut self, events: Vec<ChainEvent>, now_ms: u64) {
        if events.is_empty() {
            return;
        }
        for e in events {
            self.apply_event(e);
        }
        self.rebuild();
        self.drop_settled(now_ms);
    }

    /// One poll: apply events, then (ERC20 quote) replace confirmed balances with `Exchange.funds` read at
    /// the polled head, i.e. internal balance + what can be pulled from the wallet. Rebuilds when anything
    /// changed.
    pub fn apply_poll(
        &mut self,
        events: Vec<ChainEvent>,
        funds: Option<Vec<(Address, U256)>>,
        now_ms: u64,
    ) {
        let mut changed = !events.is_empty();
        for e in events {
            self.apply_event(e);
        }
        for (u, f) in funds.into_iter().flatten() {
            if self.confirmed.balance(u) != f {
                self.confirmed.balances.insert(u, f);
                changed = true;
            }
        }
        if changed {
            self.rebuild();
            self.drop_settled(now_ms);
        }
    }

    /// Read `u`'s funds on every poll from now on.
    pub fn watch(&mut self, u: Address) {
        self.watched.insert(u);
    }

    /// Everyone whose funds the sequencer needs: balance holders, key owners, order owners, watched.
    pub fn tracked_users(&self) -> Vec<Address> {
        let mut set: HashSet<Address> = self.watched.clone();
        set.extend(self.confirmed.balances.keys().copied());
        set.extend(self.chain_keys.keys().map(|(o, _)| *o));
        set.extend(self.pending_keys.keys().map(|(o, _)| *o));
        set.extend(self.user_orders.keys().copied());
        let mut v: Vec<Address> = set.into_iter().collect();
        v.sort();
        v
    }

    fn apply_event(&mut self, e: ChainEvent) {
        use ChainEvent as E;
        match e {
            E::Deposited { user, amount } => self.confirmed.credit(user, amount),
            E::WithdrawRequested { idx, user, amount } => {
                self.withdrawals.insert(
                    idx,
                    Withdrawal {
                        idx,
                        user,
                        amount,
                        paid: None,
                    },
                );
            }
            E::WithdrawPaid {
                idx,
                user,
                requested,
                paid,
            } => {
                self.confirmed.debit_saturating(user, paid);
                let w = self.withdrawals.entry(idx).or_insert(Withdrawal {
                    idx,
                    user,
                    amount: requested,
                    paid: None,
                });
                w.paid = Some(paid);
                self.withdraw_processed = self.withdraw_processed.max(idx + 1);
            }
            E::KeyAuthorized { owner, key, expiry } => {
                self.chain_keys.insert((owner, key), expiry);
            }
            E::KeyRevoked { owner, key } => {
                self.chain_keys.remove(&(owner, key));
                self.pending_keys.remove(&(owner, key));
                let hs: Vec<B256> = self
                    .resting_orders(owner)
                    .iter()
                    .filter(|(e, _)| e.signer == key)
                    .map(|(e, _)| e.hash)
                    .collect();
                for h in hs {
                    self.cancel_resting(&h);
                }
            }
            E::OrderPosted { order_hash } => {
                self.posted.insert(order_hash);
            }
            E::OrderCancelled { order_hash, .. } => {
                self.cancelled.insert(order_hash);
                self.cancel_resting(&order_hash);
            }
            E::MinNonceBumped { owner, min_nonce } => {
                self.min_nonce.insert(owner, min_nonce);
                let hs: Vec<B256> = self
                    .resting_orders(owner)
                    .iter()
                    .filter(|(e, _)| e.order.nonce < min_nonce)
                    .map(|(e, _)| e.hash)
                    .collect();
                for h in hs {
                    self.cancel_resting(&h);
                }
            }
            E::LaunchCreated {
                launch_id,
                creator,
                rail,
                token,
                feed,
                strike,
                settle_time,
                cut_bps,
                target,
                name,
                symbol,
                image_uri,
                created_at,
            } => {
                self.launches.insert(
                    launch_id,
                    Launch {
                        id: launch_id,
                        creator,
                        rail,
                        token,
                        feed,
                        strike,
                        settle_time,
                        created_at,
                        cut_bps,
                        target,
                        name,
                        symbol,
                        image_uri,
                        status: LaunchStatus::Active,
                        outcome: None,
                        settle_price: U256::ZERO,
                        settle_updated_at: 0,
                        snapped: false,
                        resolved: false,
                        raised: U256::ZERO,
                        total_loser_shares: U256::ZERO,
                        resolved_pairs: U256::ZERO,
                        question: None,
                        market_id: 0,
                        proposal: None,
                    },
                );
            }
            E::QuestionSet {
                launch_id,
                question,
                market_id,
            } => {
                if let Some(l) = self.launches.get_mut(&launch_id) {
                    l.question = Some(question);
                    l.market_id = market_id;
                }
            }
            E::OutcomeProposed {
                launch_id,
                outcome,
                evidence_hash,
                final_,
                proposed_at,
                ..
            } => {
                if let Some(l) = self.launches.get_mut(&launch_id) {
                    l.proposal = Some(Proposal {
                        outcome,
                        proposed_at,
                        evidence_hash,
                        final_,
                    });
                }
            }
            E::ChallengeWindowSet { seconds } => self.challenge_window = seconds,
            E::Snapshot {
                launch_id,
                price,
                updated_at,
            } => {
                if let Some(l) = self.launches.get_mut(&launch_id) {
                    l.snapped = true;
                    l.settle_price = price;
                    l.settle_updated_at = updated_at;
                }
            }
            E::Resolved {
                launch_id,
                outcome,
                pairs,
                raised,
            } => {
                if let Some(l) = self.launches.get_mut(&launch_id) {
                    l.resolved = true;
                    l.outcome = Some(outcome);
                    l.resolved_pairs = pairs;
                    l.raised = raised;
                    if outcome != 2 {
                        l.total_loser_shares = pairs;
                    }
                    // The final status follows in Graduating / LaunchFailed; trading stops now.
                    if l.status == LaunchStatus::Active {
                        l.status = if outcome != 2 && raised >= l.target && !raised.is_zero() {
                            LaunchStatus::Graduating
                        } else {
                            LaunchStatus::Failed
                        };
                    }
                }
            }
            E::Graduating { launch_id } => self.set_status(launch_id, LaunchStatus::Graduating),
            E::Graduated {
                launch_id,
                token,
                raised,
            } => {
                if let Some(l) = self.launches.get_mut(&launch_id) {
                    l.status = LaunchStatus::Graduated;
                    if token != Address::ZERO {
                        l.token = token;
                    }
                    l.raised = raised;
                }
            }
            E::LaunchFailed { launch_id } => self.set_status(launch_id, LaunchStatus::Failed),
            E::Redeemed {
                launch_id,
                user,
                credit,
                loser_shares,
            } => {
                self.confirmed.credit(user, credit);
                self.confirmed.positions.remove(&(launch_id, user));
                *self.loser_shares.entry((launch_id, user)).or_default() += loser_shares;
            }
            E::TokensClaimed {
                launch_id, user, ..
            } => {
                let ls = self
                    .loser_shares
                    .get(&(launch_id, user))
                    .copied()
                    .unwrap_or_default();
                self.claimed_shares.insert((launch_id, user), ls);
            }
            E::FillSkipped { index, .. } => {
                self.pending_skips.insert(index);
            }
            E::BatchSubmitted {
                batch_id,
                ts,
                fills,
                batch,
            } => {
                let skips = std::mem::take(&mut self.pending_skips);
                self.last_batch_id = self.last_batch_id.max(batch_id);
                self.last_batch_ts = self.last_batch_ts.max(ts);
                let ours = self.batches.front().and_then(|b| b.sent.clone());
                match (batch, ours) {
                    (Some(eb), Some(sb)) if eb == sb => self.settle_front(&skips),
                    (None, Some(sb)) if sb.fills.len() as u64 == fills => self.settle_front(&skips),
                    (Some(eb), _) => self.apply_foreign_batch(&eb, ts, &skips),
                    (None, _) => {}
                }
            }
        }
    }

    fn set_status(&mut self, launch: u64, s: LaunchStatus) {
        if let Some(l) = self.launches.get_mut(&launch) {
            l.status = s;
        }
    }

    /// Our in-flight batch landed: move its fills into `confirmed`.
    fn settle_front(&mut self, skips: &HashSet<u64>) {
        let Some(b) = self.batches.pop_front() else {
            return;
        };
        // Posted or not (dead / full by then), never repost them: no batch keeps re-sending an order.
        self.posted.extend(b.posts.iter().copied());
        for k in &b.keys {
            self.chain_keys.insert((k.owner, k.key), k.expiry);
            self.pending_keys.remove(&(k.owner, k.key));
        }
        if !skips.is_empty() {
            let ids: HashSet<u64> = b
                .fills
                .iter()
                .enumerate()
                .filter(|(i, _)| skips.contains(&(*i as u64)))
                .map(|(_, f)| f.id)
                .collect();
            self.trades.retain(|t| !ids.contains(&t.fill_id));
            self.soft_reversals += ids.len() as u64;
        }
        for (i, f) in b.fills.iter().enumerate() {
            if skips.contains(&(i as u64)) {
                continue;
            }
            let (t, m) = (&self.orders[&f.taker].order, &self.orders[&f.maker].order);
            let _ = self
                .confirmed
                .apply_fill(t, f.taker, m, f.maker, f.kind, f.amount, false);
        }
    }

    /// A batch we did not send ourselves: replayed after a restart, or submitted by anyone else
    /// (`submitBatch` is permissionless). `ts` is its block time.
    fn apply_foreign_batch(&mut self, b: &abi::Batch, ts: u64, skips: &HashSet<u64>) {
        for k in &b.keys {
            self.chain_keys.insert((k.owner, k.key), k.expiry);
        }
        let dom = self.cfg.domain;
        let mut decoded: Vec<Option<(Order, B256)>> = Vec::new();
        for so in &b.orders {
            let Ok(o) = Order::try_from(&so.order) else {
                decoded.push(None);
                continue;
            };
            let h = order_hash(&dom, &o);
            if !self.orders.contains_key(&h) {
                let signer = recover(&h, &so.sig).unwrap_or(o.owner);
                self.next_seq += 1;
                self.orders.insert(
                    h,
                    OrderEntry {
                        order: o.clone(),
                        hash: h,
                        sig: so.sig.to_vec(),
                        signer,
                        seq: self.next_seq,
                        cancelled: false,
                    },
                );
                self.user_orders.entry(o.owner).or_default().push(h);
            }
            decoded.push(Some((o, h)));
        }
        for (i, f) in b.fills.iter().enumerate() {
            if skips.contains(&(i as u64)) {
                continue;
            }
            let (Some(Some((t, th))), Some(Some((m, mh))), Some(kind)) = (
                decoded.get(f.taker as usize),
                decoded.get(f.maker as usize),
                FillKind::from_u8(f.kind),
            ) else {
                continue;
            };
            let _ = self
                .confirmed
                .apply_fill(t, *th, m, *mh, kind, f.amount, false);
            self.next_fill_id += 1;
            self.push_trade(self.next_fill_id, t, m, kind, f.amount, ts);
        }
    }

    fn push_trade(&mut self, id: u64, t: &Order, m: &Order, kind: FillKind, amount: u128, ts: u64) {
        let up_price = match m.outcome {
            Outcome::Up => m.price,
            Outcome::Down => 100 - m.price,
        };
        self.trades.push_back(TradeRec {
            fill_id: id,
            launch: t.launch(),
            up_price,
            amount,
            taker_bid: t.is_bid(),
            ts,
            kind,
        });
        while self.trades.len() > MAX_TRADES {
            self.trades.pop_front();
        }
    }

    /// Is this fill still acceptable by the contract at batch time `ts`?
    fn fill_valid(&self, f: &FillRec, ts: u64) -> bool {
        let ok = |h: &B256| {
            let Some(e) = self.orders.get(h) else {
                return false;
            };
            let o = &e.order;
            !self.cancelled.contains(h)
                && o.nonce >= self.min_nonce.get(&o.owner).copied().unwrap_or(0)
                && o.expiry >= ts
                && (e.signer == o.owner || self.key_expiry(o.owner, e.signer).is_some_and(|x| x >= ts))
        };
        ok(&f.taker) && ok(&f.maker) && self.tradable(f.launch, ts)
    }

    /// Recompute `ledger` = `confirmed` − pending withdrawals + unsettled fills.
    fn rebuild(&mut self) {
        let mut l = self.confirmed.clone();
        for w in self.withdrawals.values() {
            if w.paid.is_none() && w.idx >= self.withdraw_processed {
                let d = w.amount.min(l.balance(w.user));
                l.debit_saturating(w.user, d);
            }
        }
        let mut batches = std::mem::take(&mut self.batches);
        let mut dropped: HashSet<u64> = HashSet::new();
        for b in batches.iter_mut() {
            let sent = b.sent.is_some();
            let ts = b.ts;
            b.fills.retain(|f| {
                let (t, m) = (&self.orders[&f.taker].order, &self.orders[&f.maker].order);
                if sent {
                    let _ = l.apply_fill(t, f.taker, m, f.maker, f.kind, f.amount, false);
                    return true;
                }
                let keep = self.fill_valid(f, ts)
                    && l
                        .apply_fill(t, f.taker, m, f.maker, f.kind, f.amount, true)
                        .is_ok();
                if !keep {
                    dropped.insert(f.id);
                }
                keep
            });
        }
        batches.retain(|b| b.sent.is_some() || b.sealed || !b.is_empty());
        self.batches = batches;
        if !dropped.is_empty() {
            self.soft_reversals += dropped.len() as u64;
            self.trades.retain(|t| !dropped.contains(&t.fill_id));
        }
        self.ledger = l;
        // Resting remainders never exceed what the order has left.
        let mut fix: Vec<(u64, B256, u128)> = Vec::new();
        for (launch, book) in &self.books {
            for o in book.orders() {
                let left = self.orders[&o.hash]
                    .order
                    .amount
                    .saturating_sub(self.ledger.filled(&o.hash));
                if left < o.remaining {
                    fix.push((*launch, o.hash, left));
                }
            }
        }
        for (launch, h, left) in fix {
            if left == 0 {
                self.remove_resting(&h);
            } else if let Some(b) = self.books.get_mut(&launch) {
                b.set_remaining(&h, left);
            }
        }
        let users: Vec<Address> = self.resting.keys().copied().collect();
        for u in users {
            self.enforce_locks(u);
        }
    }

    // -------------------------------------------------------------------------------- batches

    fn open_batch(&mut self, now_ms: u64) -> &mut PendingBatch {
        let need_new = self.batches.back().is_none_or(|b| b.sealed);
        if need_new {
            self.batches.push_back(PendingBatch::new(now_ms));
        }
        self.batches.back_mut().expect("just ensured")
    }

    fn withdraw_covered(&self) -> u64 {
        self.batches
            .iter()
            .map(|b| b.withdraw_to)
            .max()
            .unwrap_or(0)
            .max(self.withdraw_processed)
    }

    fn seal_back(&mut self) {
        let wt = self.withdraw_queue_len().max(self.withdraw_covered());
        if let Some(b) = self.batches.back_mut() {
            if !b.sealed {
                b.sealed = true;
                b.withdraw_to = wt;
            }
        }
    }

    /// Seal what is due and hand out the next batch to submit (one in flight at a time).
    pub fn cut(&mut self, now_ms: u64) -> Option<abi::Batch> {
        self.drop_settled(now_ms);
        let open = self.batches.back().is_some_and(|b| !b.sealed);
        if !open && self.withdraw_queue_len() > self.withdraw_covered() {
            // Withdrawal-only batch.
            self.batches.push_back(PendingBatch::new(now_ms));
            self.seal_back();
        }
        if self.batches.is_empty() && !self.inflight() && !self.unposted(now_ms / 1000).is_empty() {
            // Posts-only batch: a resting order with no fill still reaches the onchain book.
            self.batches.push_back(PendingBatch::new(now_ms));
            self.seal_back();
        }
        if self
            .batches
            .back()
            .is_some_and(|b| !b.sealed && b.due(now_ms, self.cfg.batch_ms))
        {
            self.seal_back();
        }
        if self.inflight() {
            return None;
        }
        if !self.batches.front()?.sealed {
            return None;
        }
        let posts = self.unposted(now_ms / 1000);
        let b = self.batches.front_mut().expect("front");
        b.posts = posts;
        let b = self.batches.front().expect("front");
        let orders = &self.orders;
        let abi_batch = batcher::to_abi(b, |h| {
            let e = &orders[h];
            OrderData {
                order: &e.order,
                sig: &e.sig,
            }
        });
        self.batches.front_mut().expect("front").sent = Some(abi_batch.clone());
        Some(abi_batch)
    }

    /// Resting orders not yet on the onchain book and still valid to post, oldest first, at most one
    /// batch's worth.
    fn unposted(&self, now: u64) -> Vec<B256> {
        let mut v: Vec<(u64, B256)> = self
            .books
            .values()
            .flat_map(|b| b.orders())
            .filter(|r| !self.posted.contains(&r.hash))
            .filter_map(|r| {
                let e = self.orders.get(&r.hash)?;
                let o = &e.order;
                let live = o.expiry >= now
                    && (e.signer == o.owner
                        || self.key_expiry(o.owner, e.signer).is_some_and(|x| x >= now));
                live.then_some((e.seq, r.hash))
            })
            .collect();
        v.sort_unstable();
        v.truncate(MAX_BATCH_FILLS);
        v.into_iter().map(|(_, h)| h).collect()
    }

    /// The in-flight batch was refused (simulation or transaction failed): reverse its fills.
    pub fn on_batch_failed(&mut self, now_ms: u64) {
        let Some(pos) = self.batches.iter().position(|b| b.sent.is_some()) else {
            return;
        };
        let b = self.batches.remove(pos).expect("exists");
        for k in &b.keys {
            if self.pending_keys.get(&(k.owner, k.key)) == Some(&k.expiry) {
                self.pending_keys.remove(&(k.owner, k.key));
            }
        }
        let ids: HashSet<u64> = b.fills.iter().map(|f| f.id).collect();
        self.trades.retain(|t| !ids.contains(&t.fill_id));
        self.soft_reversals += 1;
        // The cancels still stand: queue them again (unless already onchain or no longer signable).
        let now = now_ms / 1000;
        let retry: Vec<CancelRec> = b
            .cancels
            .into_iter()
            .filter(|c| !self.cancelled.contains(&c.order_hash))
            .filter(|c| {
                self.orders.get(&c.order_hash).is_some_and(|e| {
                    c.signer == e.order.owner
                        || self.key_expiry(e.order.owner, c.signer).is_some_and(|x| x >= now)
                })
            })
            .collect();
        for c in retry {
            self.push_cancel(c, now_ms);
        }
        self.rebuild();
        self.drop_settled(now_ms);
    }

    // -------------------------------------------------------------------------------- accept

    /// Accept an atomic group: run on a clone, commit only if every message passes.
    pub fn accept_group(
        &mut self,
        msgs: Vec<Msg>,
        now_ms: u64,
    ) -> Result<Vec<MsgResult>, AcceptError> {
        if msgs.len() > MAX_GROUP {
            return Err(AcceptError {
                index: MAX_GROUP,
                code: ErrorCode::GroupTooLarge,
                message: format!("at most {MAX_GROUP} messages per group"),
            });
        }
        if msgs.is_empty() {
            return Ok(vec![]);
        }
        let mut s = self.clone();
        s.drop_settled(now_ms);
        let mut out = Vec::with_capacity(msgs.len());
        for (index, m) in msgs.into_iter().enumerate() {
            let r = s
                .accept_one(m, now_ms)
                .map_err(|(code, message)| AcceptError {
                    index,
                    code,
                    message,
                })?;
            out.push(r);
        }
        *self = s;
        Ok(out)
    }

    fn check_signer(&self, owner: Address, signer: Address, now: u64) -> Result<(), Reject> {
        if signer == owner {
            return Ok(());
        }
        match self.key_expiry(owner, signer) {
            None => Err(rej(ErrorCode::BadSignature, "signer is not the owner or its key")),
            Some(x) if x < now => Err(rej(ErrorCode::KeyExpired, "trading key expired")),
            Some(_) => Ok(()),
        }
    }

    fn accept_one(&mut self, m: Msg, now_ms: u64) -> Result<MsgResult, Reject> {
        let now = now_ms / 1000;
        let dom = self.cfg.domain;
        match m {
            Msg::AuthorizeKey {
                owner,
                key,
                expiry,
                nonce,
                sig,
            } => {
                let h = authorize_key_hash(
                    &dom,
                    &KeyAuthMsg {
                        owner,
                        key,
                        expiry,
                        nonce,
                    },
                );
                let signer = recover(&h, &sig)
                    .map_err(|e| rej(ErrorCode::BadSignature, e.to_string()))?;
                if signer != owner {
                    return Err(rej(ErrorCode::BadSignature, "AuthorizeKey must be signed by the owner"));
                }
                if expiry <= now {
                    return Err(rej(ErrorCode::KeyExpired, "expiry is in the past"));
                }
                self.pending_keys.insert((owner, key), expiry);
                self.open_batch(now_ms).keys.push(KeyRec {
                    owner,
                    key,
                    expiry,
                    nonce,
                    sig,
                });
                Ok(MsgResult::default())
            }
            Msg::Cancel {
                owner,
                order_hash: oh,
                nonce,
                sig,
                if_resting,
            } => {
                let h = cancel_hash(&dom, owner, oh, nonce);
                let signer = recover(&h, &sig)
                    .map_err(|e| rej(ErrorCode::BadSignature, e.to_string()))?;
                self.check_signer(owner, signer, now)?;
                let Some(e) = self.orders.get(&oh) else {
                    return Err(rej(ErrorCode::UnknownOrder, "unknown order"));
                };
                if e.order.owner != owner {
                    return Err(rej(ErrorCode::UnknownOrder, "not your order"));
                }
                let rests = self
                    .books
                    .get(&e.order.launch())
                    .is_some_and(|b| b.contains(&oh));
                if !rests {
                    if if_resting {
                        return Ok(MsgResult {
                            order_hash: Some(oh),
                            omitted: true,
                            ..Default::default()
                        });
                    }
                    return Err(rej(ErrorCode::UnknownOrder, "order does not rest"));
                }
                self.cancel_resting(&oh);
                // Binding onchain too: the next batch carries it, so nobody can fill the rest later.
                self.push_cancel(
                    CancelRec {
                        order_hash: oh,
                        nonce,
                        sig,
                        signer,
                    },
                    now_ms,
                );
                Ok(MsgResult {
                    order_hash: Some(oh),
                    ..Default::default()
                })
            }
            Msg::Place { order: o, sig } => self.place(o, sig, now_ms),
        }
    }

    fn place(&mut self, o: Order, sig: Vec<u8>, now_ms: u64) -> Result<MsgResult, Reject> {
        let now = now_ms / 1000;
        let launch = o.launch();
        if o.round != 0 {
            return Err(rej(ErrorCode::NotTradable, "round must be 0"));
        }
        book::validate(o.amount, o.price).map_err(|e| match e {
            BookError::BadPrice => rej(ErrorCode::BadPrice, e.to_string()),
            _ => rej(ErrorCode::BadAmount, e.to_string()),
        })?;
        let h = order_hash(&self.cfg.domain, &o);
        let signer =
            recover(&h, &sig).map_err(|e| rej(ErrorCode::BadSignature, e.to_string()))?;
        self.check_signer(o.owner, signer, now)?;
        if o.expiry < now {
            return Err(rej(ErrorCode::Expired, "order expired"));
        }
        if self.cancelled.contains(&h)
            || o.nonce < self.min_nonce.get(&o.owner).copied().unwrap_or(0)
        {
            return Err(rej(ErrorCode::Expired, "order cancelled onchain"));
        }
        if !self.tradable(launch, now) {
            return Err(rej(ErrorCode::NotTradable, "launch is not trading"));
        }
        let remaining = o.amount.saturating_sub(self.ledger.filled(&h));
        if remaining == 0 {
            return Err(rej(ErrorCode::BadAmount, "order already fully filled"));
        }
        if self.books.get(&launch).is_some_and(|b| b.contains(&h)) {
            return Err(rej(ErrorCode::BadAmount, "order already rests"));
        }
        match o.side {
            Side::Buy => {
                if self.free_bnb(o.owner) < cost(remaining, o.price) {
                    return Err(rej(ErrorCode::InsufficientBalance, "not enough free BNB"));
                }
            }
            Side::Sell => {
                let free = self
                    .ledger
                    .shares(launch, o.owner, o.outcome)
                    .saturating_sub(self.locked_shares(o.owner, launch, o.outcome));
                if free < remaining {
                    return Err(rej(ErrorCode::InsufficientShares, "not enough free shares"));
                }
            }
        }
        self.purge_makers(launch, now);
        self.next_seq += 1;
        let seq = self.next_seq;
        self.orders.insert(
            h,
            OrderEntry {
                order: o.clone(),
                hash: h,
                sig,
                signer,
                seq,
                cancelled: false,
            },
        );
        let res = self
            .books
            .entry(launch)
            .or_default()
            .place(RestingOrder {
                hash: h,
                owner: o.owner,
                outcome: o.outcome,
                side: o.side,
                price: o.price,
                remaining,
            })
            .map_err(|e| rej(ErrorCode::BadAmount, e.to_string()))?;
        if res.resting > 0 {
            self.resting.entry(o.owner).or_default().insert(seq, h);
        }
        self.user_orders.entry(o.owner).or_default().push(h);
        let settle = self.launches[&launch].settle_time;
        let mut views = Vec::new();
        for f in &res.fills {
            let maker = self.orders[&f.maker].order.clone();
            self.ledger
                .apply_fill(&o, h, &maker, f.maker, f.kind, f.amount, true)
                .map_err(|c| rej(c, "fill would not settle"))?;
            if !self.books[&launch].contains(&f.maker) {
                let mseq = self.orders[&f.maker].seq;
                if let Some(idx) = self.resting.get_mut(&maker.owner) {
                    idx.remove(&mseq);
                    if idx.is_empty() {
                        self.resting.remove(&maker.owner);
                    }
                }
            }
            self.next_fill_id += 1;
            let id = self.next_fill_id;
            let rec = FillRec {
                id,
                launch,
                taker: h,
                maker: f.maker,
                kind: f.kind,
                maker_price: f.maker_price,
                amount: f.amount,
            };
            self.push_fill(rec, settle, now_ms);
            self.push_trade(id, &o, &maker, f.kind, f.amount, now);
            views.push(FillView {
                price: match f.kind {
                    FillKind::Transfer => f.maker_price,
                    _ => 100 - f.maker_price,
                },
                amount: f.amount,
                kind: f.kind,
            });
        }
        Ok(MsgResult {
            order_hash: Some(h),
            fills: views,
            resting: res.resting,
            omitted: false,
        })
    }

    /// Remove makers that could no longer settle at `now` (expired order or trading key).
    fn purge_makers(&mut self, launch: u64, now: u64) {
        let Some(b) = self.books.get(&launch) else {
            return;
        };
        let dead: Vec<B256> = b
            .orders()
            .filter(|r| {
                let e = &self.orders[&r.hash];
                e.order.expiry < now || self.check_signer(e.order.owner, e.signer, now).is_err()
            })
            .map(|r| r.hash)
            .collect();
        for h in dead {
            self.remove_resting(&h);
        }
    }

    fn push_cancel(&mut self, rec: CancelRec, now_ms: u64) {
        if self
            .batches
            .back()
            .is_some_and(|b| !b.sealed && b.cancels.len() >= MAX_BATCH_FILLS)
        {
            self.seal_back();
        }
        self.open_batch(now_ms).cancels.push(rec);
    }

    fn push_fill(&mut self, rec: FillRec, settle: u64, now_ms: u64) {
        if let Some(b) = self.batches.back() {
            if !b.sealed && (b.ts >= settle || b.fills.len() >= MAX_BATCH_FILLS) {
                self.seal_back();
            }
        }
        let b = self.open_batch(now_ms);
        b.min_settle = b.min_settle.min(settle);
        b.fills.push(rec);
    }
}
