//! Oracle store, opening call, tracker and resolver against `FakeChain` + `MockCournot` (no network).

use std::path::PathBuf;
use std::sync::Arc;

use alloy_primitives::{keccak256, Address, B256};
use bilauncher_core::state::ChainEvent;
use bilauncher_core::MAX_LAG;
use bilauncher_sequencer::app::{App, Settings};
use bilauncher_sequencer::cournot::{CournotConfig, Mode, OracleRecord};
use bilauncher_sequencer::keeper::KeeperAction;
use bilauncher_sequencer::oracle::{OracleSettings, OracleStore, PricePoint};
use bilauncher_sequencer::testutil::*;
use serde_json::json;

const Q: &str = "Will it rain in Boston on 2026-11-27?";

fn settings(base: &str, mode: Mode, key: Option<&str>, dir: PathBuf) -> Settings {
    Settings {
        domain: test_domain(),
        public_rpc: "http://127.0.0.1:8545".into(),
        factory: Address::repeat_byte(0xFA),
        portal: bilauncher_core::PORTAL,
        batch_ms: 2000,
        poll_ms: 1000,
        dev_faucet: false,
        start_block: 0,
        price_api: None,
        quote_symbol: None,
        oracle: OracleSettings {
            cournot: CournotConfig {
                mode,
                api_base: base.into(),
                api_key: key.map(Into::into),
            },
            dir,
            rate_limit_ms: 0,
        },
    }
}

async fn app_with(
    events: Vec<ChainEvent>,
    base: &str,
    mode: Mode,
    key: Option<&str>,
    dir: PathBuf,
) -> Arc<App<FakeChain>> {
    let chain = FakeChain::new();
    for e in events {
        chain.push(e);
    }
    App::new(chain, settings(base, mode, key, dir))
        .await
        .unwrap()
}

#[test]
fn evidence_hash_is_keccak_of_the_file_bytes() {
    let dir = temp_dir("evidence");
    let s = OracleStore::new(&dir);
    let r = OracleRecord {
        launch_id: Some(1),
        claim: Q.into(),
        market_id: 7,
        market: None,
        probability: Some(0.99),
        result: Some(json!({"outcome": 0})),
        basis: None,
        source: "cournot-live".into(),
        fetched_at: 5,
        error: None,
        raw: None,
    };
    let h = s.write_settlement(1, &r).unwrap();
    let bytes = std::fs::read(dir.join("settle-1.json")).unwrap();
    assert_eq!(h, keccak256(&bytes));
    assert_eq!(s.settlement(1), Some(r));
    // Prices append in order.
    s.append_price(1, PricePoint { t: 1, price: 0.4 }).unwrap();
    s.append_price(1, PricePoint { t: 61, price: 0.5 }).unwrap();
    assert_eq!(s.prices(1).len(), 2);
    let v: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join("price-1.json")).unwrap()).unwrap();
    assert_eq!(v, json!([{"t": 1, "price": 0.4}, {"t": 61, "price": 0.5}]));
}

#[test]
fn oracle_record_json_shape() {
    let r = OracleRecord {
        launch_id: None,
        claim: Q.into(),
        market_id: 7,
        market: None,
        probability: None,
        result: None,
        basis: None,
        source: "mock".into(),
        fetched_at: 5,
        error: None,
        raw: None,
    };
    let v = serde_json::to_value(&r).unwrap();
    let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(|k| k.as_str()).collect();
    keys.sort();
    assert_eq!(
        keys,
        vec![
            "basis",
            "claim",
            "error",
            "fetchedAt",
            "launchId",
            "market",
            "marketId",
            "probability",
            "raw",
            "result",
            "source"
        ]
    );
    assert!(v["launchId"].is_null());
}

