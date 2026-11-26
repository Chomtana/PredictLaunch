//! Cournot client against a local mock server (no network): lenient parsing, error mapping,
//! mock mode.

use predictlaunch_sequencer::cournot::{
    parse_probability, Cournot, CournotConfig, CournotError, Mode, SOURCE_LIVE, SOURCE_MOCK,
};
use predictlaunch_sequencer::testutil::{market_json, MockCournot};
use serde_json::json;

fn live(base: &str, key: Option<&str>) -> Cournot {
    Cournot::new(CournotConfig {
        mode: Mode::Live,
        api_base: base.into(),
        api_key: key.map(Into::into),
    })
}

fn mock_mode(base: &str) -> Cournot {
    Cournot::new(CournotConfig {
        mode: Mode::Mock,
        api_base: base.into(),
        api_key: None,
    })
}

#[test]
fn mode_parses() {
    assert_eq!("live".parse::<Mode>().unwrap(), Mode::Live);
    assert_eq!("MOCK".parse::<Mode>().unwrap(), Mode::Mock);
    assert!("x402".parse::<Mode>().is_err());
    assert_eq!(Mode::default(), Mode::Live);
    assert_eq!(Mode::Mock.as_str(), "mock");
}

#[test]
fn config_debug_never_shows_the_key() {
    let c = CournotConfig {
        mode: Mode::Live,
        api_base: "http://x".into(),
        api_key: Some("sk-secret-123".into()),
    };
    assert!(!format!("{c:?}").contains("sk-secret-123"));
}

#[test]
fn lenient_parsing_result_point_estimate() {
    let body = json!({"code": 0, "data": {
        "result": {"point_estimate": 0.62, "interval": [0.5, 0.7]},
        "basis": {"primary_anchor": {"source": "polymarket"}}
    }});
    let p = parse_probability(&body);
    assert_eq!(p.point, Some(0.62));
    assert_eq!(
        p.result,
        Some(json!({"point_estimate": 0.62, "interval": [0.5, 0.7]}))
    );
    assert_eq!(
        p.basis,
        Some(json!({"primary_anchor": {"source": "polymarket"}}))
    );
}

#[test]
fn lenient_parsing_probability_object() {
    let body = json!({"code": 0, "data": {
        "probability": {"point_estimate": 0.2, "basis": [{"source": "a"}, {"source": "b"}]}
    }});
    let p = parse_probability(&body);
    assert_eq!(p.point, Some(0.2));
    assert_eq!(p.basis, Some(json!([{"source": "a"}, {"source": "b"}])));
    assert_eq!(
        p.result,
        Some(json!({"point_estimate": 0.2, "basis": [{"source": "a"}, {"source": "b"}]}))
    );
}

#[test]
fn lenient_parsing_probability_number() {
    let body = json!({"code": 0, "data": {"probability": 0.81, "basis": "text"}});
    let p = parse_probability(&body);
    assert_eq!(p.point, Some(0.81));
    assert_eq!(p.result, Some(json!(0.81)));
    assert_eq!(p.basis, Some(json!("text")));
    // A numeric string is accepted too; out-of-range or missing → null.
    assert_eq!(
        parse_probability(&json!({"data": {"probability": "0.4"}})).point,
        Some(0.4)
    );
    assert_eq!(
        parse_probability(&json!({"data": {"probability": 62}})).point,
        None
    );
    let none = parse_probability(&json!({"code": 0, "data": {"something": 1}}));
    assert_eq!((none.point, none.result, none.basis), (None, None, None));
}

#[tokio::test]
async fn resolve_parses_markets() {
    let m = MockCournot::start(vec![market_json(2849008, "Fed hike?", 0.9336, 0.854)]).await;
    let c = live(&m.base, None);
    let r = c.resolve("Will the Fed hike?", 5).await.unwrap();
    assert_eq!(r.len(), 1);
    assert_eq!(r[0].id, 2849008);
    assert_eq!(r[0].title, "Fed hike?");
    assert_eq!(r[0].yes_price, Some(0.9336));
    assert_eq!(r[0].matching_confidence, Some(0.854));
    assert_eq!(r[0].end_time, "2026-12-09T23:59:00Z");
    assert_eq!(r[0].info["market_outcome"], "YES");
    let st = m.state();
    assert_eq!(st.resolve_calls, 1);
    assert_eq!(
        st.last_resolve_body,
        Some(json!({"message": "Will the Fed hike?", "limit": 5}))
    );
}

#[tokio::test]
async fn resolve_limit_is_capped_at_10() {
    let m = MockCournot::start(vec![]).await;
    live(&m.base, None).resolve("q", 50).await.unwrap();
    assert_eq!(m.state().last_resolve_body.unwrap()["limit"], 10);
}

