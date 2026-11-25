//! Oracle side of question launches (SPEC "Sequencer behaviour"): the file store, the opening call,
//! the price tracker and the resolver. Runs in its own tasks (`spawn`): a Cournot or file failure is
//! logged and never touches batching or the keeper.
//!
//! Files under `--oracle-dir` (default `.dev/oracle`):
//! * `launch-<id>.json`   opening `OracleRecord` (written once, even on error: the file is the cache)
//! * `price-<id>.json`    `[{t, price}]` from the tracker
//! * `settle-<id>.json`   the evidence the resolver proposed; `evidenceHash = keccak256(file bytes)`
//! * `recheck-<id>.json`  the resolver's one extra probability call (so it is never repeated)
//! * `preview-<h>.json`   `POST /api/cournot/probability` cache, `h` = keccak256(claim ‖ 0 ‖ marketId)

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use alloy_primitives::{keccak256, B256};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::app::{now_ms, App};
use crate::chain::Chain;
use crate::cournot::{Cournot, CournotConfig, CournotError, Mode, OracleRecord, SOURCE_LIVE};
use crate::keeper::{decide, proposals_due, KeeperAction};

pub const DEFAULT_ORACLE_DIR: &str = ".dev/oracle";
/// Opening calls and the resolver.
pub const ORACLE_TICK: Duration = Duration::from_secs(2);
/// The price tracker.
pub const TRACK_EVERY: Duration = Duration::from_secs(60);
/// Default per-IP spacing of the two Cournot POSTs.
pub const DEFAULT_RATE_LIMIT_MS: u64 = 2000;
/// A proposal sent is not re-sent for this long (its event is on its way).
const PROPOSE_RESEND_SECS: u64 = 30;

#[derive(Clone, Debug)]
pub struct OracleSettings {
    pub cournot: CournotConfig,
    pub dir: PathBuf,
    /// Minimum spacing, per IP and endpoint, of `POST /api/cournot/*` (0 = off).
    pub rate_limit_ms: u64,
}