#[tokio::test]
async fn opening_reuses_the_preview_cache() {
    let m = MockCournot::start(vec![market_json(7, "Rain in Boston?", 0.3, 0.9)]).await;
    m.set_probability(
        200,
        json!({"code": 0, "data": {"result": {"point_estimate": 0.31}}}),
    );
    let dir = temp_dir("preview");
    let app = app_with(vec![], &m.base, Mode::Live, None, dir.clone()).await;
    // A creator previews the odds ...
    let p = app.oracle_preview(Q, 7).await.unwrap();
    assert_eq!(p.probability, Some(0.31));
    assert_eq!(p.launch_id, None);
    // ... a second preview of the same (claim, marketId) is served from the cache ...
    app.oracle_preview(Q, 7).await.unwrap();
    assert_eq!(m.state().probability_calls, 1);
    // ... and so is the launch's opening record.
    for e in question_launch_events(0, now_secs() + 3600, Q, 7) {
        app.chain.push(e);
    }
    app.poll().await.unwrap();
    assert_eq!(app.oracle_open().await, 0);
    assert_eq!(m.state().probability_calls, 1);
    let r = app.oracle.store.opening(0).unwrap();
    assert_eq!((r.launch_id, r.probability), (Some(0), Some(0.31)));
    assert_eq!(app.oracle.brief(0).unwrap().probability, Some(0.31));
    // A different market id is a different preview.
    app.oracle_preview(Q, 8).await.unwrap();
    assert_eq!(m.state().probability_calls, 2);
}

#[tokio::test]
async fn opening_is_called_once_per_launch_even_across_restarts() {
    let m = MockCournot::start(vec![]).await;
    m.set_probability(200, json!({"code": 0, "data": {"probability": 0.7}}));
    let dir = temp_dir("opening");
    let ev = question_launch_events(0, now_secs() + 3600, Q, 7);
    let app = app_with(ev.clone(), &m.base, Mode::Live, Some("k"), dir.clone()).await;
    assert_eq!(app.oracle_open().await, 1);
    assert_eq!(app.oracle_open().await, 0);
    drop(app);
    let app = app_with(ev, &m.base, Mode::Live, Some("k"), dir.clone()).await;
    assert_eq!(app.oracle_open().await, 0);
    assert_eq!(m.state().probability_calls, 1);
    assert_eq!(app.oracle.brief(0).unwrap().probability, Some(0.7));
    assert_eq!(app.oracle.brief(0).unwrap().source, "cournot-live");
}

#[tokio::test]
async fn failed_opening_is_recorded_and_not_retried() {
    let m = MockCournot::start(vec![]).await;
    m.set_probability(402, json!({}));
    let dir = temp_dir("opening402");
    let app = app_with(
        question_launch_events(0, now_secs() + 3600, Q, 7),
        &m.base,
        Mode::Live,
        None,
        dir,
    )
    .await;
    assert_eq!(app.oracle_open().await, 1);
    let r = app.oracle.store.opening(0).unwrap();
    assert!(r.error.as_deref().unwrap().starts_with("payment_required"));
    assert_eq!(r.probability, None);
    assert_eq!(app.oracle_open().await, 0);
    assert_eq!(m.state().probability_calls, 1);
}

#[tokio::test]
async fn price_launches_get_no_oracle_calls() {
    let m = MockCournot::start(vec![]).await;
    let app = app_with(
        vec![launch_event(
            0,
            now_secs() + 3600,
            Address::repeat_byte(0xFE),
        )],
        &m.base,
        Mode::Mock,
        None,
        temp_dir("price"),
    )
    .await;
    assert_eq!(app.oracle_open().await, 0);
    app.oracle_track(now_secs()).await;
    let st = m.state();
    assert_eq!((st.resolve_calls, st.probability_calls), (0, 0));
}

#[tokio::test]
async fn tracker_appends_the_market_price() {
    let m = MockCournot::start(vec![market_json(7, "Rain in Boston?", 0.3, 0.9)]).await;
    let mut ev = question_launch_events(0, now_secs() + 3600, Q, 7);
    ev.extend(question_launch_events(
        1,
        now_secs() + 3600,
        "No market?",
        0,
    ));
    ev.extend(question_launch_events(2, now_secs() + 3600, "Gone?", 99));
    let app = app_with(ev, &m.base, Mode::Live, None, temp_dir("track")).await;
    app.oracle_track(100).await;
    m.set_markets(vec![market_json(7, "Rain in Boston?", 0.45, 0.9)]);
    app.oracle_track(160).await;
    assert_eq!(
        app.oracle.store.prices(0),
        vec![
            PricePoint { t: 100, price: 0.3 },
            PricePoint {
                t: 160,
                price: 0.45
            }
        ]
    );
    assert!(app.oracle.store.prices(1).is_empty());
    assert!(app.oracle.store.prices(2).is_empty());
    // marketId 0 is never tracked: two launches × two ticks.
    assert_eq!(m.state().resolve_calls, 4);
}

