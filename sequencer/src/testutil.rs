//! An in-memory `Chain` for tests: an event log the test appends to, recorded keeper calls, and
//! a switch to make batch simulation fail. `submit_batch` appends `BatchSubmitted` (with the
//! batch) like the real contract would.

use std::collections::HashMap;
use std::sync::Mutex;

use alloy_primitives::{Address, B256, U256};
use bilauncher_core::abi;
use bilauncher_core::eip712::TestKey;
use bilauncher_core::state::ChainEvent;
use bilauncher_core::{order_hash, Domain, Order, Outcome, Side};

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
}

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
    async fn info(&self) -> anyhow::Result<ChainInfo> {
        Ok(ChainInfo {
            chain_id: 97,
            salt_lock_fee: U256::from(5_000_000_000_000_000u64),
            min_target: U256::from(2_150_000_000_000_000_000u64),
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