impl Default for OracleSettings {
    fn default() -> Self {
        Self {
            cournot: CournotConfig::default(),
            dir: DEFAULT_ORACLE_DIR.into(),
            rate_limit_ms: DEFAULT_RATE_LIMIT_MS,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct PricePoint {
    pub t: u64,
    pub price: f64,
}

/// What `LaunchSummary` shows of the opening record.
#[derive(Clone, Debug, PartialEq)]
pub struct OracleBrief {
    pub probability: Option<f64>,
    pub source: String,
}

// ------------------------------------------------------------------------------- store

pub struct OracleStore {
    pub dir: PathBuf,
}

fn read_json<T: for<'de> Deserialize<'de>>(p: &Path) -> Option<T> {
    let bytes = std::fs::read(p).ok()?;
    match serde_json::from_slice(&bytes) {
        Ok(v) => Some(v),
        Err(e) => {
            tracing::warn!("oracle: unreadable {}: {e}", p.display());
            None
        }
    }
}

impl OracleStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    /// Write `bytes` atomically (temp file + rename).
    pub fn write_bytes(&self, name: &str, bytes: &[u8]) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        let tmp = self.path(&format!(".{name}.tmp"));
        std::fs::write(&tmp, bytes)?;
        std::fs::rename(&tmp, self.path(name))
    }

    fn write_json<T: Serialize>(&self, name: &str, v: &T) -> std::io::Result<Vec<u8>> {
        let bytes = serde_json::to_vec_pretty(v).map_err(std::io::Error::other)?;
        self.write_bytes(name, &bytes)?;
        Ok(bytes)
    }

    pub fn opening(&self, id: u64) -> Option<OracleRecord> {
        read_json(&self.path(&format!("launch-{id}.json")))
    }

    pub fn has_opening(&self, id: u64) -> bool {
        self.path(&format!("launch-{id}.json")).exists()
    }

    pub fn write_opening(&self, id: u64, r: &OracleRecord) -> std::io::Result<()> {
        self.write_json(&format!("launch-{id}.json"), r).map(|_| ())
    }

    pub fn prices(&self, id: u64) -> Vec<PricePoint> {
        read_json(&self.path(&format!("price-{id}.json"))).unwrap_or_default()
    }

    pub fn append_price(&self, id: u64, p: PricePoint) -> std::io::Result<()> {
        let mut v = self.prices(id);
        v.push(p);
        self.write_json(&format!("price-{id}.json"), &v).map(|_| ())
    }

    /// The settlement evidence and its exact bytes.
    pub fn settlement_bytes(&self, id: u64) -> Option<Vec<u8>> {
        std::fs::read(self.path(&format!("settle-{id}.json"))).ok()
    }

    pub fn settlement(&self, id: u64) -> Option<OracleRecord> {
        read_json(&self.path(&format!("settle-{id}.json")))
    }

    /// Write the evidence; returns `keccak256` of the exact bytes written.
    pub fn write_settlement(&self, id: u64, r: &OracleRecord) -> std::io::Result<B256> {
        Ok(keccak256(self.write_json(&format!("settle-{id}.json"), r)?))
    }

    pub fn recheck(&self, id: u64) -> Option<OracleRecord> {
        read_json(&self.path(&format!("recheck-{id}.json")))
    }

    pub fn has_recheck(&self, id: u64) -> bool {
        self.path(&format!("recheck-{id}.json")).exists()
    }

    pub fn write_recheck(&self, id: u64, r: &OracleRecord) -> std::io::Result<()> {
        self.write_json(&format!("recheck-{id}.json"), r)
            .map(|_| ())
    }

    pub fn preview_name(claim: &str, market_id: u64) -> String {
        let mut k = claim.as_bytes().to_vec();
        k.push(0);
        k.extend(market_id.to_string().as_bytes());
        let h = keccak256(&k);
        format!("preview-{}.json", alloy_primitives::hex::encode(&h[..16]))
    }

    pub fn preview(&self, claim: &str, market_id: u64) -> Option<OracleRecord> {
        read_json::<OracleRecord>(&self.path(&Self::preview_name(claim, market_id)))
            .filter(|r| r.claim == claim && r.market_id == market_id)
    }

    pub fn write_preview(&self, r: &OracleRecord) -> std::io::Result<()> {
        self.write_json(&Self::preview_name(&r.claim, r.market_id), r)
            .map(|_| ())
    }
}

// ------------------------------------------------------------------------------- runtime

pub struct Oracle {
    pub cournot: Cournot,
    pub store: OracleStore,
    pub rate_limit_ms: u64,
    /// launch → opening probability/source (for `LaunchSummary`).
    pub briefs: Mutex<HashMap<u64, OracleBrief>>,
    /// launch → the last `market_info` the tracker saw (for the evidence).
    last_market: Mutex<HashMap<u64, Value>>,
    /// (endpoint, client) → last accepted request (ms).
    rate: Mutex<HashMap<(&'static str, String), u64>>,
    /// launch → when a proposal was last sent (s).
    proposed_sent: Mutex<HashMap<u64, u64>>,
    /// Serializes preview calls so two identical previews don't both reach Cournot.
    preview_lock: tokio::sync::Mutex<()>,
    warned_not_resolver: AtomicBool,
}

impl Oracle {
    pub fn new(s: &OracleSettings) -> Self {
        Self {
            cournot: Cournot::new(s.cournot.clone()),
            store: OracleStore::new(&s.dir),
            rate_limit_ms: s.rate_limit_ms,
            briefs: Mutex::new(HashMap::new()),
            last_market: Mutex::new(HashMap::new()),
            rate: Mutex::new(HashMap::new()),
            proposed_sent: Mutex::new(HashMap::new()),
            preview_lock: tokio::sync::Mutex::new(()),
            warned_not_resolver: AtomicBool::new(false),
        }
    }

    pub fn mode(&self) -> Mode {
        self.cournot.mode()
    }

