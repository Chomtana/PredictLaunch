use alloy_primitives::{Address, U256};
use predictlaunch_core::abi;
use predictlaunch_core::eip712::{cancel_hash, TestKey};
use predictlaunch_core::state::{ChainEvent, Config, Msg, State};
use predictlaunch_core::{order_hash, Domain, ErrorCode, Order, Outcome, Side, SHARE_UNIT};

const E18: u128 = 1_000_000_000_000_000_000;
const T0: u64 = 1_800_000_000;
const SETTLE_A: u64 = T0 + 600;
const SETTLE_B: u64 = T0 + 1200;

fn domain() -> Domain {
    Domain {
        chain_id: 97,
        exchange: Address::repeat_byte(0xE8),
    }
}

fn ms(s: u64) -> u64 {
    s * 1000
}

fn launch(id: u64, settle: u64) -> ChainEvent {
    ChainEvent::LaunchCreated {
        launch_id: id,
        creator: Address::repeat_byte(0xC0),
        rail: Address::repeat_byte(0xAA),
        token: Address::repeat_byte(0x77),
        feed: Address::repeat_byte(0xFE),
        strike: U256::from(100u64) * U256::from(E18),
        settle_time: settle,
        cut_bps: 1000,
        target: U256::from(3 * E18),
        name: format!("Coin{id}"),
        symbol: format!("C{id}"),
        image_uri: String::new(),
        created_at: T0 - 100,
    }
}

struct W {
    s: State,
    alice: TestKey,
    bob: TestKey,
    carol: TestKey,
    nonce: u64,
}

impl W {
    fn new(batch_ms: u64) -> W {
        let alice = TestKey::from_seed("alice");
        let bob = TestKey::from_seed("bob");
        let carol = TestKey::from_seed("carol");
        let mut s = State::new(Config {
            domain: domain(),
            batch_ms,
        });
        s.apply_events(
            vec![
                launch(0, SETTLE_A),
                launch(1, SETTLE_B),
                ChainEvent::Deposited {
                    user: alice.address(),
                    amount: U256::from(100 * E18),
                },
                ChainEvent::Deposited {
                    user: bob.address(),
                    amount: U256::from(100 * E18),
                },
                ChainEvent::Deposited {
                    user: carol.address(),
                    amount: U256::from(100 * E18),
                },
            ],
            ms(T0),
        );
        W {
            s,
            alice,
            bob,
            carol,
            nonce: 0,
        }
    }

    fn order(
        &mut self,
        k: &TestKey,
        launch: u64,
        outcome: Outcome,
        side: Side,
        price: u8,
        amount: u128,
    ) -> (Order, Vec<u8>) {
        self.nonce += 1;
        let o = Order {
            owner: k.address(),
            launch_id: U256::from(launch),
            round: 0,
            outcome,
            side,
            price,
            amount,
            expiry: u64::MAX,
            nonce: self.nonce,
        };
        let sig = k.sign(&order_hash(&domain(), &o));
        (o, sig)
    }

    fn place_msg(
        &mut self,
        k: &TestKey,
        launch: u64,
        outcome: Outcome,
        side: Side,
        price: u8,
        amount: u128,
    ) -> Msg {
        let (order, sig) = self.order(&k.clone(), launch, outcome, side, price, amount);
        Msg::Place { order, sig }
    }

    #[allow(clippy::too_many_arguments)]
    fn place(
        &mut self,
        k: &TestKey,
        launch: u64,
        outcome: Outcome,
        side: Side,
        price: u8,
        amount: u128,
        now: u64,
    ) -> Result<predictlaunch_core::state::MsgResult, predictlaunch_core::state::AcceptError> {
        let m = self.place_msg(k, launch, outcome, side, price, amount);
        self.s.accept_group(vec![m], ms(now)).map(|mut v| v.remove(0))
    }
}

fn cancel_msg(k: &TestKey, o: &Order, if_resting: bool) -> Msg {
    let h = order_hash(&domain(), o);
    let sig = k.sign(&cancel_hash(&domain(), o.owner, h, 1));
    Msg::Cancel {
        owner: o.owner,
        order_hash: h,
        nonce: 1,
        sig,
        if_resting,
    }
}

