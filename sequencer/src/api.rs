//! HTTP + WebSocket API (SPEC "Sequencer HTTP/WS API").
//!
//! ```text
//! GET  /api/status   /api/config   /api/launches   /api/launch/{id}   /api/book/{id}
//! GET  /api/trades/{id}?limit=   /api/prices/{feed}?since=   /api/user/{addr}
//! POST /api/msgs     [Msg] atomic group (≤ 16)
//! POST /api/faucet   {address}  (only with --dev-faucet)
//! POST /api/poke     re-read the chain now (after a deposit / withdraw tx)
//! POST /api/cournot/resolve      {message}            → {markets:[...]}   (rate-limited per IP)
//! POST /api/cournot/probability  {message, marketId}  → OracleRecord      (rate-limited per IP)
//! GET  /api/launch/{id}/oracle   {opening, prices, settlement, proposal}
//! WS   /ws           send {sub:{launchId?, user?}}; receive snapshots and price ticks
//! ```

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use alloy_primitives::{Address, U256};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use predictlaunch_core::state::AcceptError;
use predictlaunch_core::{
    ErrorCode, CUTS, FEEDS, MAX_DURATION, MIN_DURATION, ONE_BNB, QUESTION_DEADLINE,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tower_http::cors::CorsLayer;

use crate::app::{now_ms, App};
use crate::chain::Chain;
use crate::cournot::{check_question, CournotError, MarketKey};
use crate::views;

pub const FAUCET_BNB: u128 = 1000;
/// Markets returned by `POST /api/cournot/resolve`.
pub const RESOLVE_LIMIT: u32 = 5;
/// Quote tokens the dev faucet mints when the Exchange's quote is an ERC20 (launch targets start at 1500).
pub const FAUCET_QUOTE: u128 = 10_000;

pub fn router<C: Chain>(app: Arc<App<C>>) -> Router {
    Router::new()
        .route("/api/status", get(status::<C>))
        .route("/api/config", get(config::<C>))
        .route("/api/launches", get(launches::<C>))
        .route("/api/launch/{id}", get(launch::<C>))
        .route("/api/book/{id}", get(book::<C>))
        .route("/api/trades/{id}", get(trades::<C>))
        .route("/api/prices/{feed}", get(prices::<C>))
        .route("/api/user/{addr}", get(user::<C>))
        .route("/api/msgs", post(msgs::<C>))
        .route("/api/faucet", post(faucet::<C>))
        .route("/api/poke", post(poke::<C>))
        .route("/api/cournot/resolve", post(cournot_resolve::<C>))
        .route("/api/cournot/probability", post(cournot_probability::<C>))
        .route("/api/launch/{id}/oracle", get(launch_oracle::<C>))
        .route("/ws", get(ws::<C>))
        .layer(CorsLayer::permissive())
        .with_state(app)
}

type AppState<C> = State<Arc<App<C>>>;

fn err(
    code: StatusCode,
    error: &str,
    message: impl Into<String>,
    index: Option<usize>,
) -> Response {
    let mut body = json!({ "error": error, "message": message.into() });
    if let Some(i) = index {
        body["index"] = json!(i);
    }
    (code, Json(body)).into_response()
}

fn now() -> u64 {
    now_ms() / 1000
}

pub fn config_json<C: Chain>(app: &App<C>) -> Value {
    let s = &app.settings;
    json!({
        "chainId": app.info.chain_id,
        "rpc": s.public_rpc,
        "exchange": s.domain.exchange,
        "factory": s.factory,
        "portal": s.portal,
        "saltLockFee": app.info.salt_lock_fee.to_string(),
        "minTarget": app.info.min_target.to_string(),
        "quoteToken": app.info.quote_token,
        "quoteSymbol": s.quote_symbol.as_deref().unwrap_or(&app.info.quote_symbol),
        "cuts": CUTS,
        "feeds": FEEDS.iter().map(|(sym, a)| json!({"address": a, "symbol": sym})).collect::<Vec<_>>(),
        "minDuration": MIN_DURATION,
        "maxDuration": MAX_DURATION,
        "batchMs": s.batch_ms,
        "devFaucet": s.dev_faucet,
        "cournotMode": app.oracle.mode().as_str(),
        "challengeWindow": app.state.lock().unwrap().challenge_window,
        "questionDeadline": QUESTION_DEADLINE,
        "domain": {
            "name": "predictlaunch",
            "version": "1",
            "chainId": s.domain.chain_id,
            "verifyingContract": s.domain.exchange,
        },
    })
}

async fn config<C: Chain>(State(app): AppState<C>) -> Json<Value> {
    Json(config_json(&app))
}

fn status_json<C: Chain>(app: &App<C>) -> Value {
    let e = app.last_error.lock().unwrap().clone();
    views::status(&app.state.lock().unwrap(), e.as_deref())
}

async fn status<C: Chain>(State(app): AppState<C>) -> Json<Value> {
    Json(status_json(&app))
}

async fn launches<C: Chain>(State(app): AppState<C>) -> Json<Value> {
    let st = app.state.lock().unwrap();
    let o = app.oracle.briefs.lock().unwrap();
    Json(views::launches(&st, now(), &o))
}

fn launch_json<C: Chain>(app: &App<C>, id: u64) -> Option<Value> {
    let st = app.state.lock().unwrap();
    let p = app.prices.lock().unwrap();
    let o = app.oracle.briefs.lock().unwrap();
    views::launch_detail(&st, &p, id, now(), &o)
}

async fn launch<C: Chain>(State(app): AppState<C>, Path(id): Path<u64>) -> Response {
    match launch_json(&app, id) {
        Some(v) => Json(v).into_response(),
        None => err(StatusCode::NOT_FOUND, "not_found", "unknown launch", None),
    }
}

async fn book<C: Chain>(State(app): AppState<C>, Path(id): Path<u64>) -> Json<Value> {
    Json(views::book(&app.state.lock().unwrap(), id))
}

#[derive(Deserialize)]
struct Q {
    limit: Option<usize>,
    since: Option<u64>,
}

async fn trades<C: Chain>(
    State(app): AppState<C>,
    Path(id): Path<u64>,
    Query(q): Query<Q>,
) -> Json<Value> {
    Json(views::trades(
        &app.state.lock().unwrap(),
        id,
        q.limit.unwrap_or(100).min(1000),
    ))
}

async fn prices<C: Chain>(
    State(app): AppState<C>,
    Path(feed): Path<String>,
    Query(q): Query<Q>,
) -> Response {
    let Ok(feed) = feed.parse::<Address>() else {
        return err(
            StatusCode::BAD_REQUEST,
            "bad_request",
            "not an address",
            None,
        );
    };
    Json(views::prices(
        &app.prices.lock().unwrap(),
        feed,
        q.since.unwrap_or(0),
    ))
    .into_response()
}

async fn user<C: Chain>(State(app): AppState<C>, Path(addr): Path<String>) -> Response {
    let Ok(a) = addr.parse::<Address>() else {
        return err(
            StatusCode::BAD_REQUEST,
            "bad_request",
            "not an address",
            None,
        );
    };
    Json(views::user(&app.state.lock().unwrap(), a)).into_response()
}

fn accept_err(e: AcceptError) -> Response {
    err(
        StatusCode::BAD_REQUEST,
        e.code.as_str(),
        e.message,
        Some(e.index),
    )
}

async fn msgs<C: Chain>(State(app): AppState<C>, Json(body): Json<Value>) -> Response {
    let arr = match &body {
        Value::Array(a) => a.clone(),
        Value::Object(o) => match o.get("msgs") {
            Some(Value::Array(a)) => a.clone(),
            _ => vec![body.clone()],
        },
        _ => {
            return err(
                StatusCode::BAD_REQUEST,
                "bad_request",
                "expected [Msg]",
                None,
            )
        }
    };
    if arr.len() > predictlaunch_core::MAX_GROUP {
        return err(
            StatusCode::BAD_REQUEST,
            ErrorCode::GroupTooLarge.as_str(),
            format!("at most {} messages per group", predictlaunch_core::MAX_GROUP),
            Some(predictlaunch_core::MAX_GROUP),
        );
    }
    let mut parsed = Vec::with_capacity(arr.len());
    for (i, m) in arr.iter().enumerate() {
        match views::parse_msg(m) {
            Ok(m) => parsed.push(m),
            Err(e) => return err(StatusCode::BAD_REQUEST, "bad_request", e, Some(i)),
        }
    }
    match app.submit_group(parsed) {
        Ok(results) => {
            let results: Vec<Value> = results
                .into_iter()
                .map(|r| {
                    json!({
                        "orderHash": r.order_hash,
                        "fills": r.fills.iter().map(|f| json!({
                            "price": f.price,
                            "amount": f.amount.to_string(),
                            "kind": f.kind.name(),
                        })).collect::<Vec<_>>(),
                        "resting": r.resting.to_string(),
                        "omitted": r.omitted,
                    })
                })
                .collect();
            Json(json!({ "results": results })).into_response()
        }
        Err(e) => accept_err(e),
    }
}

async fn faucet<C: Chain>(State(app): AppState<C>, Json(body): Json<Value>) -> Response {
    if !app.settings.dev_faucet {
        return err(
            StatusCode::NOT_FOUND,
            "faucet_disabled",
            "start the sequencer with --dev-faucet",
            None,
        );
    }
    let Some(a) = body
        .get("address")
        .and_then(Value::as_str)
        .and_then(|s| s.parse::<Address>().ok())
    else {
        return err(
            StatusCode::BAD_REQUEST,
            "bad_request",
            "address required",
            None,
        );
    };
    // Native gas (`anvil_setBalance`, fork only) and, with an ERC20 quote, a mint of the quote token. With an
    // ERC20 quote the gas top-up is best effort, so the faucet still mints on a live node.
    let amount = U256::from(FAUCET_BNB * ONE_BNB);
    let quote = app.info.quote_token;
    let quote_amount = U256::from(FAUCET_QUOTE * ONE_BNB);
    let res = async {
        if quote.is_zero() {
            app.chain.set_balance(a, amount).await?;
        } else {
            if let Err(e) = app.chain.set_balance(a, amount).await {
                tracing::debug!("faucet: no gas top-up ({e:#})");
            }
            app.chain.mint_quote(quote, a, quote_amount).await?;
        }
        anyhow::Ok(())
    }
    .await;
    match res {
        Ok(()) => {
            let mut v = json!({ "ok": true, "address": a, "balance": amount.to_string() });
            if !quote.is_zero() {
                v["quote"] = json!(quote_amount.to_string());
            }
            Json(v).into_response()
        }
        Err(e) => err(
            StatusCode::BAD_GATEWAY,
            "faucet_failed",
            format!("{e:#}"),
            None,
        ),
    }
}

async fn poke<C: Chain>(State(app): AppState<C>) -> Response {
    match app.poll().await {
        Ok(_) => Json(status_json(&app)).into_response(),
        Err(e) => err(
            StatusCode::BAD_GATEWAY,
            "poll_failed",
            format!("{e:#}"),
            None,
        ),
    }
}

// ------------------------------------------------------------------------------- cournot

fn cournot_err(e: &CournotError) -> Response {
    let code = match e {
        CournotError::PaymentRequired => StatusCode::PAYMENT_REQUIRED,
        CournotError::BadQuestion(_) => StatusCode::BAD_REQUEST,
        CournotError::Unavailable(_) => StatusCode::BAD_GATEWAY,
    };
    err(code, e.code(), e.to_string(), None)
}

/// The client key of the per-IP rate limit (peer address; "local" without connect info).
fn client_of(ci: &Option<Extension<ConnectInfo<SocketAddr>>>) -> String {
    ci.as_ref()
        .map_or_else(|| "local".into(), |Extension(ConnectInfo(a))| a.ip().to_string())
}

fn rate_limited<C: Chain>(
    app: &App<C>,
    endpoint: &'static str,
    ci: &Option<Extension<ConnectInfo<SocketAddr>>>,
) -> Option<Response> {
    (!app.oracle.allow(endpoint, &client_of(ci), now_ms())).then(|| {
        err(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            format!(
                "at most one {endpoint} request every {} ms",
                app.oracle.rate_limit_ms
            ),
            None,
        )
    })
}

/// `message` from the body, checked against the question rule.
fn question_of(body: &Value) -> Result<String, CournotError> {
    let q = body
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    check_question(&q)?;
    Ok(q)
}

async fn cournot_resolve<C: Chain>(
    State(app): AppState<C>,
    ci: Option<Extension<ConnectInfo<SocketAddr>>>,
    Json(body): Json<Value>,
) -> Response {
    if let Some(r) = rate_limited(&app, "resolve", &ci) {
        return r;
    }
    let q = match question_of(&body) {
        Ok(q) => q,
        Err(e) => return cournot_err(&e),
    };
    match app.oracle.cournot.resolve(&q, RESOLVE_LIMIT).await {
        Ok(ms) => Json(json!({
            "markets": ms.iter().map(|m| m.to_api_json()).collect::<Vec<_>>(),
        }))
        .into_response(),
        Err(e) => cournot_err(&e),
    }
}

async fn cournot_probability<C: Chain>(
    State(app): AppState<C>,
    ci: Option<Extension<ConnectInfo<SocketAddr>>>,
    Json(body): Json<Value>,
) -> Response {
    if let Some(r) = rate_limited(&app, "probability", &ci) {
        return r;
    }
    let q = match question_of(&body) {
        Ok(q) => q,
        Err(e) => return cournot_err(&e),
    };
    let market_id: u64 = match body.get("marketId") {
        None | Some(Value::Null) => 0,
        Some(_) => match views::num_field(&body, "marketId") {
            Ok(v) => v,
            Err(e) => return err(StatusCode::BAD_REQUEST, "bad_request", e, None),
        },
    };
    // Optional `market: {title, endTime}`: the creator's pick from /api/cournot/resolve.
    let picked = body.get("market").and_then(MarketKey::from_json);
    match app.oracle_preview(&q, market_id, picked.as_ref()).await {
        Ok(r) => Json(r).into_response(),
        Err(e) => cournot_err(&e),
    }
}

async fn launch_oracle<C: Chain>(State(app): AppState<C>, Path(id): Path<u64>) -> Response {
    match app.oracle_view(id) {
        Some(v) => Json(v).into_response(),
        None => err(StatusCode::NOT_FOUND, "not_found", "unknown launch", None),
    }
}

// ------------------------------------------------------------------------------- websocket

#[derive(Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Sub {
    #[serde(default, deserialize_with = "de_opt_u64")]
    pub launch_id: Option<u64>,
    pub user: Option<Address>,
}

