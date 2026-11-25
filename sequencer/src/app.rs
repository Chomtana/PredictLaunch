//! Runtime around `State`: chain polling, the batch loop, the keeper loop and the price stream.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use alloy_primitives::{Address, B256, U256};
use anyhow::Context;
use bilauncher_core::state::{AcceptError, Config, Msg, MsgResult, State};
use bilauncher_core::{Domain, BNB_USD_FEED, FEEDS};
use tokio::sync::{broadcast, watch};

use crate::chain::{Chain, ChainInfo};
use crate::keeper::{keeper_actions, KeeperAction};

pub struct Settings {
    pub domain: Domain,
    /// RPC URL the frontend should use.
    pub public_rpc: String,
    pub factory: Address,
    pub portal: Address,
    pub batch_ms: u64,
    pub poll_ms: u64,
    pub dev_faucet: bool,
    /// First block to read Exchange logs from.
    pub start_block: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PriceTick {
    pub feed: Address,
    pub t: u64,
    pub price: U256,
}

/// Ticks kept per feed (24 h).
pub const PRICE_HISTORY_SECS: u64 = 86_400;
pub const PRICE_POLL: Duration = Duration::from_secs(2);

pub struct App<C: Chain> {
    pub chain: C,
    pub settings: Settings,
    pub info: ChainInfo,
    pub state: Mutex<State>,
    pub prices: Mutex<HashMap<Address, VecDeque<(u64, U256)>>>,
    /// Bumped on every observable change; WebSocket clients push a fresh snapshot.
    pub version: watch::Sender<u64>,
    pub price_tx: broadcast::Sender<PriceTick>,
    pub last_error: Mutex<Option<String>>,
    next_block: Mutex<u64>,
    batch_lock: tokio::sync::Mutex<()>,
    keeper_lock: tokio::sync::Mutex<()>,
    backoff: Mutex<HashMap<KeeperAction, u64>>,
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_millis() as u64
}

impl<C: Chain> App<C> {
    /// Connect, read the config views and replay every Exchange event since `start_block`.
    pub async fn new(chain: C, settings: Settings) -> anyhow::Result<Arc<Self>> {
        let info = chain.info().await.context("reading chain info")?;
        let state = State::new(Config {
            domain: settings.domain,
            batch_ms: settings.batch_ms,
        });
        let start = settings.start_block;
        let app = Arc::new(App {
            chain,
            settings,
            info,
            state: Mutex::new(state),
            prices: Mutex::new(HashMap::new()),
            version: watch::channel(0).0,
            price_tx: broadcast::channel(1024).0,
            last_error: Mutex::new(None),
            next_block: Mutex::new(start),
            batch_lock: tokio::sync::Mutex::new(()),
            keeper_lock: tokio::sync::Mutex::new(()),
            backoff: Mutex::new(HashMap::new()),
        });
        app.poll().await.context("replaying Exchange events")?;
        Ok(app)
    }

    pub fn bump(&self) {
        self.version.send_modify(|v| *v += 1);
    }

    /// Validate and soft-confirm an atomic group.
    pub fn submit_group(&self, msgs: Vec<Msg>) -> Result<Vec<MsgResult>, AcceptError> {
        let r = self.state.lock().unwrap().accept_group(msgs, now_ms());
        if r.is_ok() {
            self.bump();
        }
        r
    }

    /// Read new Exchange events into the mirror.
    pub async fn poll(&self) -> anyhow::Result<usize> {
        let from = *self.next_block.lock().unwrap();
        let (events, next) = self.chain.poll_events(from).await?;
        let n = events.len();
        {
            let mut nb = self.next_block.lock().unwrap();
            if *nb != from {
                // Another poll raced us and already applied this range.
                return Ok(0);
            }
            *nb = next;
            self.state.lock().unwrap().apply_events(events, now_ms());
        }
        if n > 0 {
            self.bump();
        }
        Ok(n)
    }

