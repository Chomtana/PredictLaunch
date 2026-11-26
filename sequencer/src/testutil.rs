//! An in-memory `Chain` for tests: an event log the test appends to, recorded keeper calls, and
//! a switch to make batch simulation fail. `submit_batch` appends `BatchSubmitted` (with the
//! batch) like the real contract would.

use std::collections::HashMap;
use std::sync::Mutex;

use alloy_primitives::{Address, B256, U256};
use predictlaunch_core::abi;
use predictlaunch_core::eip712::TestKey;
use predictlaunch_core::state::ChainEvent;
use predictlaunch_core::{order_hash, Domain, Order, Outcome, Side};

use crate::chain::{Chain, ChainInfo};

#[derive(Default)]
pub struct Inner {
    /// (block, event)
    pub log: Vec<(u64, ChainEvent)>,
    pub block: u64,
    pub fail_simulate: bool,
    pub fail_submit: bool,
    pub batches: Vec<abi::Batch>,
    /// Keeper / faucet calls, e.g. "snapshot 0", "redeem 0 2".
    pub calls: Vec<String>,
    pub feeds: HashMap<Address, (U256, u64)>,
    pub balances: HashMap<Address, U256>,
    /// `info().quote_token` (default native).
    pub quote_token: Address,
    /// Quote-token mints by the dev faucet.
    pub quote_mints: HashMap<Address, U256>,
    /// `info().challenge_window` (0 = DEFAULT_CHALLENGE_WINDOW).
    pub challenge_window: u64,
    /// `info().resolver`; `None` = the operator (`FAKE_OPERATOR`).
    pub resolver: Option<Address>,
    /// Make `propose_outcome` fail.
    pub fail_propose: bool,
}

/// `info().operator` of the fake chain.
pub const FAKE_OPERATOR: Address = Address::repeat_byte(0x0F);

#[derive(Default)]
pub struct FakeChain(pub Mutex<Inner>);

impl FakeChain {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn push(&self, e: ChainEvent) {
        let mut i = self.0.lock().unwrap();
        i.block += 1;
        let b = i.block;
        i.log.push((b, e));
    }
    pub fn set_fail_simulate(&self, v: bool) {
        self.0.lock().unwrap().fail_simulate = v;
    }
    pub fn calls(&self) -> Vec<String> {
        self.0.lock().unwrap().calls.clone()
    }
    pub fn batches(&self) -> Vec<abi::Batch> {
        self.0.lock().unwrap().batches.clone()
    }
    pub fn set_feed(&self, feed: Address, price: U256, updated_at: u64) {
        self.0.lock().unwrap().feeds.insert(feed, (price, updated_at));
    }
    fn call(&self, s: String) -> B256 {
        let mut i = self.0.lock().unwrap();
        i.calls.push(s);
        B256::with_last_byte(i.calls.len() as u8)
    }
}

impl Chain for FakeChain {
    async fn poll_events(&self, from: u64) -> anyhow::Result<(Vec<ChainEvent>, u64)> {
        let i = self.0.lock().unwrap();
        let ev = i
            .log
            .iter()
            .filter(|(b, _)| *b >= from)
            .map(|(_, e)| e.clone())
            .collect();
        Ok((ev, i.block + 1))
    }

    async fn simulate_batch(&self, _b: &abi::Batch) -> anyhow::Result<()> {
        anyhow::ensure!(
            !self.0.lock().unwrap().fail_simulate,
            "execution reverted (fake)"
        );
        Ok(())
    }

    async fn submit_batch(&self, b: &abi::Batch) -> anyhow::Result<B256> {
        let id = {
            let mut i = self.0.lock().unwrap();
            anyhow::ensure!(!i.fail_submit, "submit failed (fake)");
            i.batches.push(b.clone());
            i.batches.len() as u64
        };
        self.push(ChainEvent::BatchSubmitted {
            batch_id: id,
            ts: b.ts,
            fills: b.fills.len() as u64,
            batch: Some(b.clone()),
        });
        Ok(B256::with_last_byte(id as u8))
    }