use Outcome::{Down, Up};
use Side::{Buy, Sell};

fn check_invariants(w: &W) {
    let mut total = U256::ZERO;
    for k in [&w.alice, &w.bob, &w.carol] {
        let u = k.address();
        let bal = w.s.ledger.balance(u);
        assert!(w.s.locked_bnb(u) <= bal, "locks exceed balance");
        for l in [0u64, 1] {
            let (up, down) = w.s.ledger.position(l, u);
            assert!(w.s.locked_shares(u, l, Up) <= up);
            assert!(w.s.locked_shares(u, l, Down) <= down);
        }
        total += bal;
    }
    for l in [0u64, 1] {
        total += U256::from(w.s.ledger.pairs(l));
    }
    // 1 pair (1e18 Up + 1e18 Down) is backed by exactly 1 BNB.
    assert_eq!(total, U256::from(300 * E18), "BNB conservation");
}

#[test]
fn soft_confirm_matches_contract_rules() {
    let mut w = W::new(2000);
    let mut rng: u64 = 0x9E3779B97F4A7C15;
    let mut next = move || {
        rng ^= rng << 13;
        rng ^= rng >> 7;
        rng ^= rng << 17;
        rng
    };
    let keys = [w.alice.clone(), w.bob.clone(), w.carol.clone()];
    let mut placed: Vec<(TestKey, Order)> = Vec::new();
    let mut ok = 0;
    for i in 0..600 {
        let now = T0 + i / 10;
        let r = next();
        if r % 5 == 0 && !placed.is_empty() {
            let (k, o) = placed[(next() as usize) % placed.len()].clone();
            let _ = w.s.accept_group(vec![cancel_msg(&k, &o, true)], ms(now));
        } else {
            let k = keys[(r as usize >> 3) % 3].clone();
            let outcome = if next() % 2 == 0 { Up } else { Down };
            let side = if next() % 3 == 0 { Sell } else { Buy };
            let price = (next() % 99 + 1) as u8;
            let amount = (next() % 300 + 1) as u128 * SHARE_UNIT * 10;
            let launch = next() % 2;
            let (o, sig) = w.order(&k, launch, outcome, side, price, amount);
            if w
                .s
                .accept_group(vec![Msg::Place { order: o.clone(), sig }], ms(now))
                .is_ok()
            {
                ok += 1;
                placed.push((k, o));
            }
        }
        check_invariants(&w);
        if i % 37 == 0 {
            if let Some(b) = w.s.cut(ms(now)) {
                // Half of the batches land, half fail.
                if next() % 2 == 0 {
                    let id = w.s.last_batch_id + 1;
                    w.s.apply_events(
                        vec![ChainEvent::BatchSubmitted {
                            batch_id: id,
                            ts: b.ts,
                            fills: b.fills.len() as u64,
                            batch: Some(b),
                        }],
                        ms(now),
                    );
                } else {
                    w.s.on_batch_failed(ms(now));
                }
                check_invariants(&w);
            }
        }
    }
    assert!(ok > 100, "only {ok} orders accepted");
    assert!(!w.s.trades.is_empty());
}

#[test]
fn group_is_atomic() {
    let mut w = W::new(2000);
    let alice = w.alice.clone();
    let bob = w.bob.clone();
    w.place(&bob, 0, Up, Sell, 50, E18, T0).unwrap_err(); // bob has no shares
    let good = w.place_msg(&alice, 0, Up, Buy, 60, E18);
    let bad = match w.place_msg(&alice, 0, Down, Buy, 40, E18) {
        Msg::Place { order, mut sig } => {
            sig[5] ^= 1;
            Msg::Place { order, sig }
        }
        _ => unreachable!(),
    };
    let e = w.s.accept_group(vec![good, bad], ms(T0)).unwrap_err();
    assert_eq!(e.index, 1);
    assert_eq!(e.code, ErrorCode::BadSignature);
    assert!(w.s.books.get(&0).is_none_or(|b| b.is_empty()));
    assert_eq!(w.s.locked_bnb(alice.address()), U256::ZERO);
    assert_eq!(w.s.pending_fills(), 0);

    let msgs: Vec<Msg> = (0..17)
        .map(|_| w.place_msg(&alice, 0, Up, Buy, 10, E18))
        .collect();
    assert_eq!(
        w.s.accept_group(msgs, ms(T0)).unwrap_err().code,
        ErrorCode::GroupTooLarge
    );
}

