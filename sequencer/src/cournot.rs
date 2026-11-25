//! Cournot client (SPEC "Question launches (Cournot)").
//!
//! * `resolve(message, limit ≤ 10)`: `POST {base}/intelligence/v1/resolve {message, limit}`. Free, and
//!   always live (in both modes).
//! * `probability(claim, marketId)`: live mode → `POST {base}/intelligence/v1/probability
//!   {message, market_ids}` (header `COURNOT-API-KEY` when a key is set), parsed leniently, raw body
//!   kept. Mock mode → no `probability` call: the matched market's live YES price from a `resolve`
//!   (0.5 if not found).
//!
//! The API key is never logged (`CournotConfig`'s `Debug` redacts it). There is no x402 wallet flow:
//! a 402 is `payment_required`.

use std::time::Duration;

use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const DEFAULT_API_BASE: &str = "https://interface.cournot.ai";
pub const RESOLVE_PATH: &str = "/intelligence/v1/resolve";
pub const PROBABILITY_PATH: &str = "/intelligence/v1/probability";
pub const KEY_HEADER: &str = "COURNOT-API-KEY";
pub const SOURCE_LIVE: &str = "cournot-live";
pub const SOURCE_MOCK: &str = "mock";
/// Cournot's input-error code.
pub const CODE_INPUT_ERROR: i64 = 4100;
pub const MAX_RESOLVE_LIMIT: u32 = 10;
pub const MOCK_LIMITATION: &str =
    "Simulated oracle (COURNOT_MODE=mock): no Cournot probability call was made.";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Mode {
    #[default]
    Live,
    Mock,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Live => "live",
            Self::Mock => "mock",
        }
    }
}

impl std::str::FromStr for Mode {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        match s.trim().to_ascii_lowercase().as_str() {
            "live" => Ok(Self::Live),
            "mock" => Ok(Self::Mock),
            other => Err(format!("COURNOT_MODE must be live or mock, not {other:?}")),
        }
    }
}

impl std::fmt::Display for Mode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Clone)]
pub struct CournotConfig {
    pub mode: Mode,
    pub api_base: String,
    pub api_key: Option<String>,
}

impl Default for CournotConfig {
    fn default() -> Self {
        Self {
            mode: Mode::Live,
            api_base: DEFAULT_API_BASE.into(),
            api_key: None,
        }
    }
}

impl std::fmt::Debug for CournotConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CournotConfig")
            .field("mode", &self.mode)
            .field("api_base", &self.api_base)
            .field("api_key", &self.api_key.as_ref().map(|_| "<set>"))
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CournotError {
    /// Network error, timeout, 5xx, 429 or an unexpected answer.
    Unavailable(String),
    /// HTTP 402.
    PaymentRequired,
    /// Empty or > 280 bytes, or Cournot code 4100.
    BadQuestion(String),
}

impl CournotError {
    /// The API error code (SPEC).
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unavailable(_) => "cournot_unavailable",
            Self::PaymentRequired => "payment_required",
            Self::BadQuestion(_) => "bad_question",
        }
    }
}

impl std::fmt::Display for CournotError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable(m) => write!(f, "Cournot unavailable: {m}"),
            Self::PaymentRequired => f.write_str(
                "Cournot asked for payment (402): set COURNOT_API_KEY or use COURNOT_MODE=mock",
            ),
            Self::BadQuestion(m) => write!(f, "bad question: {m}"),
        }
    }
}

impl std::error::Error for CournotError {}

/// SPEC question rule: 1–280 bytes (after trimming nothing: the exact text is the claim).
pub fn check_question(q: &str) -> Result<(), CournotError> {
    if q.trim().is_empty() {
        return Err(CournotError::BadQuestion("the question is empty".into()));
    }
    if q.len() > bilauncher_core::MAX_QUESTION_BYTES {
        return Err(CournotError::BadQuestion(format!(
            "the question is {} bytes (max {})",
            q.len(),
            bilauncher_core::MAX_QUESTION_BYTES
        )));
    }
    Ok(())
}

/// One `resolve` result.
#[derive(Clone, Debug, PartialEq)]
pub struct Market {
    pub id: u64,
    pub title: String,
    pub description: String,
    pub start_time: String,
    pub end_time: String,
    /// `market_outcome_price`: the live YES price (not a result).
    pub yes_price: Option<f64>,
    pub matching_confidence: Option<f64>,
    /// `market_info` exactly as Cournot sent it.
    pub info: Value,
}

impl Market {
    /// The API shape of `POST /api/cournot/resolve`.
    pub fn to_api_json(&self) -> Value {
        json!({
            "matchingConfidence": self.matching_confidence,
            "id": self.id,
            "title": self.title,
            "description": self.description,
            "startTime": self.start_time,
            "endTime": self.end_time,
            "yesPrice": self.yes_price,
        })
    }
}