    /// Cut and submit the next batch, if one is due. On failure its fills are reversed.
    pub async fn run_batch(&self) -> anyhow::Result<Option<B256>> {
        let _g = self.batch_lock.lock().await;
        let (batch, dropped) = {
            let mut s = self.state.lock().unwrap();
            let before = s.resting.values().map(|m| m.len()).sum::<usize>();
            let b = s.cut(now_ms());
            let after = s.resting.values().map(|m| m.len()).sum::<usize>();
            (b, before != after)
        };
        if dropped {
            self.bump();
        }
        let Some(batch) = batch else {
            return Ok(None);
        };
        self.bump();
        let res = match self.chain.simulate_batch(&batch).await {
            Ok(()) => self.chain.submit_batch(&batch).await,
            Err(e) => Err(e),
        };
        match res {
            Ok(tx) => {
                *self.last_error.lock().unwrap() = None;
                tracing::info!(
                    "batch ts {} settled in {tx} ({} fills, withdrawTo {})",
                    batch.ts,
                    batch.fills.len(),
                    batch.withdrawTo
                );
                if let Err(e) = self.poll().await {
                    tracing::warn!("poll after batch failed: {e:#}");
                }
                self.bump();
                Ok(Some(tx))
            }
            Err(e) => {
                tracing::warn!("batch ts {} failed, reversing its fills: {e:#}", batch.ts);
                *self.last_error.lock().unwrap() = Some(format!("{e:#}"));
                self.state.lock().unwrap().on_batch_failed(now_ms());
                self.bump();
                Err(e)
            }
        }
    }

    /// Run every keeper action due now, in order.
    pub async fn run_keeper(&self) -> Vec<(KeeperAction, anyhow::Result<B256>)> {
        let _g = self.keeper_lock.lock().await;
        let now = now_ms() / 1000;
        let actions = keeper_actions(&self.state.lock().unwrap(), now);
        let mut out = Vec::new();
        let mut failed_launches = Vec::new();
        for a in actions {
            if failed_launches.contains(&a.launch()) {
                continue;
            }
            if self
                .backoff
                .lock()
                .unwrap()
                .get(&a)
                .is_some_and(|t| *t > now)
            {
                continue;
            }
            let r = match &a {
                KeeperAction::Snapshot(l) => self.chain.snapshot(*l).await,
                KeeperAction::Resolve(l) => self.chain.resolve(*l).await,
                KeeperAction::Redeem(l, users) => self.chain.redeem(*l, users.clone()).await,
                KeeperAction::Graduate(l) => self.chain.graduate(*l).await,
            };
            match &r {
                Ok(tx) => {
                    tracing::info!("keeper {a:?}: {tx}");
                    // Until the events are polled, don't send it again.
                    self.backoff.lock().unwrap().insert(a.clone(), now + 3);
                    if let Err(e) = self.poll().await {
                        tracing::warn!("poll after keeper action failed: {e:#}");
                    }
                }
                Err(e) => {
                    tracing::warn!("keeper {a:?} failed: {e:#}");
                    self.backoff.lock().unwrap().insert(a.clone(), now + 2);
                    failed_launches.push(a.launch());
                }
            }
            out.push((a, r));
        }
        out
    }

    /// Feeds streamed: every feed in the table, plus any other feed a launch uses.
    pub fn price_feeds(&self) -> Vec<Address> {
        let mut v: Vec<Address> = FEEDS.iter().map(|(_, a)| *a).collect();
        if !v.contains(&BNB_USD_FEED) {
            v.push(BNB_USD_FEED);
        }
        for l in self.state.lock().unwrap().launches.values() {
            if !v.contains(&l.feed) {
                v.push(l.feed);
            }
        }
        v
    }

    pub fn record_price(&self, feed: Address, t: u64, price: U256) {
        {
            let mut p = self.prices.lock().unwrap();
            let q = p.entry(feed).or_default();
            if q.back().is_some_and(|(lt, _)| *lt >= t) {
                return;
            }
            q.push_back((t, price));
            while q.front().is_some_and(|(ft, _)| *ft + PRICE_HISTORY_SECS < t) {
                q.pop_front();
            }
        }
        let _ = self.price_tx.send(PriceTick { feed, t, price });
    }

    pub async fn poll_prices(&self) {
        let t = now_ms() / 1000;
        for feed in self.price_feeds() {
            match self.chain.read_feed(feed).await {
                Ok((price, _updated)) => self.record_price(feed, t, price),
                Err(e) => tracing::debug!("feed {feed}: {e:#}"),
            }
        }
    }

    /// Background loops: chain poll + keeper, batch timer, price stream.
    pub fn spawn_background(self: &Arc<Self>) {
        let app = self.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(app.settings.poll_ms));
            loop {
                tick.tick().await;
                if let Err(e) = app.poll().await {
                    tracing::warn!("chain poll failed: {e:#}");
                }
                app.run_keeper().await;
            }
        });
        let app = self.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(200));
            loop {
                tick.tick().await;
                let _ = app.run_batch().await;
            }
        });
        let app = self.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(PRICE_POLL);
            loop {
                tick.tick().await;
                app.poll_prices().await;
            }
        });
    }
}