#[test]
fn market_order_never_rests() {
    let mut w = W::new(2000);
    let (alice, bob) = (w.alice.clone(), w.bob.clone());
    // Bob offers 1 Down @40 (= ask Up 60).
    w.place(&bob, 0, Down, Buy, 40, E18, T0).unwrap();
    // Alice market-buys 3 Up up to 65: place + cancel-if-resting.
    let (o, sig) = w.order(&alice, 0, Up, Buy, 65, 3 * E18);
    let r = w
        .s
        .accept_group(
            vec![
                Msg::Place {
                    order: o.clone(),
                    sig,
                },
                cancel_msg(&alice, &o, true),
            ],
            ms(T0),
        )
        .unwrap();
    assert_eq!(r[0].fills.len(), 1);
    assert_eq!(r[0].fills[0].amount, E18);
    assert_eq!(r[0].fills[0].price, 60, "taker pays 100 - maker price");
    assert!(!r[1].omitted);
    assert!(w.s.books[&0].is_empty());
    assert_eq!(w.s.locked_bnb(alice.address()), U256::ZERO);
    assert_eq!(w.s.ledger.position(0, alice.address()), (E18, 0));
    assert_eq!(
        w.s.ledger.balance(alice.address()),
        U256::from(100 * E18 - 60 * E18 / 100)
    );

    // Fully filled market order: the cancel is omitted.
    w.place(&bob, 0, Up, Sell, 55, E18 / 2, T0).unwrap_err(); // bob holds Down, not Up
    w.place(&bob, 0, Down, Buy, 45, E18, T0).unwrap();
    let (o, sig) = w.order(&alice, 0, Up, Buy, 60, E18);
    let r = w
        .s
        .accept_group(
            vec![
                Msg::Place {
                    order: o.clone(),
                    sig,
                },
                cancel_msg(&alice, &o, true),
            ],
            ms(T0),
        )
        .unwrap();
    assert_eq!(r[0].resting, 0);
    assert!(r[1].omitted);
    // A plain cancel of an order that doesn't rest is an error.
    assert_eq!(
        w.s.accept_group(vec![cancel_msg(&alice, &o, false)], ms(T0))
            .unwrap_err()
            .code,
        ErrorCode::UnknownOrder
    );
}

#[test]
fn withdraw_cancels_newest_first() {
    let mut w = W::new(2000);
    let alice = w.alice.clone();
    let a = alice.address();
    // Three resting bids locking 30 BNB each (100 BNB balance).
    let mut hashes = vec![];
    for p in [10u8, 20, 30] {
        let r = w.place(&alice, 0, Up, Buy, p, 3000 * E18 / p as u128, T0).unwrap();
        hashes.push(r.order_hash.unwrap());
    }
    let locked0 = w.s.locked_bnb(a);
    assert!(locked0 > U256::from(89 * E18));
    // Request 50: newest two are cancelled, the oldest stays.
    w.s.apply_events(
        vec![ChainEvent::WithdrawRequested {
            idx: 0,
            user: a,
            amount: U256::from(50 * E18),
        }],
        ms(T0 + 1),
    );
    let book = &w.s.books[&0];
    assert!(book.contains(&hashes[0]));
    assert!(!book.contains(&hashes[1]));
    assert!(!book.contains(&hashes[2]));
    // The withdrawal is reserved: the spec balance already excludes it.
    assert_eq!(w.s.ledger.balance(a), U256::from(50 * E18));
    assert!(w.s.locked_bnb(a) <= w.s.ledger.balance(a));
    // The next batch processes it.
    let b = w.s.cut(ms(T0 + 1)).expect("withdrawal batch");
    assert_eq!(b.withdrawTo, 1);
    assert!(b.fills.is_empty());
    w.s.apply_events(
        vec![
            ChainEvent::BatchSubmitted {
                batch_id: 1,
                ts: b.ts,
                fills: 0,
                batch: Some(b),
            },
            ChainEvent::WithdrawPaid {
                idx: 0,
                user: a,
                requested: U256::from(50 * E18),
                paid: U256::from(50 * E18),
            },
        ],
        ms(T0 + 2),
    );
    assert_eq!(w.s.ledger.balance(a), U256::from(50 * E18));
    assert_eq!(w.s.confirmed.balance(a), U256::from(50 * E18));
    assert!(w.s.cut(ms(T0 + 10)).is_none());
}

