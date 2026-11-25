//! Keeper schedule (pure, `keeper_actions`) and batch failure handling against `FakeChain`.

use alloy_primitives::{Address, U256};
use bilauncher_core::eip712::TestKey;
use bilauncher_core::state::{ChainEvent, Config, LaunchStatus, Msg, State};
use bilauncher_core::{Outcome, Side, GRACE, MAX_LAG};
use bilauncher_sequencer::app::{App, Settings};
use bilauncher_sequencer::keeper::{keeper_actions, KeeperAction};
use bilauncher_sequencer::testutil::*;

const T: u64 = 1_900_000_000;
const FEED: Address = Address::repeat_byte(0xFE);

fn state_with(events: Vec<ChainEvent>) -> State {
    let mut s = State::new(Config {
        domain: test_domain(),
        batch_ms: 2000,
    });
    s.apply_events(events, (T - 1000) * 1000);
    s
}

#[test]
fn keeper_snapshots_at_settle() {
    let s = state_with(vec![launch_event(0, T, FEED)]);
    assert!(keeper_actions(&s, T - 1).is_empty());
    assert_eq!(keeper_actions(&s, T), vec![KeeperAction::Snapshot(0)]);
    // Retried until the grace window closes.
    assert!(keeper_actions(&s, T + GRACE).contains(&KeeperAction::Snapshot(0)));
    assert!(!keeper_actions(&s, T + GRACE + 1).contains(&KeeperAction::Snapshot(0)));
    // Once snapped, no more snapshots.
    let mut s = s;
    s.apply_events(
        vec![ChainEvent::Snapshot {
            launch_id: 0,
            price: U256::from(1u64),
            updated_at: T,
        }],
        T * 1000,
    );
    assert!(keeper_actions(&s, T + 1).is_empty());
}

#[test]
fn keeper_resolves_after_lag() {
    let mut s = state_with(vec![
        launch_event(0, T, FEED),
        launch_event(1, T + 100, FEED),
    ]);
    s.apply_events(
        vec![ChainEvent::Snapshot {
            launch_id: 0,
            price: U256::from(1u64),
            updated_at: T + 1,
        }],
        T * 1000,
    );
    assert!(keeper_actions(&s, T + MAX_LAG - 1).is_empty());
    assert_eq!(
        keeper_actions(&s, T + MAX_LAG),
        vec![KeeperAction::Resolve(0)]
    );
    // Launch 1 was never snapped: void-resolvable only after the grace window.
    let t1 = T + 100;
    let a = keeper_actions(&s, t1 + MAX_LAG);
    assert!(a.contains(&KeeperAction::Snapshot(1)));
    assert!(!a.contains(&KeeperAction::Resolve(1)));
    let a = keeper_actions(&s, t1 + GRACE + 1);
    assert!(a.contains(&KeeperAction::Resolve(1)));
    assert!(!a.contains(&KeeperAction::Snapshot(1)));
    // A late keeper catches up on everything at once, in launch order.
    let a = keeper_actions(&s, T + 10_000);
    assert_eq!(a, vec![KeeperAction::Resolve(0), KeeperAction::Resolve(1)]);
}

fn traded_state(n_users: usize) -> (State, Vec<TestKey>) {
    let keys: Vec<TestKey> = (0..n_users)
        .map(|i| TestKey::from_seed(&format!("user{i}")))
        .collect();
    let mut ev = vec![launch_event(0, T, FEED)];
    ev.extend(keys.iter().map(|k| deposit(k.address(), 10)));
    let mut s = state_with(ev);
    let d = test_domain();
    let now = (T - 500) * 1000;
    for pair in keys.chunks(2) {
        let (a, b) = (&pair[0], &pair[1]);
        let (o1, s1) = signed_order(&d, a, 0, Outcome::Up, Side::Buy, 60, E18);
        let (o2, s2) = signed_order(&d, b, 0, Outcome::Down, Side::Buy, 40, E18);
        s.accept_group(
            vec![
                Msg::Place { order: o1, sig: s1 },
                Msg::Place { order: o2, sig: s2 },
            ],
            now,
        )
        .unwrap();
    }
    // Settle the batch onchain.
    let b = s.cut(now + 10_000).unwrap();
    s.apply_events(
        vec![ChainEvent::BatchSubmitted {
            batch_id: 1,
            ts: b.ts,
            fills: b.fills.len() as u64,
            batch: Some(b),
        }],
        now + 11_000,
    );
    (s, keys)
}

