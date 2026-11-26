//! Question-launch API (SPEC "API additions") against `FakeChain` + `MockCournot` (no network).

use std::sync::Arc;

use alloy_primitives::{Address, B256};
use axum::body::Body;
use axum::http::{Request, StatusCode};
use predictlaunch_core::state::ChainEvent;
use predictlaunch_sequencer::api;
use predictlaunch_sequencer::app::{App, Settings};
use predictlaunch_sequencer::cournot::{CournotConfig, Mode};
use predictlaunch_sequencer::oracle::OracleSettings;
use predictlaunch_sequencer::testutil::*;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

const Q: &str = "Will it rain in Boston on 2026-11-27?";

struct T {
    app: Arc<App<FakeChain>>,
    router: axum::Router,
    mock: MockCournot,
}

impl T {
    async fn new(mode: Mode, rate_limit_ms: u64, events: Vec<ChainEvent>) -> T {
        let mock = MockCournot::start(vec![
            market_json(7, "Rain in Boston on Nov 27?", 0.3, 0.854),
            market_json(8, "Rain in Austin?", 0.1, 0.5),
        ])
        .await;
        let chain = FakeChain::new();
        chain.0.lock().unwrap().challenge_window = 120;
        for e in events {
            chain.push(e);
        }
        let settings = Settings {
            domain: test_domain(),
            public_rpc: "http://127.0.0.1:8545".into(),
            factory: Address::repeat_byte(0xFA),
            portal: predictlaunch_core::PORTAL,
            batch_ms: 2000,
            poll_ms: 1000,
            dev_faucet: false,
            start_block: 0,
            price_api: None,
            quote_symbol: None,
            oracle: OracleSettings {
                cournot: CournotConfig {
                    mode,
                    api_base: mock.base.clone(),
                    api_key: None,
                },
                dir: temp_dir("api"),
                rate_limit_ms,
            },
        };
        let app = App::new(chain, settings).await.unwrap();
        let router = api::router(app.clone());
        T { app, router, mock }
    }