#[test]
fn cuts_batch_at_settle_time() {
    let mut w = W::new(2000);
    let (alice, bob) = (w.alice.clone(), w.bob.clone());
    let at = |w: &mut W, k: &TestKey, l: u64, o: Outcome, p: u8, now_ms: u64| {
        let m = w.place_msg(k, l, o, Buy, p, E18);
        w.s.accept_group(vec![m], now_ms).unwrap();
    };
    let s = ms(SETTLE_A);
    at(&mut w, &bob, 0, Down, 40, s - 1500);
    at(&mut w, &alice, 0, Up, 60, s - 1400);
    at(&mut w, &bob, 1, Down, 40, s - 1000);
    at(&mut w, &alice, 1, Up, 60, s - 900);
    assert!(w.s.cut(s - 100).is_none(), "the batch timer has not fired yet");
    // At launch 0's settleTime the open batch is cut with both fills, stamped before settle.
    let b1 = w.s.cut(s).expect("cut at settle");
    assert_eq!(b1.fills.len(), 2);
    assert_eq!(b1.ts, SETTLE_A - 2);
    assert!(b1.ts < SETTLE_A);
    w.s.apply_events(
        vec![ChainEvent::BatchSubmitted {
            batch_id: 1,
            ts: b1.ts,
            fills: 2,
            batch: Some(b1),
        }],
        s + 1000,
    );
    // Launch 0 no longer trades; launch 1 does, in a new batch stamped after launch 0 settled.
    let m = w.place_msg(&bob, 0, Down, Buy, 40, E18);
    assert_eq!(
        w.s.accept_group(vec![m], s + 5000).unwrap_err().code,
        ErrorCode::NotTradable
    );
    at(&mut w, &bob, 1, Down, 40, s + 5000);
    at(&mut w, &alice, 1, Up, 60, s + 6000);
    let b2 = w.s.cut(s + 8000).expect("timer cut");
    assert_eq!(b2.ts, SETTLE_A + 6);
    assert_eq!(b2.fills.len(), 1);
    assert!(b2.ts < SETTLE_B);
}

#[test]
fn no_fill_at_or_after_settle() {
    let mut w = W::new(2000);
    let (alice, bob) = (w.alice.clone(), w.bob.clone());
    w.place(&bob, 0, Down, Buy, 40, E18, SETTLE_A - 1).unwrap();
    let e = w.place(&alice, 0, Up, Buy, 60, E18, SETTLE_A).unwrap_err();
    assert_eq!(e.code, ErrorCode::NotTradable);
    assert_eq!(w.s.pending_fills(), 0);
    let mut w = W::new(2000);
    w.place(&bob, 0, Down, Buy, 40, E18, SETTLE_A - 1).unwrap();
    w.place(&alice, 0, Up, Buy, 60, E18, SETTLE_A - 1).unwrap();
    let b = w.s.cut(ms(SETTLE_A)).unwrap();
    assert_eq!(b.fills.len(), 1);
    assert!(b.ts < SETTLE_A);
    // Round must be 0.
    let (mut o, _) = w.order(&alice, 1, Up, Buy, 60, E18);
    o.round = 1;
    let sig = alice.sign(&order_hash(&domain(), &o));
    assert_eq!(
        w.s.accept_group(vec![Msg::Place { order: o, sig }], ms(T0))
            .unwrap_err()
            .code,
        ErrorCode::NotTradable
    );
}