fn settled_question(market_id: u64) -> (Vec<ChainEvent>, u64) {
    let settle = now_secs() - 100;
    (question_launch_events(0, settle, Q, market_id), settle)
}

#[tokio::test]
async fn resolver_proposes_from_the_tracked_price() {
    let m = MockCournot::start(vec![market_json(7, "Rain in Boston?", 0.98, 0.9)]).await;
    let (ev, settle) = settled_question(7);
    let dir = temp_dir("resolve-yes");
    let app = app_with(ev, &m.base, Mode::Live, None, dir.clone()).await;
    // Not due before settleTime + MAX_LAG.
    assert!(app.oracle_resolve(settle + MAX_LAG - 1).await.is_empty());
    app.oracle_track(settle + 10).await;
    let now = settle + MAX_LAG;
    let r = app.oracle_resolve(now).await;
    assert_eq!(r.len(), 1);
    let bytes = std::fs::read(dir.join("settle-0.json")).unwrap();
    let h = keccak256(&bytes);
    assert_eq!(r[0].0, KeeperAction::Propose(0, 0, h));
    assert!(r[0].1.is_ok());
    assert_eq!(app.chain.calls(), vec![format!("propose 0 0 {h}")]);
    let s = app.oracle.store.settlement(0).unwrap();
    assert_eq!(s.probability, Some(0.98));
    assert_eq!(s.result.as_ref().unwrap()["outcome"], 0);
    assert_eq!(s.result.as_ref().unwrap()["outcomeName"], "YES");
    assert_eq!(s.market.as_ref().unwrap()["id"], 7);
    // No probability call was needed; nothing is re-sent while the event is on its way.
    assert_eq!(m.state().probability_calls, 0);
    assert!(app.oracle_resolve(now + 1).await.is_empty());
}

#[tokio::test]
async fn resolver_resends_the_same_evidence_after_a_failed_proposal() {
    let m = MockCournot::start(vec![market_json(7, "Rain in Boston?", 0.01, 0.9)]).await;
    let (ev, settle) = settled_question(7);
    let app = app_with(ev, &m.base, Mode::Live, None, temp_dir("resend")).await;
    app.oracle_track(settle).await;
    app.chain.0.lock().unwrap().fail_propose = true;
    let r = app.oracle_resolve(settle + MAX_LAG).await;
    assert!(r[0].1.is_err());
    let KeeperAction::Propose(_, outcome, h1) = r[0].0.clone() else {
        panic!()
    };
    assert_eq!(outcome, 1);
    app.chain.0.lock().unwrap().fail_propose = false;
    // The market moved, but the decision stands: same file, same hash.
    m.set_markets(vec![market_json(7, "Rain in Boston?", 0.5, 0.9)]);
    app.oracle_track(settle + 60).await;
    let r = app.oracle_resolve(settle + MAX_LAG + 2).await;
    assert_eq!(r[0].0, KeeperAction::Propose(0, 1, h1));
    assert!(r[0].1.is_ok());
}

#[tokio::test]
async fn resolver_second_call_once_with_key() {
    let m = MockCournot::start(vec![market_json(7, "Rain in Boston?", 0.5, 0.9)]).await;
    m.set_probability(
        200,
        json!({"code": 0, "data": {"result": {"point_estimate": 0.6}}}),
    );
    let (ev, settle) = settled_question(7);
    let app = app_with(ev, &m.base, Mode::Live, Some("k"), temp_dir("recheck")).await;
    app.oracle_track(settle).await;
    // Undecided by price (0.5) and by the extra call (0.6): nothing proposed.
    assert!(app.oracle_resolve(settle + MAX_LAG).await.is_empty());
    assert_eq!(m.state().probability_calls, 1);
    // Never a second extra call.
    m.set_probability(
        200,
        json!({"code": 0, "data": {"result": {"point_estimate": 0.01}}}),
    );
    assert!(app.oracle_resolve(settle + MAX_LAG + 5).await.is_empty());
    assert_eq!(m.state().probability_calls, 1);
    assert!(app.chain.calls().is_empty());
    // The tracked price can still decide later.
    m.set_markets(vec![market_json(7, "Rain in Boston?", 0.975, 0.9)]);
    app.oracle_track(settle + 60).await;
    let r = app.oracle_resolve(settle + 70).await;
    assert!(matches!(r[0].0, KeeperAction::Propose(0, 0, _)));
}