#[tokio::test]
async fn live_probability_keeps_raw_and_sends_key() {
    let m = MockCournot::start(vec![market_json(7, "Rain in Boston?", 0.3, 0.9)]).await;
    let body = json!({"code": 0, "msg": "Success", "data": {
        "result": {"point_estimate": 0.35}, "basis": {"primary_anchor": {"source": "x"}}
    }});
    m.set_probability(200, body.clone());
    let c = live(&m.base, Some("k-123"));
    let r = c
        .probability("Will it rain in Boston?", 7, None, Some(3))
        .await
        .unwrap();
    assert_eq!(r.launch_id, Some(3));
    assert_eq!(r.claim, "Will it rain in Boston?");
    assert_eq!(r.market_id, 7);
    assert_eq!(r.probability, Some(0.35));
    assert_eq!(r.source, SOURCE_LIVE);
    assert_eq!(r.raw, Some(body));
    assert_eq!(r.error, None);
    // The market info is filled from a (free) resolve when the probability body has none.
    assert_eq!(r.market.as_ref().unwrap()["id"], 7);
    let st = m.state();
    assert_eq!(st.probability_calls, 1);
    assert_eq!(st.last_key.as_deref(), Some("k-123"));
    assert_eq!(
        st.last_probability_body,
        Some(json!({"message": "Will it rain in Boston?", "market_ids": [7]}))
    );
}

#[tokio::test]
async fn live_probability_without_market_sends_no_ids_and_no_key() {
    let m = MockCournot::start(vec![]).await;
    m.set_probability(200, json!({"code": 0, "data": {"probability": 0.5}}));
    let r = live(&m.base, None)
        .probability("q?", 0, None, None)
        .await
        .unwrap();
    assert_eq!(r.market, None);
    let st = m.state();
    assert_eq!(st.last_key, None);
    assert_eq!(st.last_probability_body.unwrap()["market_ids"], json!([]));
    assert_eq!(st.resolve_calls, 0);
}

#[tokio::test]
async fn live_errors_are_mapped() {
    let m = MockCournot::start(vec![]).await;
    let c = live(&m.base, None);
    m.set_probability(402, json!({"error": "payment required"}));
    assert_eq!(
        c.probability("q?", 1, None, None).await.unwrap_err(),
        CournotError::PaymentRequired
    );
    m.set_probability(200, json!({"code": 4100, "msg": "input error"}));
    let e = c.probability("q?", 1, None, None).await.unwrap_err();
    assert!(matches!(e, CournotError::BadQuestion(_)), "{e:?}");
    assert_eq!(e.code(), "bad_question");
    m.set_probability(400, json!({"code": 4100, "msg": "input error"}));
    assert!(matches!(
        c.probability("q?", 1, None, None).await.unwrap_err(),
        CournotError::BadQuestion(_)
    ));
    m.set_probability(500, json!({"msg": "boom"}));
    let e = c.probability("q?", 1, None, None).await.unwrap_err();
    assert_eq!(e.code(), "cournot_unavailable");
    m.set_probability(429, json!({}));
    assert_eq!(
        c.probability("q?", 1, None, None).await.unwrap_err().code(),
        "cournot_unavailable"
    );
    assert_eq!(CournotError::PaymentRequired.code(), "payment_required");
    // Nothing listening.
    let dead = live("http://127.0.0.1:1", None);
    assert_eq!(
        dead.resolve("q?", 5).await.unwrap_err().code(),
        "cournot_unavailable"
    );
}

#[tokio::test]
async fn mock_mode_uses_the_market_price_and_never_calls_probability() {
    let m = MockCournot::start(vec![
        market_json(5, "Other", 0.1, 0.8),
        market_json(7, "Rain in Boston?", 0.3, 0.8),
    ])
    .await;
    let c = mock_mode(&m.base);
    let r = c
        .probability("Will it rain in Boston?", 7, None, None)
        .await
        .unwrap();
    assert_eq!(r.probability, Some(0.3));
    assert_eq!(r.source, SOURCE_MOCK);
    assert_eq!(r.result, Some(json!({"point_estimate": 0.3, "mock": true})));
    assert_eq!(
        r.basis,
        Some(json!({
            "primary_anchor": {"source": "mock", "summary": "Rain in Boston? trades at 0.3", "market_id": 7},
            "limitations": ["Simulated oracle (COURNOT_MODE=mock): no Cournot probability call was made."]
        }))
    );
    assert_eq!(r.market.as_ref().unwrap()["title"], "Rain in Boston?");
    assert_eq!(r.raw, None);
    // Unknown market: 0.5.
    let r = c
        .probability("Will it rain in Boston?", 999, None, None)
        .await
        .unwrap();
    assert_eq!(r.probability, Some(0.5));
    assert_eq!(r.market, None);
    let st = m.state();
    assert_eq!(st.probability_calls, 0);
    assert_eq!(st.resolve_calls, 2);
}