#[test]
fn orders_dropped_at_settle() {
    let mut w = W::new(2000);
    let alice = w.alice.clone();
    w.place(&alice, 0, Up, Buy, 30, E18, SETTLE_A - 100).unwrap();
    w.place(&alice, 1, Up, Buy, 30, E18, SETTLE_A - 100).unwrap();
    assert_eq!(w.s.locked_bnb(alice.address()), U256::from(60 * E18 / 100));
    w.s.drop_settled(ms(SETTLE_A));
    assert!(w.s.books.get(&0).is_none_or(|b| b.is_empty()));
    assert!(!w.s.books[&1].is_empty());
    assert_eq!(w.s.locked_bnb(alice.address()), U256::from(30 * E18 / 100));
}

#[test]
fn failed_batch_reverts_fills() {
    let mut w = W::new(2000);
    let (alice, bob) = (w.alice.clone(), w.bob.clone());
    w.place(&bob, 0, Down, Buy, 40, E18, T0).unwrap();
    w.place(&alice, 0, Up, Buy, 60, E18, T0).unwrap();
    assert_eq!(w.s.ledger.pairs(0), E18);
    let b = w.s.cut(ms(T0 + 3)).unwrap();
    assert_eq!(b.orders.len(), 2);
    assert_eq!(b.fills[0].kind, 1);
    assert!(w.s.cut(ms(T0 + 3)).is_none(), "one batch in flight at a time");
    w.s.on_batch_failed(ms(T0 + 4));
    assert_eq!(w.s.soft_reversals, 1);
    assert_eq!(w.s.ledger.balance(alice.address()), U256::from(100 * E18));
    assert_eq!(w.s.ledger.balance(bob.address()), U256::from(100 * E18));
    assert_eq!(w.s.ledger.pairs(0), 0);
    assert!(w.s.trades.is_empty());
    assert_eq!(w.s.pending_fills(), 0);
}

#[test]
fn trading_key_authorized_in_batch() {
    let mut w = W::new(2000);
    let (alice, bob) = (w.alice.clone(), w.bob.clone());
    let key = TestKey::from_seed("alice-session");
    let auth = predictlaunch_core::eip712::KeyAuthMsg {
        owner: alice.address(),
        key: key.address(),
        expiry: T0 + 3600,
        nonce: 1,
    };
    let sig = alice.sign(&predictlaunch_core::eip712::authorize_key_hash(
        &domain(),
        &auth,
    ));
    w.s.accept_group(
        vec![Msg::AuthorizeKey {
            owner: auth.owner,
            key: auth.key,
            expiry: auth.expiry,
            nonce: auth.nonce,
            sig,
        }],
        ms(T0),
    )
    .unwrap();
    w.place(&bob, 0, Down, Buy, 40, E18, T0).unwrap();
    // Alice's order signed by the session key.
    let (o, _) = w.order(&alice, 0, Up, Buy, 60, E18);
    let sig = key.sign(&order_hash(&domain(), &o));
    w.s.accept_group(vec![Msg::Place { order: o, sig }], ms(T0 + 1))
        .unwrap();
    let b: abi::Batch = w.s.cut(ms(T0 + 3)).unwrap();
    assert_eq!(b.keys.len(), 1);
    assert_eq!(b.fills.len(), 1);
    // After expiry the key no longer signs.
    let (o, _) = w.order(&alice, 0, Up, Buy, 60, E18);
    let sig = key.sign(&order_hash(&domain(), &o));
    assert_eq!(
        w.s.accept_group(vec![Msg::Place { order: o, sig }], ms(T0 + 3601))
            .unwrap_err()
            .code,
        ErrorCode::KeyExpired
    );
}