    async fn snapshot(&self, launch: u64) -> anyhow::Result<B256> {
        Ok(self.call(format!("snapshot {launch}")))
    }
    async fn resolve(&self, launch: u64) -> anyhow::Result<B256> {
        Ok(self.call(format!("resolve {launch}")))
    }
    async fn redeem(&self, launch: u64, users: Vec<Address>) -> anyhow::Result<B256> {
        Ok(self.call(format!("redeem {launch} {}", users.len())))
    }
    async fn graduate(&self, launch: u64) -> anyhow::Result<B256> {
        Ok(self.call(format!("graduate {launch}")))
    }
    async fn propose_outcome(
        &self,
        launch: u64,
        outcome: u8,
        evidence_hash: B256,
    ) -> anyhow::Result<B256> {
        anyhow::ensure!(!self.0.lock().unwrap().fail_propose, "propose failed (fake)");
        Ok(self.call(format!("propose {launch} {outcome} {evidence_hash}")))
    }
    async fn read_feed(&self, feed: Address) -> anyhow::Result<(U256, u64)> {
        self.0
            .lock()
            .unwrap()
            .feeds
            .get(&feed)
            .copied()
            .ok_or_else(|| anyhow::anyhow!("unknown feed"))
    }
    async fn set_balance(&self, who: Address, amount: U256) -> anyhow::Result<()> {
        self.0.lock().unwrap().balances.insert(who, amount);
        self.call(format!("setBalance {who}"));
        Ok(())
    }
    async fn mint_quote(&self, _quote: Address, who: Address, amount: U256) -> anyhow::Result<()> {
        *self.0.lock().unwrap().quote_mints.entry(who).or_default() += amount;
        self.call(format!("mintQuote {who}"));
        Ok(())
    }
    async fn info(&self) -> anyhow::Result<ChainInfo> {
        let (quote_token, cw, resolver) = {
            let i = self.0.lock().unwrap();
            (i.quote_token, i.challenge_window, i.resolver)
        };
        Ok(ChainInfo {
            challenge_window: if cw == 0 {
                predictlaunch_core::DEFAULT_CHALLENGE_WINDOW
            } else {
                cw
            },
            resolver: resolver.unwrap_or(FAKE_OPERATOR),
            operator: FAKE_OPERATOR,
            chain_id: 97,
            salt_lock_fee: U256::from(5_000_000_000_000_000u64),
            min_target: U256::from(2_150_000_000_000_000_000u64),
            quote_token,
            quote_symbol: if quote_token.is_zero() { "BNB" } else { "USD" }.into(),
        })
    }
}

// ------------------------------------------------------------------------------- fixtures

pub const E18: u128 = 1_000_000_000_000_000_000;

pub fn test_domain() -> Domain {
    Domain {
        chain_id: 97,
        exchange: Address::repeat_byte(0xE8),
    }
}

pub fn launch_event(id: u64, settle_time: u64, feed: Address) -> ChainEvent {
    ChainEvent::LaunchCreated {
        launch_id: id,
        creator: Address::repeat_byte(0xC0),
        rail: Address::repeat_byte(0xAA),
        token: Address::repeat_byte(0x77),
        feed,
        strike: U256::from(100u64) * U256::from(E18),
        settle_time,
        cut_bps: 1000,
        target: U256::from(3 * E18),
        name: format!("Coin{id}"),
        symbol: format!("C{id}"),
        image_uri: "https://example.invalid/c.png".into(),
        created_at: settle_time.saturating_sub(3600),
    }
}

/// A question launch: `LaunchCreated` (feed 0, strike 0) then `QuestionSet`.
pub fn question_launch_events(
    id: u64,
    settle_time: u64,
    question: &str,
    market_id: u64,
) -> Vec<ChainEvent> {
    let mut e = launch_event(id, settle_time, Address::ZERO);
    if let ChainEvent::LaunchCreated { strike, .. } = &mut e {
        *strike = U256::ZERO;
    }
    vec![
        e,
        ChainEvent::QuestionSet {
            launch_id: id,
            question: question.into(),
            market_id,
        },
    ]
}

pub fn deposit(user: Address, bnb: u128) -> ChainEvent {
    ChainEvent::Deposited {
        user,
        amount: U256::from(bnb * E18),
    }
}