    /// Per-(endpoint, client) rate limit: `true` = allowed (and recorded).
    pub fn allow(&self, endpoint: &'static str, client: &str, now_ms: u64) -> bool {
        if self.rate_limit_ms == 0 {
            return true;
        }
        let mut r = self.rate.lock().unwrap();
        let key = (endpoint, client.to_string());
        if r.get(&key)
            .is_some_and(|t| now_ms < t.saturating_add(self.rate_limit_ms))
        {
            return false;
        }
        r.retain(|_, t| now_ms < t.saturating_add(self.rate_limit_ms));
        r.insert(key, now_ms);
        true
    }

    pub fn brief(&self, id: u64) -> Option<OracleBrief> {
        self.briefs.lock().unwrap().get(&id).cloned()
    }

    fn set_brief(&self, id: u64, r: &OracleRecord) {
        self.briefs.lock().unwrap().insert(
            id,
            OracleBrief {
                probability: r.probability,
                source: r.source.clone(),
            },
        );
    }
}

fn error_record(
    claim: &str,
    market_id: u64,
    launch_id: u64,
    mode: Mode,
    e: &CournotError,
) -> OracleRecord {
    OracleRecord {
        launch_id: Some(launch_id),
        claim: claim.into(),
        market_id,
        market: None,
        probability: None,
        result: None,
        basis: None,
        source: match mode {
            Mode::Live => SOURCE_LIVE.into(),
            Mode::Mock => crate::cournot::SOURCE_MOCK.into(),
        },
        fetched_at: now_ms() / 1000,
        error: Some(format!("{}: {e}", e.code())),
        raw: None,
    }
}

/// The question launches the oracle cares about: (id, question, marketId, resolved).
fn question_launches<C: Chain>(app: &App<C>) -> Vec<(u64, String, u64, bool)> {
    app.state
        .lock()
        .unwrap()
        .launches
        .values()
        .filter(|l| l.is_question())
        .filter_map(|l| Some((l.id, l.question.clone()?, l.market_id, l.resolved)))
        .collect()
}

impl<C: Chain> App<C> {
    /// `POST /api/cournot/probability`: the cached preview for `(claim, marketId)`, else one call.
    pub async fn oracle_preview(
        &self,
        claim: &str,
        market_id: u64,
    ) -> Result<OracleRecord, CournotError> {
        crate::cournot::check_question(claim)?;
        let o = &self.oracle;
        let _g = o.preview_lock.lock().await;
        if let Some(r) = o.store.preview(claim, market_id) {
            return Ok(r);
        }
        let r = o.cournot.probability(claim, market_id, None).await?;
        if let Err(e) = o.store.write_preview(&r) {
            tracing::warn!("oracle: writing a preview: {e}");
        }
        Ok(r)
    }

    /// Opening call for every unresolved question launch without `launch-<id>.json`: the cached
    /// preview for `(question, marketId)` if any, else one `probability` call. Returns the number
    /// of Cournot calls made.
    pub async fn oracle_open(&self) -> usize {
        let o = &self.oracle;
        let mut calls = 0;
        for (id, q, market_id, resolved) in question_launches(self) {
            if o.brief(id).is_some() {
                continue;
            }
            if let Some(r) = o.store.opening(id) {
                o.set_brief(id, &r);
                continue;
            }
            if resolved || o.store.has_opening(id) {
                continue;
            }
            let rec = match o.store.preview(&q, market_id) {
                Some(mut r) => {
                    r.launch_id = Some(id);
                    r
                }
                None => {
                    calls += 1;
                    match o.cournot.probability(&q, market_id, Some(id)).await {
                        Ok(r) => r,
                        Err(e) => {
                            tracing::warn!("oracle: opening call for launch {id}: {e}");
                            error_record(&q, market_id, id, o.mode(), &e)
                        }
                    }
                }
            };
            match o.store.write_opening(id, &rec) {
                Ok(()) => o.set_brief(id, &rec),
                Err(e) => tracing::warn!("oracle: writing launch-{id}.json: {e}"),
            }
        }
        calls
    }