#[test]
fn fill_skipped_onchain_is_not_settled() {
    let mut w = W::new(2000);
    let (alice, bob, carol) = (w.alice.clone(), w.bob.clone(), w.carol.clone());
    // fill 0: bob x alice (mint), fill 1: carol x alice's second order (mint)
    w.place(&bob, 0, Down, Buy, 40, E18, T0).unwrap();
    w.place(&alice, 0, Up, Buy, 60, E18, T0).unwrap();
    w.place(&carol, 0, Down, Buy, 40, E18, T0).unwrap();
    w.place(&alice, 0, Up, Buy, 60, E18, T0).unwrap();
    let b = w.s.cut(ms(T0 + 3)).unwrap();
    assert_eq!(b.fills.len(), 2);
    w.s.apply_events(
        vec![
            ChainEvent::FillSkipped {
                batch_id: 1,
                index: 0,
                user: bob.address(),
            },
            ChainEvent::BatchSubmitted {
                batch_id: 1,
                ts: b.ts,
                fills: 2,
                batch: Some(b),
            },
        ],
        ms(T0 + 4),
    );
    assert_eq!(w.s.pending_fills(), 0);
    assert_eq!(w.s.confirmed.pairs(0), E18, "only the second fill settled");
    assert_eq!(w.s.confirmed.balance(bob.address()), U256::from(100 * E18));
    assert_eq!(w.s.confirmed.balance(carol.address()), U256::from(996 * E18 / 10));
    assert_eq!(w.s.confirmed.shares(0, alice.address(), Up), E18);
    assert_eq!(w.s.trades.len(), 1);
}

#[test]
fn funds_snapshot_overrides_balance_and_enforces_locks() {
    let mut w = W::new(2000);
    let alice = w.alice.clone();
    let a = alice.address();
    let mut hashes = vec![];
    for p in [10u8, 20, 30] {
        let r = w.place(&alice, 0, Up, Buy, p, 3000 * E18 / p as u128, T0).unwrap();
        hashes.push(r.order_hash.unwrap());
    }
    // Alice moved funds out of her wallet: only 40 left spendable.
    w.s.apply_poll(vec![], Some(vec![(a, U256::from(40 * E18))]), ms(T0 + 1));
    assert_eq!(w.s.confirmed.balance(a), U256::from(40 * E18));
    assert_eq!(w.s.ledger.balance(a), U256::from(40 * E18));
    let book = &w.s.books[&0];
    assert!(book.contains(&hashes[0]));
    assert!(!book.contains(&hashes[1]));
    assert!(!book.contains(&hashes[2]));
    // A new wallet user shows up through the watch list.
    let z = Address::repeat_byte(0x5A);
    w.s.watch(z);
    assert!(w.s.tracked_users().contains(&z));
    assert!(w.s.tracked_users().contains(&a));
    w.s.apply_poll(vec![], Some(vec![(z, U256::from(7 * E18))]), ms(T0 + 2));
    assert_eq!(w.s.ledger.balance(z), U256::from(7 * E18));
    // No funds read (native quote): balances untouched.
    w.s.apply_poll(vec![], None, ms(T0 + 3));
    assert_eq!(w.s.ledger.balance(z), U256::from(7 * E18));
}

/// Permissionless `submitBatch`: a third party lands the same match first (a copy of our batch with
/// its own ts), so ours reverts. The fill counts once, from the third party's batch.
#[test]
fn foreign_batch_frontruns_ours() {
    let mut w = W::new(2000);
    let (alice, bob) = (w.alice.clone(), w.bob.clone());
    w.place(&bob, 0, Down, Buy, 40, E18, T0).unwrap();
    w.place(&alice, 0, Up, Buy, 60, E18, T0).unwrap();
    let ours = w.s.cut(ms(T0 + 3)).unwrap();
    let mut theirs = ours.clone();
    theirs.ts = ours.ts + 1;
    w.s.apply_events(
        vec![ChainEvent::BatchSubmitted {
            batch_id: 1,
            ts: theirs.ts,
            fills: 1,
            batch: Some(theirs),
        }],
        ms(T0 + 4),
    );
    // Ours reverts on chain (BadBatchTs / Overfill).
    w.s.on_batch_failed(ms(T0 + 5));
    assert_eq!(w.s.pending_fills(), 0);
    assert_eq!(w.s.confirmed.pairs(0), E18);
    assert_eq!(w.s.ledger.pairs(0), E18, "not double counted");
    assert_eq!(w.s.confirmed.shares(0, alice.address(), Up), E18);
    assert_eq!(w.s.confirmed.shares(0, bob.address(), Down), E18);
    assert_eq!(w.s.trades.len(), 1);
    assert!(w.s.books[&0].is_empty(), "both orders are filled, nothing rests");
    check_invariants(&w);
}