/// A signed order with a unique nonce.
#[allow(clippy::too_many_arguments)]
pub fn signed_order(
    d: &Domain,
    k: &TestKey,
    launch: u64,
    outcome: Outcome,
    side: Side,
    price: u8,
    amount: u128,
) -> (Order, Vec<u8>) {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NONCE: AtomicU64 = AtomicU64::new(1);
    let o = Order {
        owner: k.address(),
        launch_id: U256::from(launch),
        round: 0,
        outcome,
        side,
        price,
        amount,
        expiry: u64::MAX / 2,
        // Unique across processes too (a replayed chain remembers `filled` per hash).
        nonce: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_micros() as u64
            * 1000
            + NONCE.fetch_add(1, Ordering::Relaxed) % 1000,
    };
    let sig = k.sign(&order_hash(d, &o));
    (o, sig)
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

/// Oracle settings that never reach the network: a closed local port, a fresh temp dir, no rate limit.
pub fn offline_oracle() -> crate::oracle::OracleSettings {
    crate::oracle::OracleSettings {
        cournot: crate::cournot::CournotConfig {
            mode: crate::cournot::Mode::Live,
            api_base: "http://127.0.0.1:1".into(),
            api_key: None,
        },
        dir: temp_dir("oracle"),
        rate_limit_ms: 0,
    }
}

/// A fresh, empty directory under the system temp dir (for oracle stores in tests).
pub fn temp_dir(tag: &str) -> std::path::PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let d = std::env::temp_dir().join(format!(
        "predictlaunch-{tag}-{}-{}-{}",
        std::process::id(),
        now_secs(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

// ------------------------------------------------------------------------------- mock Cournot

/// Requests seen by `MockCournot`, and what it answers.
#[derive(Default, Clone)]
pub struct MockCournotState {
    /// `data.markets` entries returned by `resolve`.
    pub markets: Vec<serde_json::Value>,
    /// (HTTP status, body) returned by `probability` (default 200 with a 0.5 estimate).
    pub probability: Option<(u16, serde_json::Value)>,
    pub resolve_calls: usize,
    pub probability_calls: usize,
    pub last_resolve_body: Option<serde_json::Value>,
    pub last_probability_body: Option<serde_json::Value>,
    /// `COURNOT-API-KEY` of the last probability request.
    pub last_key: Option<String>,
    /// Like the real service: every `resolve` answer gives each market a new id
    /// (`id + 1_000_000 × call number`).
    pub rotate_ids: bool,
}

/// A local Cournot stand-in on `127.0.0.1:<random>` (tests never reach the real service).
pub struct MockCournot {
    pub base: String,
    pub inner: std::sync::Arc<Mutex<MockCournotState>>,
}

/// One `resolve` result as Cournot sends it.
pub fn market_json(id: u64, title: &str, yes_price: f64, confidence: f64) -> serde_json::Value {
    serde_json::json!({
        "market_info": {
            "id": id,
            "title": title,
            "description": format!("{title} (description)"),
            "start_time": "",
            "end_time": "2026-12-09T23:59:00Z",
            "market_outcome": "YES",
            "market_outcome_price": yes_price,
        },
        "matching_confidence": confidence,
    })
}

type MockState = axum::extract::State<std::sync::Arc<Mutex<MockCournotState>>>;

async fn mock_resolve(
    axum::extract::State(st): MockState,
    axum::Json(body): axum::Json<serde_json::Value>,
) -> axum::Json<serde_json::Value> {
    let mut s = st.lock().unwrap();
    s.resolve_calls += 1;
    s.last_resolve_body = Some(body);
    let mut markets = s.markets.clone();
    if s.rotate_ids {
        let bump = 1_000_000 * s.resolve_calls as u64;
        for m in &mut markets {
            if let Some(id) = m["market_info"]["id"].as_u64() {
                m["market_info"]["id"] = serde_json::json!(id + bump);
            }
        }
    }
    axum::Json(serde_json::json!({
        "code": 0, "msg": "Success", "data": {"markets": markets, "charged": false}
    }))
}

async fn mock_probability(
    axum::extract::State(st): MockState,
    headers: axum::http::HeaderMap,
    axum::Json(body): axum::Json<serde_json::Value>,
) -> (axum::http::StatusCode, axum::Json<serde_json::Value>) {
    let mut s = st.lock().unwrap();
    s.probability_calls += 1;
    s.last_probability_body = Some(body);
    s.last_key = headers
        .get(crate::cournot::KEY_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(Into::into);
    let (code, b) = s.probability.clone().unwrap_or((
        200,
        serde_json::json!({"code": 0, "msg": "Success", "data": {"result": {"point_estimate": 0.5}}}),
    ));
    (
        axum::http::StatusCode::from_u16(code).unwrap(),
        axum::Json(b),
    )
}

impl MockCournot {
    pub async fn start(markets: Vec<serde_json::Value>) -> MockCournot {
        use axum::routing::post;
        let inner = std::sync::Arc::new(Mutex::new(MockCournotState {
            markets,
            ..Default::default()
        }));
        let router = axum::Router::new()
            .route(crate::cournot::RESOLVE_PATH, post(mock_resolve))
            .route(crate::cournot::PROBABILITY_PATH, post(mock_probability))
            .with_state(inner.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        MockCournot {
            base: format!("http://{addr}"),
            inner,
        }
    }

    pub fn state(&self) -> MockCournotState {
        self.inner.lock().unwrap().clone()
    }

    pub fn set_probability(&self, status: u16, body: serde_json::Value) {
        self.inner.lock().unwrap().probability = Some((status, body));
    }

    pub fn set_rotate_ids(&self, on: bool) {
        self.inner.lock().unwrap().rotate_ids = on;
    }

    pub fn set_markets(&self, markets: Vec<serde_json::Value>) {
        self.inner.lock().unwrap().markets = markets;
    }
}