#[test]
fn keeper_redeems_all_holders() {
    let (mut s, keys) = traded_state(120);
    assert_eq!(s.holders(0).len(), 120);
    s.apply_events(
        vec![
            ChainEvent::Snapshot {
                launch_id: 0,
                price: U256::from(1u64),
                updated_at: T,
            },
            ChainEvent::Resolved {
                launch_id: 0,
                outcome: 1,
                pairs: U256::from(60 * E18),
                raised: U256::from(6 * E18),
            },
            ChainEvent::LaunchFailed { launch_id: 0 },
        ],
        (T + 20) * 1000,
    );
    let a = keeper_actions(&s, T + 20);
    let chunks: Vec<usize> = a
        .iter()
        .map(|x| match x {
            KeeperAction::Redeem(0, u) => u.len(),
            other => panic!("unexpected {other:?}"),
        })
        .collect();
    assert_eq!(chunks, vec![50, 50, 20]);
    // Redeemed holders drop out.
    let redeemed: Vec<ChainEvent> = keys[..50]
        .iter()
        .map(|k| ChainEvent::Redeemed {
            launch_id: 0,
            user: k.address(),
            credit: U256::ZERO,
            loser_shares: U256::from(E18),
        })
        .collect();
    s.apply_events(redeemed, (T + 21) * 1000);
    assert_eq!(s.holders(0).len(), 70);
    assert_eq!(s.loser_shares[&(0, keys[0].address())], U256::from(E18));
}

#[test]
fn keeper_graduates() {
    let (mut s, _) = traded_state(2);
    s.apply_events(
        vec![
            ChainEvent::Snapshot {
                launch_id: 0,
                price: U256::from(1u64),
                updated_at: T,
            },
            ChainEvent::Resolved {
                launch_id: 0,
                outcome: 0,
                pairs: U256::from(E18),
                raised: U256::from(3 * E18),
            },
            ChainEvent::Graduating { launch_id: 0 },
        ],
        (T + 20) * 1000,
    );
    assert_eq!(s.launches[&0].status, LaunchStatus::Graduating);
    let a = keeper_actions(&s, T + 20);
    assert_eq!(a.last(), Some(&KeeperAction::Graduate(0)));
    assert!(matches!(a[0], KeeperAction::Redeem(0, _)));
    s.apply_events(
        vec![ChainEvent::Graduated {
            launch_id: 0,
            token: Address::repeat_byte(0x77),
            raised: U256::from(3 * E18),
        }],
        (T + 30) * 1000,
    );
    assert!(!keeper_actions(&s, T + 30).contains(&KeeperAction::Graduate(0)));
}

fn settings() -> Settings {
    Settings {
        domain: test_domain(),
        public_rpc: "http://127.0.0.1:8545".into(),
        factory: Address::repeat_byte(0xFA),
        portal: bilauncher_core::PORTAL,
        batch_ms: 0,
        poll_ms: 1000,
        dev_faucet: false,
        start_block: 0,
        price_api: None,
        quote_symbol: None,
        oracle: bilauncher_sequencer::testutil::offline_oracle(),
    }
}