fn de_opt_u64<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<u64>, D::Error> {
    let v = Option::<Value>::deserialize(d)?;
    Ok(match v {
        Some(Value::Number(n)) => n.as_u64(),
        Some(Value::String(s)) => s.parse().ok(),
        _ => None,
    })
}

fn parse_sub(text: &str) -> Option<Sub> {
    let v: Value = serde_json::from_str(text).ok()?;
    let inner = v.get("sub").cloned().unwrap_or(v);
    serde_json::from_value(inner).ok()
}

async fn ws<C: Chain>(State(app): AppState<C>, up: WebSocketUpgrade) -> Response {
    up.on_upgrade(move |sock| ws_loop(app, sock))
}

pub fn snapshot_json<C: Chain>(app: &App<C>, sub: &Sub, version: u64) -> String {
    let st = app.state.lock().unwrap();
    let p = app.prices.lock().unwrap();
    let o = app.oracle.briefs.lock().unwrap();
    let now = now();
    let mut v = json!({
        "type": "snapshot",
        "version": version,
        "status": views::status(&st, None),
        "launches": views::launches(&st, now, &o),
    });
    if let Some(id) = sub.launch_id {
        v["launch"] = views::launch_detail(&st, &p, id, now, &o).unwrap_or(Value::Null);
        v["book"] = views::book(&st, id);
        v["trades"] = views::trades(&st, id, 50);
    }
    if let Some(u) = sub.user {
        v["user"] = views::user(&st, u);
    }
    v.to_string()
}

async fn ws_loop<C: Chain>(app: Arc<App<C>>, mut sock: WebSocket) {
    let mut rx = app.version.subscribe();
    let mut prices = app.price_tx.subscribe();
    let mut sub = Sub::default();
    let mut dirty = true;
    loop {
        if dirty {
            // Coalesce bursts of updates into one push.
            tokio::time::sleep(Duration::from_millis(15)).await;
            let v = *rx.borrow_and_update();
            let text = snapshot_json(&app, &sub, v);
            if sock.send(Message::Text(text.into())).await.is_err() {
                return;
            }
            dirty = false;
        }
        tokio::select! {
            changed = rx.changed() => {
                if changed.is_err() { return; }
                dirty = true;
            }
            tick = prices.recv() => match tick {
                Ok(t) => {
                    let m = json!({"type": "price", "feed": t.feed, "t": t.t, "price": t.price.to_string(), "source": t.source});
                    if sock.send(Message::Text(m.to_string().into())).await.is_err() {
                        return;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(_) => return,
            },
            msg = sock.recv() => match msg {
                Some(Ok(Message::Text(t))) => {
                    if let Some(s) = parse_sub(&t) {
                        sub = s;
                        dirty = true;
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                _ => {}
            }
        }
    }
}