    /// Tracker: for each unresolved question launch with a market, `resolve(question)` and append
    /// the market's YES price when Cournot still lists it.
    pub async fn oracle_track(&self, now: u64) {
        let o = &self.oracle;
        for (id, q, market_id, resolved) in question_launches(self) {
            if resolved || market_id == 0 {
                continue;
            }
            match o.cournot.find_market(&q, market_id).await {
                Ok(Some(m)) => {
                    if let Some(price) = m.yes_price {
                        if let Err(e) = o.store.append_price(id, PricePoint { t: now, price }) {
                            tracing::warn!("oracle: writing price-{id}.json: {e}");
                        }
                    }
                    o.last_market.lock().unwrap().insert(id, m.info);
                }
                Ok(None) => tracing::debug!("oracle: market {market_id} of launch {id} not listed"),
                Err(e) => tracing::debug!("oracle: tracker for launch {id}: {e}"),
            }
        }
    }

    /// Resolver: decide every due question launch (SPEC thresholds), write `settle-<id>.json` and
    /// send `proposeOutcome(id, outcome, keccak256(file))`.
    pub async fn oracle_resolve(&self, now: u64) -> Vec<(KeeperAction, anyhow::Result<B256>)> {
        let o = &self.oracle;
        let mut out = Vec::new();
        let due = proposals_due(&self.state.lock().unwrap(), now);
        if due.is_empty() {
            return out;
        }
        if self.info.resolver != self.info.operator {
            if !o.warned_not_resolver.swap(true, Ordering::Relaxed) {
                tracing::warn!(
                    "oracle: the operator {} is not the Exchange resolver ({}); question launches wait for overrideOutcome",
                    self.info.operator,
                    self.info.resolver
                );
            }
            return out;
        }
        for id in due {
            if o.proposed_sent
                .lock()
                .unwrap()
                .get(&id)
                .is_some_and(|t| now < t + PROPOSE_RESEND_SECS)
            {
                continue;
            }
            let Some((q, market_id)) = self
                .state
                .lock()
                .unwrap()
                .launches
                .get(&id)
                .and_then(|l| Some((l.question.clone()?, l.market_id)))
            else {
                continue;
            };
            // An earlier decision whose proposal did not land: re-send the same evidence.
            let decided = match o.store.settlement_bytes(id) {
                Some(bytes) => {
                    let outcome = o
                        .store
                        .settlement(id)
                        .and_then(|r| r.result)
                        .and_then(|r| r.get("outcome").and_then(Value::as_u64))
                        .map(|x| x as u8);
                    outcome.map(|oc| (oc, keccak256(&bytes)))
                }
                None => self.oracle_decide(id, &q, market_id).await,
            };
            let Some((outcome, hash)) = decided else {
                continue;
            };
            let a = KeeperAction::Propose(id, outcome, hash);
            let r = {
                let _g = self.keeper_lock.lock().await;
                self.execute(&a).await
            };
            match &r {
                Ok(tx) => {
                    tracing::info!("resolver {a:?}: {tx}");
                    o.proposed_sent.lock().unwrap().insert(id, now);
                    if let Err(e) = self.poll().await {
                        tracing::warn!("poll after proposal failed: {e:#}");
                    }
                }
                Err(e) => tracing::warn!("resolver {a:?} failed: {e:#}"),
            }
            out.push((a, r));
        }
        out
    }