#[tokio::test]
async fn resolver_second_call_decides_with_key() {
    let m = MockCournot::start(vec![]).await;
    m.set_probability(
        200,
        json!({"code": 0, "data": {"probability": {"point_estimate": 0.02}}}),
    );
    let (ev, settle) = settled_question(0);
    let dir = temp_dir("recheck-no");
    let app = app_with(ev, &m.base, Mode::Live, Some("k"), dir.clone()).await;
    let r = app.oracle_resolve(settle + MAX_LAG).await;
    let h = keccak256(std::fs::read(dir.join("settle-0.json")).unwrap());
    assert_eq!(r[0].0, KeeperAction::Propose(0, 1, h));
    let s = app.oracle.store.settlement(0).unwrap();
    assert_eq!(s.result.as_ref().unwrap()["decidedBy"], "probability");
    assert!(s.raw.is_some());
}

#[tokio::test]
async fn live_without_key_never_makes_the_extra_call() {
    let m = MockCournot::start(vec![market_json(7, "Rain in Boston?", 0.5, 0.9)]).await;
    let (ev, settle) = settled_question(7);
    let app = app_with(ev, &m.base, Mode::Live, None, temp_dir("nokey")).await;
    app.oracle_track(settle).await;
    assert!(app.oracle_resolve(settle + MAX_LAG).await.is_empty());
    assert_eq!(m.state().probability_calls, 0);
}

#[tokio::test]
async fn mock_mode_extra_call_uses_the_market_price() {
    let m = MockCournot::start(vec![market_json(7, "Rain in Boston?", 0.99, 0.9)]).await;
    let (ev, settle) = settled_question(7);
    let app = app_with(ev, &m.base, Mode::Mock, None, temp_dir("mockres")).await;
    // No tracked price yet: the mock "probability" (a resolve) decides.
    let r = app.oracle_resolve(settle + MAX_LAG).await;
    assert!(matches!(r[0].0, KeeperAction::Propose(0, 0, _)));
    let st = m.state();
    assert_eq!((st.probability_calls, st.resolve_calls), (0, 1));
    assert_eq!(app.oracle.store.settlement(0).unwrap().source, "mock");
}

#[tokio::test]
async fn resolver_waits_when_not_the_resolver() {
    let m = MockCournot::start(vec![market_json(7, "Rain in Boston?", 0.99, 0.9)]).await;
    let (ev, settle) = settled_question(7);
    let chain = FakeChain::new();
    chain.0.lock().unwrap().resolver = Some(Address::repeat_byte(0x55));
    for e in ev {
        chain.push(e);
    }
    let app = App::new(
        chain,
        settings(&m.base, Mode::Mock, None, temp_dir("notres")),
    )
    .await
    .unwrap();
    assert!(app.oracle_resolve(settle + MAX_LAG).await.is_empty());
    assert!(app.chain.calls().is_empty());
}

#[tokio::test]
async fn proposed_launch_is_left_alone() {
    let m = MockCournot::start(vec![market_json(7, "Rain in Boston?", 0.99, 0.9)]).await;
    let (mut ev, settle) = settled_question(7);
    ev.push(ChainEvent::OutcomeProposed {
        launch_id: 0,
        outcome: 1,
        evidence_hash: B256::ZERO,
        by: FAKE_OPERATOR,
        final_: false,
        proposed_at: settle + MAX_LAG,
    });
    let app = app_with(ev, &m.base, Mode::Mock, None, temp_dir("proposed")).await;
    assert!(app.oracle_resolve(settle + MAX_LAG + 5).await.is_empty());
    assert_eq!(m.state().resolve_calls, 0);
}
