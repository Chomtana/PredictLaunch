//! API tests (tower `oneshot`, plus a real socket for the WebSocket) against `FakeChain`.

use std::sync::Arc;
use std::time::Duration;

use alloy_primitives::{Address, U256};
use axum::body::Body;
use axum::http::{Request, StatusCode};
use predictlaunch_core::eip712::{cancel_hash, TestKey};
use predictlaunch_core::{order_hash, Order, Outcome, Side, BNB_USD_FEED};
use predictlaunch_sequencer::api;
use predictlaunch_sequencer::app::{App, Settings};
use predictlaunch_sequencer::testutil::*;
use futures_util::{SinkExt, StreamExt};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

const FEED: Address = Address::repeat_byte(0xFE);

struct T {
    app: Arc<App<FakeChain>>,
    router: axum::Router,
    alice: TestKey,
    bob: TestKey,
}

impl T {
    async fn new(dev_faucet: bool) -> T {
        Self::with_quote(dev_faucet, Address::ZERO, None).await
    }

    async fn with_quote(dev_faucet: bool, quote: Address, quote_symbol: Option<&str>) -> T {
        let chain = FakeChain::new();
        chain.0.lock().unwrap().quote_token = quote;
        let (alice, bob) = (TestKey::from_seed("alice"), TestKey::from_seed("bob"));
        chain.push(launch_event(0, now_secs() + 3600, FEED));
        chain.push(deposit(alice.address(), 10));
        chain.push(deposit(bob.address(), 10));
        let settings = Settings {
            domain: test_domain(),
            public_rpc: "http://127.0.0.1:8545".into(),
            factory: Address::repeat_byte(0xFA),
            portal: predictlaunch_core::PORTAL,
            batch_ms: 2000,
            poll_ms: 1000,
            dev_faucet,
            start_block: 0,
            price_api: None,
            quote_symbol: quote_symbol.map(Into::into),
            oracle: predictlaunch_sequencer::testutil::offline_oracle(),
        };
        let app = App::new(chain, settings).await.unwrap();
        let router = api::router(app.clone());
        T {
            app,
            router,
            alice,
            bob,
        }
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

fn order_json(o: &Order) -> Value {
    json!({
        "owner": o.owner,
        "launchId": o.launch_id.to_string(),
        "round": o.round.to_string(),
        "outcome": o.outcome.as_u8().to_string(),
        "side": o.side.as_u8().to_string(),
        "price": o.price.to_string(),
        "amount": o.amount.to_string(),
        "expiry": o.expiry.to_string(),
        "nonce": o.nonce.to_string(),
    })
}

fn place(k: &TestKey, outcome: Outcome, side: Side, price: u8, amount: u128) -> (Order, Value) {
    let (o, sig) = signed_order(&test_domain(), k, 0, outcome, side, price, amount);
    let m = json!({
        "kind": "place",
        "order": order_json(&o),
        "sig": format!("0x{}", alloy_primitives::hex::encode(&sig)),
    });
    (o, m)
}

#[tokio::test]
async fn status_shape() {
    let t = T::new(false).await;
    let v = t.get("/api/status").await;
    for k in [
        "lastBatchId",
        "lastBatchTs",
        "pendingFills",
        "inflight",
        "softReversals",
    ] {
        assert!(v.get(k).is_some(), "missing {k}: {v}");
    }
    assert_eq!(v["inflight"], json!(false));
    assert_eq!(v["pendingFills"], json!(0));
}

#[tokio::test]
async fn config_shape() {
    let t = T::new(false).await;
    let v = t.get("/api/config").await;
    for k in [
        "chainId",
        "rpc",
        "exchange",
        "factory",
        "portal",
        "saltLockFee",
        "minTarget",
        "cuts",
        "feeds",
        "minDuration",
        "maxDuration",
        "batchMs",
        "devFaucet",
    ] {
        assert!(v.get(k).is_some(), "missing {k}: {v}");
    }
    assert_eq!(v["chainId"], json!(97));
    assert_eq!(v["cuts"], json!([1000, 1500, 2000, 2500, 3000]));
    assert_eq!(v["minTarget"], json!("2150000000000000000"));
    assert_eq!(
        v["factory"].as_str().unwrap().parse::<Address>().unwrap(),
        Address::repeat_byte(0xFA)
    );
    let feeds = v["feeds"].as_array().unwrap();
    assert_eq!(feeds.len(), 20);
    assert!(feeds.iter().any(|f| f["symbol"] == "BTCB/USD"));
    assert!(feeds[0].get("intervals").is_none());
    assert_eq!(v["devFaucet"], json!(false));
    let ls = t.get("/api/launches").await;
    assert_eq!(ls[0]["id"], json!(0));
    assert_eq!(ls[0]["status"], json!(0));
    assert_eq!(ls[0]["upPrice"], Value::Null);
    let d = t.get("/api/launch/0").await;
    assert_eq!(d["symbol"], "C0");
    assert!(d.get("lastTrades").is_some());
    assert_eq!(
        t.req("GET", "/api/launch/9", None).await.0,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn place_and_book() {
    let t = T::new(false).await;
    let (_, m1) = place(&t.alice, Outcome::Up, Side::Buy, 40, E18);
    let (s, v) = t.req("POST", "/api/msgs", Some(json!([m1]))).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["results"][0]["resting"], json!(E18.to_string()));
    assert!(v["results"][0]["orderHash"].is_string());
    // Buy Down @30 = ask 70 in Up terms.
    let (_, m2) = place(&t.bob, Outcome::Down, Side::Buy, 30, 2 * E18);
    t.req("POST", "/api/msgs", Some(json!([m2]))).await;
    let b = t.get("/api/book/0").await;
    assert_eq!(b["bids"], json!([{"price": 40, "amount": E18.to_string()}]));
    assert_eq!(
        b["asks"],
        json!([{"price": 70, "amount": (2 * E18).to_string()}])
    );
    let ls = t.get("/api/launches").await;
    assert_eq!(ls[0]["upPrice"], json!(55.0));

    // Alice buys 1 Up at up to 75: mints against Bob at 70.
    let (_, m3) = place(&t.alice, Outcome::Up, Side::Buy, 75, E18);
    let (_, v) = t.req("POST", "/api/msgs", Some(json!([m3]))).await;
    assert_eq!(
        v["results"][0]["fills"],
        json!([{"price": 70, "amount": E18.to_string(), "kind": "mint"}])
    );
    let tr = t.get("/api/trades/0?limit=5").await;
    assert_eq!(tr[0]["price"], json!(70));
    assert_eq!(tr[0]["side"], json!("buy"));
    let st = t.get("/api/status").await;
    assert_eq!(st["pendingFills"], json!(1));
}

#[tokio::test]
async fn group_error_reports_index() {
    let t = T::new(false).await;
    let (_, ok) = place(&t.alice, Outcome::Up, Side::Buy, 40, E18);
    let (_, dust) = place(&t.alice, Outcome::Up, Side::Buy, 40, E18 + 1);
    let (s, v) = t
        .req("POST", "/api/msgs", Some(json!([ok.clone(), dust])))
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert_eq!(v["error"], "bad_amount");
    assert_eq!(v["index"], json!(1));
    // Nothing from the group was applied.
    assert_eq!(t.get("/api/book/0").await["bids"], json!([]));

    let (_, broke) = place(&t.alice, Outcome::Up, Side::Buy, 99, 100 * E18);
    let (_, v) = t
        .req("POST", "/api/msgs", Some(json!([ok.clone(), broke])))
        .await;
    assert_eq!(v["error"], "insufficient_balance");
    assert_eq!(v["index"], json!(1));

    let (_, sell) = place(&t.alice, Outcome::Down, Side::Sell, 50, E18);
    let (_, v) = t.req("POST", "/api/msgs", Some(json!([sell]))).await;
    assert_eq!(v["error"], "insufficient_shares");

    let mut bad = ok.clone();
    bad["sig"] = json!(format!("0x{}", "11".repeat(65)));
    let (_, v) = t.req("POST", "/api/msgs", Some(json!([bad]))).await;
    assert_eq!(v["error"], "bad_signature");

    let many: Vec<Value> = (0..17).map(|_| ok.clone()).collect();
    let (_, v) = t.req("POST", "/api/msgs", Some(Value::Array(many))).await;
    assert_eq!(v["error"], "group_too_large");

    let (s, v) = t
        .req("POST", "/api/msgs", Some(json!([ok, {"kind": "nope"}])))
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert_eq!(v["index"], json!(1));
}

#[tokio::test]
async fn user_view_after_fill() {
    let t = T::new(false).await;
    let (_, m1) = place(&t.bob, Outcome::Down, Side::Buy, 40, 2 * E18);
    t.req("POST", "/api/msgs", Some(json!([m1]))).await;
    // Market buy: place + cancel-if-resting.
    let (o, m2) = place(&t.alice, Outcome::Up, Side::Buy, 65, 3 * E18);
    let h = order_hash(&test_domain(), &o);
    let csig = t.alice.sign(&cancel_hash(&test_domain(), o.owner, h, 1));
    let cancel = json!({
        "kind": "cancel", "owner": o.owner, "orderHash": h, "nonce": "1",
        "sig": format!("0x{}", alloy_primitives::hex::encode(&csig)), "ifResting": true,
    });
    let (s, v) = t.req("POST", "/api/msgs", Some(json!([m2, cancel]))).await;
    assert_eq!(s, StatusCode::OK, "{v}");

    let u = t.get(&format!("/api/user/{}", t.alice.address())).await;
    // 2 Up minted at 60 each: 10 − 1.2 = 8.8 BNB.
    assert_eq!(u["balance"], json!((88 * E18 / 10).to_string()));
    assert_eq!(u["locked"], json!("0"));
    assert_eq!(
        u["positions"],
        json!([{"launchId": 0, "up": (2 * E18).to_string(), "down": "0"}])
    );
    assert_eq!(u["orders"][0]["status"], json!("cancelled"));
    assert_eq!(u["orders"][0]["launchId"], json!(0));
    assert_eq!(u["orders"][0]["outcome"], json!(0));

    let b = t.get(&format!("/api/user/{}", t.bob.address())).await;
    assert_eq!(b["orders"][0]["status"], json!("filled"));
    assert_eq!(b["positions"][0]["down"], json!((2 * E18).to_string()));

    // Batch lands; the confirmed mirror matches.
    tokio::time::sleep(Duration::from_millis(10)).await;
    t.app.state.lock().unwrap().cfg.batch_ms = 0;
    assert!(t.app.run_batch().await.unwrap().is_some());
    let u = t.get(&format!("/api/user/{}", t.alice.address())).await;
    assert_eq!(u["confirmedBalance"], u["balance"]);
    assert_eq!(t.get("/api/status").await["lastBatchId"], json!(1));
}

#[tokio::test]
async fn ws_pushes_on_change() {
    let t = T::new(false).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let router = t.router.clone();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws"))
        .await
        .unwrap();
    ws.send(tokio_tungstenite::tungstenite::Message::text(
        json!({"sub": {"launchId": 0, "user": t.alice.address()}}).to_string(),
    ))
    .await
    .unwrap();
    // Wait for a snapshot that reflects the subscription.
    let mut snap = next_json(&mut ws).await;
    while snap["book"].is_null() {
        snap = next_json(&mut ws).await;
    }
    assert_eq!(snap["type"], "snapshot");
    assert_eq!(snap["book"]["bids"], json!([]));
    // A placed order is pushed.
    let (_, m) = place(&t.alice, Outcome::Up, Side::Buy, 40, E18);
    t.req("POST", "/api/msgs", Some(json!([m]))).await;
    let mut snap = next_json(&mut ws).await;
    while snap["type"] != "snapshot" || snap["book"]["bids"] == json!([]) {
        snap = next_json(&mut ws).await;
    }
    assert_eq!(snap["book"]["bids"][0]["price"], json!(40));
    assert_eq!(snap["user"]["locked"], json!((4 * E18 / 10).to_string()));
    // Price ticks are pushed too.
    t.app
        .record_price(BNB_USD_FEED, 1_900_000_000, U256::from(600u64));
    let mut m = next_json(&mut ws).await;
    while m["type"] != "price" {
        m = next_json(&mut ws).await;
    }
    assert_eq!(m["price"], json!("600"));
    let p = t.get(&format!("/api/prices/{BNB_USD_FEED}?since=1")).await;
    assert_eq!(
        p,
        json!([{"t": 1_900_000_000u64, "price": "600", "source": "onchain"}])
    );
}

async fn next_json<S, E>(ws: &mut S) -> Value
where
    S: futures_util::Stream<Item = Result<tokio_tungstenite::tungstenite::Message, E>> + Unpin,
    E: std::fmt::Debug,
{
    let m = tokio::time::timeout(Duration::from_secs(5), ws.next())
        .await
        .expect("ws timeout")
        .unwrap()
        .unwrap();
    serde_json::from_str(m.to_text().unwrap()).unwrap()
}

#[tokio::test]
async fn faucet_disabled_by_default() {
    let t = T::new(false).await;
    let (s, v) = t
        .req(
            "POST",
            "/api/faucet",
            Some(json!({"address": t.alice.address()})),
        )
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    assert_eq!(v["error"], "faucet_disabled");
    assert!(t.app.chain.calls().is_empty());

    let t = T::new(true).await;
    let (s, v) = t
        .req(
            "POST",
            "/api/faucet",
            Some(json!({"address": t.alice.address()})),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(t.app.chain.calls().len(), 1);
    assert_eq!(
        t.app.chain.0.lock().unwrap().balances[&t.alice.address()],
        U256::from(1000u128 * E18)
    );
}

#[tokio::test]
async fn erc20_quote_config_and_faucet_mint() {
    let t = T::new(true).await;
    let (_, v) = t.req("GET", "/api/config", None).await;
    assert_eq!(v["quoteToken"], json!(Address::ZERO));
    assert_eq!(v["quoteSymbol"], "BNB");
    t.req("POST", "/api/faucet", Some(json!({"address": t.alice.address()})))
        .await;
    assert!(t.app.chain.0.lock().unwrap().quote_mints.is_empty(), "native: no mint");

    let usd = Address::repeat_byte(0x55);
    let t = T::with_quote(true, usd, Some("USDT")).await;
    let (_, v) = t.req("GET", "/api/config", None).await;
    assert_eq!(v["quoteToken"], json!(usd));
    assert_eq!(v["quoteSymbol"], "USDT", "display override wins over the on-chain USD");
    let (s, v) = t
        .req("POST", "/api/faucet", Some(json!({"address": t.alice.address()})))
        .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["quote"], (10_000u128 * E18).to_string());
    let i = t.app.chain.0.lock().unwrap();
    assert_eq!(i.quote_mints[&t.alice.address()], U256::from(10_000u128 * E18));
    assert_eq!(i.balances[&t.alice.address()], U256::from(1000u128 * E18), "gas too");
}