#[tokio::test]
async fn failed_batch_restores_state() {
    let chain = FakeChain::new();
    let (alice, bob) = (TestKey::from_seed("alice"), TestKey::from_seed("bob"));
    let settle = now_secs() + 3600;
    chain.push(launch_event(0, settle, FEED));
    chain.push(deposit(alice.address(), 10));
    chain.push(deposit(bob.address(), 10));
    let app = App::new(chain, settings()).await.unwrap();
    let d = test_domain();
    let trade = |app: &App<FakeChain>| {
        let (o1, s1) = signed_order(&d, &alice, 0, Outcome::Up, Side::Buy, 60, E18);
        let (o2, s2) = signed_order(&d, &bob, 0, Outcome::Down, Side::Buy, 40, E18);
        app.submit_group(vec![
            Msg::Place { order: o1, sig: s1 },
            Msg::Place { order: o2, sig: s2 },
        ])
        .unwrap();
    };
    trade(&app);
    {
        let s = app.state.lock().unwrap();
        assert_eq!(s.pending_fills(), 1);
        assert_eq!(s.ledger.balance(alice.address()), U256::from(94 * E18 / 10));
    }
    app.chain.set_fail_simulate(true);
    assert!(app.run_batch().await.is_err());
    {
        let s = app.state.lock().unwrap();
        assert_eq!(s.soft_reversals, 1);
        assert_eq!(s.pending_fills(), 0);
        assert_eq!(s.ledger.balance(alice.address()), U256::from(10 * E18));
        assert_eq!(s.ledger.balance(bob.address()), U256::from(10 * E18));
        assert_eq!(s.ledger.pairs(0), 0);
        assert!(s.trades.is_empty());
    }
    assert!(app.chain.batches().is_empty());

    // The next batch goes through and lands in the confirmed mirror.
    app.chain.set_fail_simulate(false);
    trade(&app);
    assert!(app.run_batch().await.unwrap().is_some());
    let s = app.state.lock().unwrap();
    assert_eq!(app.chain.batches().len(), 1);
    assert_eq!(s.pending_fills(), 0);
    assert!(!s.inflight());
    assert_eq!(
        s.confirmed.balance(alice.address()),
        U256::from(94 * E18 / 10)
    );
    assert_eq!(s.confirmed.position(0, alice.address()), (E18, 0));
    assert_eq!(s.last_batch_id, 1);
}

#[tokio::test]
async fn keeper_runs_actions_against_chain() {
    let chain = FakeChain::new();
    let settle = now_secs() - 20; // settled 20 s ago, never snapped
    chain.push(launch_event(0, settle, FEED));
    let app = App::new(chain, settings()).await.unwrap();
    let r = app.run_keeper().await;
    assert_eq!(r.len(), 1);
    assert_eq!(app.chain.calls(), vec!["snapshot 0".to_string()]);
    // Backoff: not re-sent before the events arrive.
    app.run_keeper().await;
    assert_eq!(app.chain.calls().len(), 1);
}

// ------------------------------------------------------------------------- question launches

use alloy_primitives::B256;
use bilauncher_core::QUESTION_DEADLINE;
use bilauncher_sequencer::keeper::{decide, proposals_due};

fn proposed(id: u64, outcome: u8, at: u64, final_: bool) -> ChainEvent {
    ChainEvent::OutcomeProposed {
        launch_id: id,
        outcome,
        evidence_hash: B256::repeat_byte(0xEE),
        by: Address::repeat_byte(0x0F),
        final_,
        proposed_at: at,
    }
}

#[test]
fn question_launch_is_never_snapshotted() {
    let s = state_with(question_launch_events(0, T, "Will it rain?", 7));
    for now in [T, T + 1, T + GRACE, T + GRACE + 1] {
        assert!(
            !keeper_actions(&s, now).contains(&KeeperAction::Snapshot(0)),
            "at {now}"
        );
    }
}

#[test]
fn unproposed_question_voids_only_after_deadline() {
    let s = state_with(question_launch_events(0, T, "Will it rain?", 7));
    // Unlike a price launch, the grace window does not make it resolvable.
    assert!(keeper_actions(&s, T + GRACE + 1).is_empty());
    assert!(keeper_actions(&s, T + QUESTION_DEADLINE).is_empty());
    assert_eq!(
        keeper_actions(&s, T + QUESTION_DEADLINE + 1),
        vec![KeeperAction::Resolve(0)]
    );
}