    /// The decision for one launch, with its evidence written: the last tracked price, else (at most
    /// once, and only in mock mode or with a key) one more probability call.
    async fn oracle_decide(&self, id: u64, q: &str, market_id: u64) -> Option<(u8, B256)> {
        let o = &self.oracle;
        let last = o.store.prices(id).last().copied();
        if let Some(p) = last {
            if let Some(outcome) = decide(p.price) {
                let market = o.last_market.lock().unwrap().get(&id).cloned();
                let title = market
                    .as_ref()
                    .and_then(|m| m.get("title"))
                    .and_then(Value::as_str)
                    .unwrap_or("the market")
                    .to_string();
                let rec = OracleRecord {
                    launch_id: Some(id),
                    claim: q.into(),
                    market_id,
                    market,
                    probability: Some(p.price),
                    result: Some(json!({
                        "outcome": outcome,
                        "outcomeName": outcome_name(outcome),
                        "decidedBy": "tracker",
                        "price": p.price,
                        "t": p.t,
                        "rule": rule(outcome),
                    })),
                    basis: Some(json!({
                        "primary_anchor": {
                            "source": "cournot-resolve",
                            "summary": format!("{title} traded at {} (t = {})", p.price, p.t),
                            "market_id": market_id,
                        },
                    })),
                    source: SOURCE_LIVE.into(),
                    fetched_at: now_ms() / 1000,
                    error: None,
                    raw: None,
                };
                return self.write_evidence(id, outcome, rec);
            }
        }
        if o.store.has_recheck(id) || !(o.mode() == Mode::Mock || o.cournot.has_key()) {
            return None;
        }
        let rec = match o.cournot.probability(q, market_id, Some(id)).await {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("oracle: resolver call for launch {id}: {e}");
                error_record(q, market_id, id, o.mode(), &e)
            }
        };
        if let Err(e) = o.store.write_recheck(id, &rec) {
            tracing::warn!("oracle: writing recheck-{id}.json: {e}");
        }
        let outcome = rec.probability.and_then(decide)?;
        let mut rec = rec;
        let mut result = json!({
            "outcome": outcome,
            "outcomeName": outcome_name(outcome),
            "decidedBy": "probability",
            "rule": rule(outcome),
        });
        if let Some(r) = rec.result.take() {
            result["cournot"] = r;
        }
        rec.result = Some(result);
        self.write_evidence(id, outcome, rec)
    }

    fn write_evidence(&self, id: u64, outcome: u8, rec: OracleRecord) -> Option<(u8, B256)> {
        match self.oracle.store.write_settlement(id, &rec) {
            Ok(h) => Some((outcome, h)),
            Err(e) => {
                tracing::warn!("oracle: writing settle-{id}.json: {e}");
                None
            }
        }
    }

    /// `GET /api/launch/:id/oracle` (`None` = unknown launch).
    pub fn oracle_view(&self, id: u64) -> Option<Value> {
        let (is_q, proposal, cw) = {
            let st = self.state.lock().unwrap();
            let l = st.launches.get(&id)?;
            (l.is_question(), l.proposal.clone(), st.challenge_window)
        };
        if !is_q {
            return Some(
                json!({"opening": null, "prices": [], "settlement": null, "proposal": null}),
            );
        }
        let s = &self.oracle.store;
        let proposal = proposal.map_or(Value::Null, |p| {
            json!({
                "proposed": true,
                "outcome": p.outcome,
                "proposedAt": p.proposed_at,
                "evidenceHash": p.evidence_hash,
                "final": p.final_,
                "challengeEndsAt": if p.final_ { p.proposed_at } else { p.proposed_at + cw },
            })
        });
        Some(json!({
            "opening": s.opening(id),
            "prices": s.prices(id),
            "settlement": s.settlement(id),
            "proposal": proposal,
        }))
    }
}

fn outcome_name(o: u8) -> &'static str {
    match o {
        0 => "YES",
        1 => "NO",
        _ => "VOID",
    }
}

fn rule(o: u8) -> String {
    match o {
        0 => format!("probability >= {}", crate::keeper::YES_THRESHOLD),
        _ => format!("probability <= {}", crate::keeper::NO_THRESHOLD),
    }
}

/// The oracle loops: opening calls + resolver every `ORACLE_TICK`, the tracker every `TRACK_EVERY`.
pub fn spawn<C: Chain>(app: &Arc<App<C>>) {
    let a = app.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(ORACLE_TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            a.oracle_open().await;
            a.oracle_resolve(now_ms() / 1000).await;
        }
    });
    let a = app.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(TRACK_EVERY);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            a.oracle_track(now_ms() / 1000).await;
        }
    });
}