    async fn req(&self, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        let mut r = Request::builder().method(method).uri(path);
        let body = match body {
            Some(b) => {
                r = r.header("content-type", "application/json");
                Body::from(b.to_string())
            }
            None => Body::empty(),
        };
        let resp = self
            .router
            .clone()
            .oneshot(r.body(body).unwrap())
            .await
            .unwrap();
        let status = resp.status();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn get(&self, path: &str) -> Value {
        let (s, v) = self.req("GET", path, None).await;
        assert_eq!(s, StatusCode::OK, "{path}: {v}");
        v
    }
}

fn keys(v: &Value) -> Vec<String> {
    let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
    k.sort();
    k
}

fn mixed_launches() -> Vec<ChainEvent> {
    let mut ev = vec![launch_event(
        0,
        now_secs() + 3600,
        Address::repeat_byte(0xFE),
    )];
    ev.extend(question_launch_events(1, now_secs() + 3600, Q, 7));
    ev
}

#[tokio::test]
async fn config_has_cournot_fields() {
    let t = T::new(Mode::Mock, 0, vec![]).await;
    let v = t.get("/api/config").await;
    assert_eq!(v["cournotMode"], "mock");
    assert_eq!(v["challengeWindow"], 120);
    assert_eq!(v["questionDeadline"], 604_800);
    let t = T::new(Mode::Live, 0, vec![]).await;
    assert_eq!(t.get("/api/config").await["cournotMode"], "live");
}

#[tokio::test]
async fn launch_summary_has_kind_and_oracle_fields() {
    let t = T::new(Mode::Mock, 0, mixed_launches()).await;
    let ls = t.get("/api/launches").await;
    // Newest first.
    let (q, p) = (&ls[0], &ls[1]);
    assert_eq!(p["kind"], "price");
    assert_eq!(p["question"], Value::Null);
    assert_eq!(p["marketId"], Value::Null);
    assert_eq!(p["oracleProbability"], Value::Null);
    assert_eq!(p["oracleSource"], Value::Null);
    assert_eq!(q["kind"], "question");
    assert_eq!(q["question"], Q);
    assert_eq!(q["marketId"], 7);
    // No opening record yet.
    assert_eq!(q["oracleProbability"], Value::Null);
    t.app.oracle_open().await;
    let d = t.get("/api/launch/1").await;
    assert_eq!(d["oracleProbability"], 0.3);
    assert_eq!(d["oracleSource"], "mock");
    assert_eq!(d["kind"], "question");
    assert_eq!(t.get("/api/launches").await[0]["oracleProbability"], 0.3);
}

#[tokio::test]
async fn resolve_endpoint_shape() {
    let t = T::new(Mode::Mock, 0, vec![]).await;
    let (s, v) = t
        .req("POST", "/api/cournot/resolve", Some(json!({"message": Q})))
        .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(keys(&v), vec!["markets"]);
    let m = &v["markets"][0];
    assert_eq!(
        keys(m),
        vec![
            "description",
            "endTime",
            "id",
            "matchingConfidence",
            "startTime",
            "title",
            "yesPrice"
        ]
    );
    assert_eq!(m["id"], 7);
    assert_eq!(m["title"], "Rain in Boston on Nov 27?");
    assert_eq!(m["yesPrice"], 0.3);
    assert_eq!(m["matchingConfidence"], 0.854);
    assert_eq!(m["endTime"], "2026-12-09T23:59:00Z");
    assert_eq!(m["startTime"], "");
    assert_eq!(t.mock.state().last_resolve_body.unwrap()["message"], Q);
}

#[tokio::test]
async fn bad_questions_are_rejected() {
    let t = T::new(Mode::Mock, 0, vec![]).await;
    for path in ["/api/cournot/resolve", "/api/cournot/probability"] {
        for q in [json!(""), json!("   "), json!("x".repeat(281)), Value::Null] {
            let (s, v) = t
                .req("POST", path, Some(json!({"message": q, "marketId": 7})))
                .await;
            assert_eq!(s, StatusCode::BAD_REQUEST, "{path} {q}: {v}");
            assert_eq!(v["error"], "bad_question");
            assert!(v["message"].is_string());
        }
    }
    // 280 bytes is fine.
    let (s, _) = t
        .req(
            "POST",
            "/api/cournot/resolve",
            Some(json!({"message": "x".repeat(280)})),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let st = t.mock.state();
    assert_eq!((st.resolve_calls, st.probability_calls), (1, 0));
}

#[tokio::test]
async fn probability_endpoint_returns_a_cached_oracle_record() {
    let t = T::new(Mode::Live, 0, vec![]).await;
    t.mock.set_probability(
        200,
        json!({"code": 0, "data": {"result": {"point_estimate": 0.33}, "basis": {"primary_anchor": {}}}}),
    );
    let body = json!({"message": Q, "marketId": 7});
    let (s, v) = t
        .req("POST", "/api/cournot/probability", Some(body.clone()))
        .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(
        keys(&v),
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
    assert_eq!(v["launchId"], Value::Null);
    assert_eq!(v["claim"], Q);
    assert_eq!(v["marketId"], 7);
    assert_eq!(v["probability"], 0.33);
    assert_eq!(v["source"], "cournot-live");
    assert_eq!(v["market"]["id"], 7);
    assert!(v["raw"].is_object());
    // Same (message, marketId): from the cache. marketId as a string works too.
    let (_, v2) = t
        .req(
            "POST",
            "/api/cournot/probability",
            Some(json!({"message": Q, "marketId": "7"})),
        )
        .await;
    assert_eq!(v2, v);
    assert_eq!(t.mock.state().probability_calls, 1);
}

#[tokio::test]
async fn probability_errors() {
    let t = T::new(Mode::Live, 0, vec![]).await;
    let body = json!({"message": Q, "marketId": 7});
    t.mock.set_probability(402, json!({}));
    let (s, v) = t
        .req("POST", "/api/cournot/probability", Some(body.clone()))
        .await;
    assert_eq!(
        (s, v["error"].as_str()),
        (StatusCode::PAYMENT_REQUIRED, Some("payment_required"))
    );
    t.mock
        .set_probability(200, json!({"code": 4100, "msg": "input error"}));
    let (s, v) = t
        .req("POST", "/api/cournot/probability", Some(body.clone()))
        .await;
    assert_eq!(
        (s, v["error"].as_str()),
        (StatusCode::BAD_REQUEST, Some("bad_question"))
    );
    t.mock.set_probability(503, json!({}));
    let (s, v) = t
        .req("POST", "/api/cournot/probability", Some(body.clone()))
        .await;
    assert_eq!(
        (s, v["error"].as_str()),
        (StatusCode::BAD_GATEWAY, Some("cournot_unavailable"))
    );
    // Errors are not cached.
    t.mock
        .set_probability(200, json!({"code": 0, "data": {"probability": 0.4}}));
    let (s, v) = t.req("POST", "/api/cournot/probability", Some(body)).await;
    assert_eq!((s, v["probability"].as_f64()), (StatusCode::OK, Some(0.4)));
}

#[tokio::test]
async fn post_endpoints_are_rate_limited_per_ip() {
    let t = T::new(Mode::Mock, 2000, vec![]).await;
    let (s, _) = t
        .req("POST", "/api/cournot/resolve", Some(json!({"message": Q})))
        .await;
    assert_eq!(s, StatusCode::OK);
    let (s, v) = t
        .req("POST", "/api/cournot/resolve", Some(json!({"message": Q})))
        .await;
    assert_eq!(s, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(v["error"], "rate_limited");
    // Each endpoint has its own budget, so "Find markets" then "Get Cournot odds" works.
    let (s, _) = t
        .req(
            "POST",
            "/api/cournot/probability",
            Some(json!({"message": Q, "marketId": 7})),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(t.mock.state().resolve_calls, 2);
}

#[tokio::test]
async fn launch_oracle_endpoint() {
    let t = T::new(Mode::Mock, 0, mixed_launches()).await;
    let v = t.get("/api/launch/1/oracle").await;
    assert_eq!(
        keys(&v),
        vec!["opening", "prices", "proposal", "settlement"]
    );
    assert_eq!(v["opening"], Value::Null);
    assert_eq!(v["prices"], json!([]));
    assert_eq!(v["proposal"], Value::Null);
    t.app.oracle_open().await;
    t.app.oracle_track(1000).await;
    let h = B256::repeat_byte(0xAB);
    t.app.chain.push(ChainEvent::OutcomeProposed {
        launch_id: 1,
        outcome: 0,
        evidence_hash: h,
        by: FAKE_OPERATOR,
        final_: false,
        proposed_at: 5000,
    });
    t.app.poll().await.unwrap();
    let v = t.get("/api/launch/1/oracle").await;
    assert_eq!(v["opening"]["launchId"], 1);
    assert_eq!(v["opening"]["probability"], 0.3);
    assert_eq!(v["prices"], json!([{"t": 1000, "price": 0.3}]));
    assert_eq!(
        v["proposal"],
        json!({
            "proposed": true, "outcome": 0, "proposedAt": 5000, "evidenceHash": h,
            "final": false, "challengeEndsAt": 5120
        })
    );
    // A price launch has no oracle data; an unknown launch is 404.
    let p = t.get("/api/launch/0/oracle").await;
    assert_eq!(
        p,
        json!({"opening": null, "prices": [], "settlement": null, "proposal": null})
    );
    assert_eq!(
        t.req("GET", "/api/launch/9/oracle", None).await.0,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn probability_accepts_the_creators_pick() {
    let t = T::new(Mode::Mock, 0, vec![]).await;
    t.mock.set_rotate_ids(true);
    let (s, v) = t
        .req(
            "POST",
            "/api/cournot/probability",
            Some(json!({
                "message": Q,
                "marketId": 7,
                "market": {"title": "Rain in Boston on Nov 27?", "endTime": "2026-12-09T23:59:00Z"}
            })),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["probability"], 0.3);
    assert_eq!(v["marketId"], 7);
    assert_eq!(v["market"]["title"], "Rain in Boston on Nov 27?");
    assert_eq!(v["market"]["end_time"], "2026-12-09T23:59:00Z");
    assert_eq!(v["market"]["id"], 1_000_007);
}