/// Normalized oracle answer (SPEC "Oracle record"). Every field is always serialized (null if unset).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleRecord {
    pub launch_id: Option<u64>,
    /// The exact text sent to Cournot.
    pub claim: String,
    pub market_id: u64,
    /// `market_info` (Cournot's own field names) or null.
    pub market: Option<Value>,
    /// YES probability, 0..1.
    pub probability: Option<f64>,
    pub result: Option<Value>,
    pub basis: Option<Value>,
    /// `"cournot-live"` | `"mock"`.
    pub source: String,
    /// Unix seconds.
    pub fetched_at: u64,
    pub error: Option<String>,
    pub raw: Option<Value>,
}

/// What `parse_probability` extracts from a probability body.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Parsed {
    pub point: Option<f64>,
    pub result: Option<Value>,
    pub basis: Option<Value>,
}

fn as_prob(v: Option<&Value>) -> Option<f64> {
    let x = match v? {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => s.trim().parse().ok()?,
        _ => return None,
    };
    (x.is_finite() && (0.0..=1.0).contains(&x)).then_some(x)
}

fn non_null(v: Option<&Value>) -> Option<Value> {
    v.filter(|x| !x.is_null()).cloned()
}

/// SPEC lenient parse: `point = data.result.point_estimate ?? data.probability.point_estimate ??
/// data.probability (number)`, `basis = data.basis ?? data.probability.basis`, `result = data.result ??
/// data.probability`. A body without `data` is read as the data itself.
pub fn parse_probability(body: &Value) -> Parsed {
    let data = body.get("data").filter(|d| d.is_object()).unwrap_or(body);
    let result_obj = data.get("result");
    let prob = data.get("probability");
    let point = as_prob(result_obj.and_then(|r| r.get("point_estimate")))
        .or_else(|| as_prob(prob.and_then(|p| p.get("point_estimate"))))
        .or_else(|| as_prob(prob));
    let basis = non_null(data.get("basis")).or_else(|| non_null(prob.and_then(|p| p.get("basis"))));
    let result = non_null(result_obj).or_else(|| non_null(prob));
    Parsed {
        point,
        result,
        basis,
    }
}

/// A `market_info` for `market_id` inside a probability body, if it carries one.
fn market_in_body(body: &Value, market_id: u64) -> Option<Value> {
    let data = body.get("data").unwrap_or(body);
    let matches = |m: &Value| m.get("id").and_then(Value::as_u64) == Some(market_id);
    for k in ["market_info", "market"] {
        if let Some(m) = data.get(k).filter(|m| matches(m)) {
            return Some(m.clone());
        }
    }
    data.get("markets")?
        .as_array()?
        .iter()
        .map(|m| m.get("market_info").unwrap_or(m))
        .find(|m| matches(m))
        .cloned()
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_secs()
}

pub struct Cournot {
    pub cfg: CournotConfig,
    http: reqwest::Client,
}

