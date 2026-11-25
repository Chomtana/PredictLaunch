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