#[test]
fn proposed_question_resolves_after_challenge_window() {
    let mut s = state_with(question_launch_events(0, T, "Will it rain?", 7));
    s.challenge_window = 120;
    let p = T + MAX_LAG + 5;
    s.apply_events(vec![proposed(0, 0, p, false)], p * 1000);
    assert!(keeper_actions(&s, p + 119).is_empty());
    assert_eq!(keeper_actions(&s, p + 120), vec![KeeperAction::Resolve(0)]);
    // Past the deadline a pending proposal still waits for its window.
    s.challenge_window = 7 * 86_400;
    assert!(keeper_actions(&s, T + QUESTION_DEADLINE + 10).is_empty());
}

#[test]
fn final_override_resolves_at_once() {
    let mut s = state_with(question_launch_events(0, T, "Will it rain?", 7));
    let p = T + MAX_LAG;
    s.apply_events(vec![proposed(0, 2, p, true)], p * 1000);
    assert_eq!(keeper_actions(&s, p), vec![KeeperAction::Resolve(0)]);
}

#[test]
fn question_launch_redeems_and_graduates_like_price() {
    let mut s = state_with(question_launch_events(0, T, "Will it rain?", 7));
    s.apply_events(
        vec![
            ChainEvent::Resolved {
                launch_id: 0,
                outcome: 0,
                pairs: U256::from(E18),
                raised: U256::from(3 * E18),
            },
            ChainEvent::Graduating { launch_id: 0 },
        ],
        (T + 20) * 1000,
    );
    assert_eq!(keeper_actions(&s, T + 20), vec![KeeperAction::Graduate(0)]);
}

#[test]
fn proposals_due_rule() {
    let mut ev = question_launch_events(0, T, "Will it rain?", 7);
    ev.extend(question_launch_events(1, T, "Will it snow?", 0));
    ev.push(launch_event(2, T, FEED));
    let mut s = state_with(ev);
    assert!(proposals_due(&s, T + MAX_LAG - 1).is_empty());
    // Price launches never; question launches with or without a market.
    assert_eq!(proposals_due(&s, T + MAX_LAG), vec![0, 1]);
    s.apply_events(
        vec![proposed(0, 1, T + MAX_LAG, false)],
        (T + MAX_LAG) * 1000,
    );
    assert_eq!(proposals_due(&s, T + MAX_LAG + 1), vec![1]);
    s.apply_events(
        vec![
            ChainEvent::Resolved {
                launch_id: 1,
                outcome: 2,
                pairs: U256::ZERO,
                raised: U256::ZERO,
            },
            ChainEvent::LaunchFailed { launch_id: 1 },
        ],
        (T + MAX_LAG + 2) * 1000,
    );
    assert!(proposals_due(&s, T + MAX_LAG + 3).is_empty());
}

#[test]
fn decision_thresholds() {
    assert_eq!(decide(0.97), Some(0));
    assert_eq!(decide(0.999), Some(0));
    assert_eq!(decide(1.0), Some(0));
    assert_eq!(decide(0.9699), None);
    assert_eq!(decide(0.5), None);
    assert_eq!(decide(0.0301), None);
    assert_eq!(decide(0.03), Some(1));
    assert_eq!(decide(0.0), Some(1));
    assert_eq!(decide(f64::NAN), None);
}

#[tokio::test]
async fn keeper_propose_action_calls_chain() {
    let chain = FakeChain::new();
    let app = App::new(chain, settings()).await.unwrap();
    let a = KeeperAction::Propose(3, 1, B256::repeat_byte(0xAB));
    assert_eq!(a.launch(), 3);
    assert!(app.execute(&a).await.is_ok());
    assert_eq!(
        app.chain.calls(),
        vec![format!("propose 3 1 {}", B256::repeat_byte(0xAB))]
    );
}

#[tokio::test]
async fn app_reads_challenge_window_from_chain() {
    let chain = FakeChain::new();
    chain.0.lock().unwrap().challenge_window = 120;
    let app = App::new(chain, settings()).await.unwrap();
    assert_eq!(app.state.lock().unwrap().challenge_window, 120);
}