// ------------------------------------------------------------------ ids are per-response handles

use predictlaunch_sequencer::cournot::{pick_market, MarketKey};

#[test]
fn pick_market_order() {
    let mk = |id: u64, title: &str, end: &str, conf: f64| predictlaunch_sequencer::cournot::Market {
        id,
        title: title.into(),
        description: String::new(),
        start_time: String::new(),
        end_time: end.into(),
        yes_price: Some(0.5),
        matching_confidence: Some(conf),
        info: json!({}),
    };
    let rs = vec![
        mk(1, "Top market", "2026-12-01", 0.95),
        mk(2, "Rain in  Boston?", "2026-11-27", 0.7),
        mk(3, "Rain in Boston?", "2026-11-28", 0.6),
    ];
    let claim = "rain in boston?";
    // Same id wins.
    assert_eq!(pick_market(&rs, 3, None, claim).unwrap().id, 3);
    // Else the remembered (title, end_time) ...
    let k = MarketKey {
        title: "Rain in Boston?".into(),
        end_time: "2026-11-28".into(),
    };
    assert_eq!(pick_market(&rs, 99, Some(&k), claim).unwrap().id, 3);
    // ... and a remembered market that is gone matches nothing (no stand-in).
    let gone = MarketKey {
        title: "Closed".into(),
        end_time: "x".into(),
    };
    assert!(pick_market(&rs, 99, Some(&gone), claim).is_none());
    // Nothing remembered: title == claim (case/whitespace-insensitive), first such result.
    assert_eq!(pick_market(&rs, 99, None, claim).unwrap().id, 2);
    // Else the top result only with confidence >= 0.9.
    assert_eq!(pick_market(&rs, 0, None, "something else").unwrap().id, 1);
    let low = vec![mk(1, "Top market", "x", 0.89)];
    assert!(pick_market(&low, 0, None, "something else").is_none());
    // The key reads market_info and the API's camelCase pick alike.
    assert_eq!(
        MarketKey::from_json(&json!({"title": "T", "end_time": "E"})),
        MarketKey::from_json(&json!({"title": "T", "endTime": "E"}))
    );
}

fn rain_key() -> MarketKey {
    MarketKey {
        title: "Rain in Boston?".into(),
        end_time: "2026-12-09T23:59:00Z".into(),
    }
}

#[tokio::test]
async fn live_probability_sends_the_fresh_id_of_the_remembered_market() {
    let m = MockCournot::start(vec![
        market_json(5, "Other", 0.1, 0.5),
        market_json(7, "Rain in Boston?", 0.3, 0.6),
    ])
    .await;
    m.set_rotate_ids(true);
    m.set_probability(200, json!({"code": 0, "data": {"probability": 0.33}}));
    let r = live(&m.base, None)
        .probability("Will it rain in Boston?", 7, Some(&rain_key()), None)
        .await
        .unwrap();
    // First resolve answer: ids + 1_000_000.
    assert_eq!(
        m.state().last_probability_body.unwrap()["market_ids"],
        json!([1_000_007])
    );
    assert_eq!(r.market_id, 7, "the given id is kept, informational");
    assert_eq!(r.market.as_ref().unwrap()["title"], "Rain in Boston?");
    assert_eq!(r.market.as_ref().unwrap()["id"], 1_000_007);
}

#[tokio::test]
async fn mock_probability_finds_the_picked_market_despite_new_ids() {
    let m = MockCournot::start(vec![market_json(7, "Rain in Boston?", 0.3, 0.6)]).await;
    m.set_rotate_ids(true);
    let c = mock_mode(&m.base);
    let r = c
        .probability("Will it rain?", 7, Some(&rain_key()), None)
        .await
        .unwrap();
    assert_eq!(r.probability, Some(0.3));
    // Nothing listed any more: 0.5, and the record still remembers the pick.
    m.set_markets(vec![]);
    let r = c
        .probability("Will it rain?", 7, Some(&rain_key()), None)
        .await
        .unwrap();
    assert_eq!(r.probability, Some(0.5));
    assert_eq!(
        r.market,
        Some(json!({"title": "Rain in Boston?", "end_time": "2026-12-09T23:59:00Z"}))
    );
}