impl Cournot {
    pub fn new(cfg: CournotConfig) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .expect("http client");
        Self { cfg, http }
    }

    pub fn mode(&self) -> Mode {
        self.cfg.mode
    }

    pub fn has_key(&self) -> bool {
        self.cfg.api_key.as_deref().is_some_and(|k| !k.is_empty())
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.cfg.api_base.trim_end_matches('/'))
    }

    /// POST and map the answer: (HTTP status, JSON body) or a `CournotError`.
    async fn post(&self, path: &str, body: &Value, key: bool) -> Result<Value, CournotError> {
        let mut req = self.http.post(self.url(path)).json(body);
        if key {
            if let Some(k) = self.cfg.api_key.as_deref().filter(|k| !k.is_empty()) {
                req = req.header(KEY_HEADER, k);
            }
        }
        let resp = req.send().await.map_err(|e| {
            CournotError::Unavailable(format!("request failed: {}", e.without_url()))
        })?;
        let status = resp.status();
        let text = resp.text().await.map_err(|e| {
            CournotError::Unavailable(format!("reading the answer: {}", e.without_url()))
        })?;
        let json: Option<Value> = serde_json::from_str(&text).ok();
        if status == StatusCode::PAYMENT_REQUIRED {
            return Err(CournotError::PaymentRequired);
        }
        if status == StatusCode::TOO_MANY_REQUESTS {
            return Err(CournotError::Unavailable(
                "rate limited by Cournot (429)".into(),
            ));
        }
        let code = json
            .as_ref()
            .and_then(|v| v.get("code"))
            .and_then(Value::as_i64);
        let msg = json
            .as_ref()
            .and_then(|v| v.get("msg").or_else(|| v.get("message")))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if code == Some(CODE_INPUT_ERROR) {
            return Err(CournotError::BadQuestion(if msg.is_empty() {
                "Cournot input error (4100)".into()
            } else {
                msg
            }));
        }
        if !status.is_success() {
            return Err(CournotError::Unavailable(
                format!("HTTP {status} {msg}").trim().to_string(),
            ));
        }
        let json =
            json.ok_or_else(|| CournotError::Unavailable("the answer is not JSON".into()))?;
        if let Some(c) = code.filter(|c| *c != 0) {
            return Err(CournotError::Unavailable(format!(
                "Cournot code {c}: {msg}"
            )));
        }
        Ok(json)
    }

    /// Free market search (always live).
    pub async fn resolve(&self, message: &str, limit: u32) -> Result<Vec<Market>, CournotError> {
        let limit = limit.clamp(1, MAX_RESOLVE_LIMIT);
        let body = self
            .post(
                RESOLVE_PATH,
                &json!({"message": message, "limit": limit}),
                false,
            )
            .await?;
        let markets = body
            .get("data")
            .and_then(|d| d.get("markets"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let str_of = |v: &Value, k: &str| {
            v.get(k)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        Ok(markets
            .iter()
            .filter_map(|m| {
                let info = m.get("market_info")?;
                let id = match info.get("id")? {
                    Value::Number(n) => n.as_u64()?,
                    Value::String(s) => s.parse().ok()?,
                    _ => return None,
                };
                Some(Market {
                    id,
                    title: str_of(info, "title"),
                    description: str_of(info, "description"),
                    start_time: str_of(info, "start_time"),
                    end_time: str_of(info, "end_time"),
                    yes_price: as_prob(info.get("market_outcome_price")),
                    matching_confidence: m.get("matching_confidence").and_then(Value::as_f64),
                    info: info.clone(),
                })
            })
            .collect())
    }

    /// One market by id from a `resolve(claim)`, if Cournot still lists it.
    pub async fn find_market(
        &self,
        claim: &str,
        market_id: u64,
    ) -> Result<Option<Market>, CournotError> {
        if market_id == 0 {
            return Ok(None);
        }
        Ok(self
            .resolve(claim, MAX_RESOLVE_LIMIT)
            .await?
            .into_iter()
            .find(|m| m.id == market_id))
    }

    /// The raw live `probability` body.
    pub async fn probability_raw(
        &self,
        claim: &str,
        market_id: u64,
    ) -> Result<Value, CournotError> {
        let ids: Vec<u64> = if market_id == 0 {
            vec![]
        } else {
            vec![market_id]
        };
        self.post(
            PROBABILITY_PATH,
            &json!({"message": claim, "market_ids": ids}),
            true,
        )
        .await
    }

    /// A probability record for `claim` (mode-aware).
    pub async fn probability(
        &self,
        claim: &str,
        market_id: u64,
        launch_id: Option<u64>,
    ) -> Result<OracleRecord, CournotError> {
        check_question(claim)?;
        match self.cfg.mode {
            Mode::Mock => {
                let m = self.find_market(claim, market_id).await?;
                let p = m.as_ref().and_then(|m| m.yes_price).unwrap_or(0.5);
                let summary = match &m {
                    Some(m) => format!("{} trades at {p}", m.title),
                    None => format!("no matching Cournot market; defaulting to {p}"),
                };
                Ok(OracleRecord {
                    launch_id,
                    claim: claim.into(),
                    market_id,
                    market: m.map(|m| m.info),
                    probability: Some(p),
                    result: Some(json!({"point_estimate": p, "mock": true})),
                    basis: Some(json!({
                        "primary_anchor": {"source": "mock", "summary": summary, "market_id": market_id},
                        "limitations": [MOCK_LIMITATION],
                    })),
                    source: SOURCE_MOCK.into(),
                    fetched_at: now_secs(),
                    error: None,
                    raw: None,
                })
            }
            Mode::Live => {
                let body = self.probability_raw(claim, market_id).await?;
                let parsed = parse_probability(&body);
                let mut market = market_in_body(&body, market_id);
                if market.is_none() && market_id != 0 {
                    // Best effort and free: the market's info for the UI.
                    market = self
                        .find_market(claim, market_id)
                        .await
                        .ok()
                        .flatten()
                        .map(|m| m.info);
                }
                Ok(OracleRecord {
                    launch_id,
                    claim: claim.into(),
                    market_id,
                    market,
                    probability: parsed.point,
                    result: parsed.result,
                    basis: parsed.basis,
                    source: SOURCE_LIVE.into(),
                    fetched_at: now_secs(),
                    error: None,
                    raw: Some(body),
                })
            }
        }
    }
}
