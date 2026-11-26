//! What the sequencer needs from the chain. `RpcChain` talks to a node through alloy with the
//! operator key; tests use `testutil::FakeChain`.
//!
//! Events are decoded by signature with `alloy-dyn-abi`, because SPEC does not fix which event
//! parameters are `indexed`: for each log, the decoder tries the leading parameters as the indexed
//! ones first, then every other choice, and keeps the first layout that re-encodes to exactly the
//! log's data. `BatchSubmitted` logs are completed with the decoded `submitBatch` calldata of their
//! transaction, so the mirror can be rebuilt from the chain alone.

use std::future::{Future, IntoFuture};

use alloy::consensus::Transaction as _;
use alloy::dyn_abi::{DynSolType, DynSolValue};
use alloy::eips::BlockId;
use alloy::network::{EthereumWallet, TransactionBuilder};
use alloy::providers::{DynProvider, Provider, ProviderBuilder};
use alloy::rpc::types::{Filter, TransactionRequest};
use alloy::signers::local::PrivateKeySigner;
use alloy::signers::Signer as _;
use alloy_primitives::{keccak256, Address, Bytes, B256, U256};
use alloy_sol_types::SolCall;
use anyhow::Context;
use predictlaunch_core::abi::{self, IAggregator, IExchange, IFourRail, IPortal, IQuoteToken};
use predictlaunch_core::state::ChainEvent;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChainInfo {
    pub chain_id: u64,
    pub salt_lock_fee: U256,
    pub min_target: U256,
    /// `Exchange.quoteToken()`: address(0) = native BNB.
    pub quote_token: Address,
    /// The quote token's on-chain symbol ("BNB" for native).
    pub quote_symbol: String,
    /// `Exchange.challengeWindow()` (DEFAULT_CHALLENGE_WINDOW if the view is missing).
    pub challenge_window: u64,
    /// `Exchange.resolver()` (address(0) if unset or missing).
    pub resolver: Address,
    /// The address this sequencer sends transactions from.
    pub operator: Address,
}

pub trait Chain: Send + Sync + 'static {
    /// Events from block `from` (inclusive) to the head; returns them and the next `from`.
    fn poll_events(
        &self,
        from: u64,
    ) -> impl Future<Output = anyhow::Result<(Vec<ChainEvent>, u64)>> + Send;
    /// `eth_call` of `submitBatch` (Err = it would revert).
    fn simulate_batch(&self, b: &abi::Batch) -> impl Future<Output = anyhow::Result<()>> + Send;
    fn submit_batch(&self, b: &abi::Batch) -> impl Future<Output = anyhow::Result<B256>> + Send;
    fn snapshot(&self, launch: u64) -> impl Future<Output = anyhow::Result<B256>> + Send;
    fn resolve(&self, launch: u64) -> impl Future<Output = anyhow::Result<B256>> + Send;
    fn redeem(
        &self,
        launch: u64,
        users: Vec<Address>,
    ) -> impl Future<Output = anyhow::Result<B256>> + Send;
    fn graduate(&self, launch: u64) -> impl Future<Output = anyhow::Result<B256>> + Send;
    /// Resolver: `proposeOutcome(launch, outcome, evidenceHash)` on a question launch.
    fn propose_outcome(
        &self,
        launch: u64,
        outcome: u8,
        evidence_hash: B256,
    ) -> impl Future<Output = anyhow::Result<B256>> + Send;
    /// `Exchange.funds(users)` at `block` (ERC20 quote: internal balance + min(wallet, allowance)).
    /// `None` = not available (the caller keeps event-derived balances).
    fn read_funds(
        &self,
        users: Vec<Address>,
        block: u64,
    ) -> impl Future<Output = anyhow::Result<Option<Vec<U256>>>> + Send;
    /// `latestRoundData()` → (answer, updatedAt).
    fn read_feed(&self, feed: Address) -> impl Future<Output = anyhow::Result<(U256, u64)>> + Send;
    /// Dev faucet: `anvil_setBalance`.
    fn set_balance(
        &self,
        who: Address,
        amount: U256,
    ) -> impl Future<Output = anyhow::Result<()>> + Send;
    /// Dev faucet: `quote.mint(who, amount)` from the operator (test tokens with a public mint).
    fn mint_quote(
        &self,
        quote: Address,
        who: Address,
        amount: U256,
    ) -> impl Future<Output = anyhow::Result<()>> + Send;
    fn info(&self) -> impl Future<Output = anyhow::Result<ChainInfo>> + Send;
}

// ------------------------------------------------------------------------------- event decoding

struct EventDef {
    name: &'static str,
    params: &'static [&'static str],
}

const EVENTS: &[EventDef] = &[
    EventDef { name: "Deposited", params: &["address", "uint256"] },
    EventDef { name: "WithdrawRequested", params: &["uint64", "address", "uint256"] },
    EventDef { name: "WithdrawPaid", params: &["uint64", "address", "uint256", "uint256"] },
    EventDef { name: "KeyAuthorized", params: &["address", "address", "uint64"] },
    EventDef { name: "KeyRevoked", params: &["address", "address"] },
    EventDef { name: "OrderCancelled", params: &["address", "bytes32"] },
    EventDef {
        name: "OrderPosted",
        params: &[
            "bytes32", "address", "uint256", "uint64", "uint8", "uint8", "uint8", "uint128", "uint64",
            "uint64", "bytes",
        ],
    },
    EventDef { name: "MinNonceBumped", params: &["address", "uint64"] },
    EventDef {
        name: "LaunchCreated",
        params: &[
            "uint256", "address", "address", "address", "address", "uint256", "uint64", "uint16",
            "uint256", "string", "string", "string",
        ],
    },
    EventDef { name: "Snapshot", params: &["uint256", "uint256", "uint64"] },
    EventDef { name: "Resolved", params: &["uint256", "uint8", "uint256", "uint256"] },
    EventDef { name: "Graduating", params: &["uint256"] },
    EventDef { name: "Graduated", params: &["uint256", "address", "uint256"] },
    EventDef { name: "LaunchFailed", params: &["uint256"] },
    EventDef { name: "Redeemed", params: &["uint256", "address", "uint256", "uint256"] },
    EventDef { name: "TokensClaimed", params: &["uint256", "address", "uint256"] },
    EventDef { name: "BatchSubmitted", params: &["uint64", "uint64", "uint256"] },
    EventDef { name: "FillSkipped", params: &["uint64", "uint256", "address"] },
    EventDef { name: "QuestionSet", params: &["uint256", "string", "uint256"] },
    EventDef {
        name: "OutcomeProposed",
        params: &["uint256", "uint8", "bytes32", "address", "bool"],
    },
    EventDef { name: "ChallengeWindowSet", params: &["uint64"] },
];

fn signature(d: &EventDef) -> String {
    format!("{}({})", d.name, d.params.join(","))
}

pub fn event_topics() -> Vec<(B256, &'static str)> {
    EVENTS
        .iter()
        .map(|d| (keccak256(signature(d).as_bytes()), d.name))
        .collect()
}

/// Decode one indexed topic word strictly (value must fit the type).
fn decode_word(ty: &DynSolType, w: &B256) -> Option<DynSolValue> {
    let v = U256::from_be_bytes(w.0);
    match ty {
        DynSolType::Address => (v >> 160usize).is_zero().then(|| DynSolValue::Address(Address::from_word(*w))),
        DynSolType::Uint(bits) => {
            (*bits == 256 || (v >> *bits).is_zero()).then_some(DynSolValue::Uint(v, *bits))
        }
        DynSolType::FixedBytes(32) => Some(DynSolValue::FixedBytes(*w, 32)),
        DynSolType::Bool => (v <= U256::from(1)).then_some(DynSolValue::Bool(v == U256::from(1))),
        _ => None, // dynamic types are hashed when indexed: not decodable
    }
}

fn combos(n: usize, k: usize) -> Vec<Vec<usize>> {
    let mut out = vec![(0..k).collect::<Vec<_>>()];
    fn rec(start: usize, n: usize, k: usize, cur: &mut Vec<usize>, out: &mut Vec<Vec<usize>>) {
        if cur.len() == k {
            if cur.iter().enumerate().any(|(i, v)| *v != i) {
                out.push(cur.clone());
            }
            return;
        }
        for i in start..n {
            cur.push(i);
            rec(i + 1, n, k, cur, out);
            cur.pop();
        }
    }
    if k <= n {
        rec(0, n, k, &mut Vec::new(), &mut out);
    } else {
        out.clear();
    }
    out
}

/// Decode a log's parameters for `def` given its topics (without topic0) and data.
fn decode_params(def: &EventDef, topics: &[B256], data: &[u8]) -> Option<Vec<DynSolValue>> {
    let types: Vec<DynSolType> = def
        .params
        .iter()
        .map(|t| DynSolType::parse(t).expect("valid type"))
        .collect();
    for idx in combos(types.len(), topics.len()) {
        let mut vals: Vec<Option<DynSolValue>> = vec![None; types.len()];
        let mut ok = true;
        for (t, i) in topics.iter().zip(&idx) {
            match decode_word(&types[*i], t) {
                Some(v) => vals[*i] = Some(v),
                None => {
                    ok = false;
                    break;
                }
            }
        }
        if !ok {
            continue;
        }
        let rest: Vec<DynSolType> = (0..types.len())
            .filter(|i| !idx.contains(i))
            .map(|i| types[i].clone())
            .collect();
        let decoded = if rest.is_empty() {
            if !data.is_empty() {
                continue;
            }
            vec![]
        } else {
            let Ok(DynSolValue::Tuple(v)) = DynSolType::Tuple(rest).abi_decode_sequence(data) else {
                continue;
            };
            if DynSolValue::Tuple(v.clone()).abi_encode_params() != data {
                continue;
            }
            v
        };
        let mut it = decoded.into_iter();
        let full: Option<Vec<DynSolValue>> =
            vals.into_iter().map(|v| v.or_else(|| it.next())).collect();
        if let Some(f) = full {
            return Some(f);
        }
    }
    None
}

fn u256(v: &DynSolValue) -> U256 {
    v.as_uint().map(|x| x.0).unwrap_or_default()
}
fn u64v(v: &DynSolValue) -> u64 {
    u256(v).saturating_to()
}
fn addr(v: &DynSolValue) -> Address {
    v.as_address().unwrap_or_default()
}
fn string(v: &DynSolValue) -> String {
    v.as_str().unwrap_or_default().to_string()
}

/// Decode one `Exchange` log into a `ChainEvent` (`None` = not one of ours, e.g. `Trade`).
/// `BatchSubmitted` comes back with `batch: None`; the caller fills it from the transaction.
pub fn decode_log(topics: &[B256], data: &[u8], block_ts: u64) -> Option<ChainEvent> {
    let t0 = topics.first()?;
    let def = EVENTS
        .iter()
        .find(|d| keccak256(signature(d).as_bytes()) == *t0)?;
    let p = decode_params(def, &topics[1..], data)?;
    use ChainEvent as E;
    Some(match def.name {
        "Deposited" => E::Deposited { user: addr(&p[0]), amount: u256(&p[1]) },
        "FillSkipped" => E::FillSkipped {
            batch_id: u64v(&p[0]),
            index: u64v(&p[1]),
            user: addr(&p[2]),
        },
        "WithdrawRequested" => E::WithdrawRequested {
            idx: u64v(&p[0]),
            user: addr(&p[1]),
            amount: u256(&p[2]),
        },
        "WithdrawPaid" => E::WithdrawPaid {
            idx: u64v(&p[0]),
            user: addr(&p[1]),
            requested: u256(&p[2]),
            paid: u256(&p[3]),
        },
        "KeyAuthorized" => E::KeyAuthorized {
            owner: addr(&p[0]),
            key: addr(&p[1]),
            expiry: u64v(&p[2]),
        },
        "KeyRevoked" => E::KeyRevoked { owner: addr(&p[0]), key: addr(&p[1]) },
        "OrderCancelled" => E::OrderCancelled {
            owner: addr(&p[0]),
            order_hash: p[1].as_word().unwrap_or_default(),
        },
        "OrderPosted" => E::OrderPosted { order_hash: p[0].as_word().unwrap_or_default() },
        "MinNonceBumped" => E::MinNonceBumped { owner: addr(&p[0]), min_nonce: u64v(&p[1]) },
        "LaunchCreated" => E::LaunchCreated {
            launch_id: u64v(&p[0]),
            creator: addr(&p[1]),
            rail: addr(&p[2]),
            token: addr(&p[3]),
            feed: addr(&p[4]),
            strike: u256(&p[5]),
            settle_time: u64v(&p[6]),
            cut_bps: u64v(&p[7]) as u16,
            target: u256(&p[8]),
            name: string(&p[9]),
            symbol: string(&p[10]),
            image_uri: string(&p[11]),
            created_at: block_ts,
        },
        "Snapshot" => E::Snapshot {
            launch_id: u64v(&p[0]),
            price: u256(&p[1]),
            updated_at: u64v(&p[2]),
        },
        "Resolved" => E::Resolved {
            launch_id: u64v(&p[0]),
            outcome: u64v(&p[1]) as u8,
            pairs: u256(&p[2]),
            raised: u256(&p[3]),
        },
        "Graduating" => E::Graduating { launch_id: u64v(&p[0]) },
        "Graduated" => E::Graduated {
            launch_id: u64v(&p[0]),
            token: addr(&p[1]),
            raised: u256(&p[2]),
        },
        "LaunchFailed" => E::LaunchFailed { launch_id: u64v(&p[0]) },
        "Redeemed" => E::Redeemed {
            launch_id: u64v(&p[0]),
            user: addr(&p[1]),
            credit: u256(&p[2]),
            loser_shares: u256(&p[3]),
        },
        "TokensClaimed" => E::TokensClaimed {
            launch_id: u64v(&p[0]),
            user: addr(&p[1]),
            amount: u256(&p[2]),
        },
        "BatchSubmitted" => E::BatchSubmitted {
            batch_id: u64v(&p[0]),
            ts: u64v(&p[1]),
            fills: u64v(&p[2]),
            batch: None,
        },
        "QuestionSet" => E::QuestionSet {
            launch_id: u64v(&p[0]),
            question: string(&p[1]),
            market_id: u64v(&p[2]),
        },
        "OutcomeProposed" => E::OutcomeProposed {
            launch_id: u64v(&p[0]),
            outcome: u64v(&p[1]) as u8,
            evidence_hash: p[2].as_word().unwrap_or_default(),
            by: addr(&p[3]),
            final_: p[4].as_bool().unwrap_or(false),
            proposed_at: block_ts,
        },
        "ChallengeWindowSet" => E::ChallengeWindowSet { seconds: u64v(&p[0]) },
        _ => return None,
    })
}

// ------------------------------------------------------------------------------- RpcChain

pub struct RpcChain {
    provider: DynProvider,
    pub exchange: Address,
    pub portal: Address,
    pub operator: Address,
    /// The OpenFour rail (`FourRail`); address(0) = Flap only. Launches on it graduate through
    /// `FourRail.graduate` with the operator key's signature (the operator is `Core.signer` on our fork).
    pub four_rail: Address,
    signer: PrivateKeySigner,
    /// One operator tx at a time (batch, keeper and oracle loops share the key): the nonce is read
    /// from `latest` while holding it, so it is never ahead of the chain.
    send_lock: tokio::sync::Mutex<()>,
    /// submitBatch calldata by tx hash, persisted (`with_batch_cache`) so a restart's replay does not
    /// refetch every batch tx.
    batch_cache: Option<BatchCache>,
    /// Exchange logs, persisted (`with_log_cache`) so a restart's replay reads history from disk.
    log_cache: Option<crate::logcache::LogCache>,
}

/// Append-only `<tx hash> <calldata hex>` lines. A tx hash commits to its input, so an entry is
/// right on any chain or fork and never goes stale; a reorged-out tx is simply never asked for.
struct BatchCache {
    path: std::path::PathBuf,
    map: std::sync::Mutex<std::collections::HashMap<B256, Bytes>>,
}

impl BatchCache {
    fn load(path: std::path::PathBuf) -> anyhow::Result<Self> {
        let mut map = std::collections::HashMap::new();
        match std::fs::read_to_string(&path) {
            Ok(text) => {
                for line in text.lines() {
                    // A torn last line (crash mid-write) is skipped and refetched.
                    let mut it = line.split_whitespace();
                    if let (Some(h), Some(d), None) = (it.next(), it.next(), it.next()) {
                        if let (Ok(h), Ok(d)) = (h.parse::<B256>(), d.parse::<Bytes>()) {
                            map.insert(h, d);
                        }
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
        }
        Ok(Self {
            path,
            map: std::sync::Mutex::new(map),
        })
    }

    fn get(&self, h: &B256) -> Option<Bytes> {
        self.map.lock().unwrap().get(h).cloned()
    }

    fn put(&self, h: B256, input: Bytes) {
        use std::io::Write as _;
        let mut map = self.map.lock().unwrap();
        // Written under the lock: concurrent lookups never interleave lines.
        let res = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .and_then(|mut f| writeln!(f, "{h} {input}"));
        if let Err(e) = res {
            tracing::warn!("batch cache {}: {e}", self.path.display());
        }
        map.insert(h, input);
    }
}

/// How long a Four create signature stays valid (`CreateTokenArgs.validTimestamp`).
const FOUR_SIG_TTL: u64 = 600;

/// Fixed legacy gas price, 0.1 gwei: BSC testnet RPCs suggest less (eth_gasPrice 0.05 gwei) than validators
/// include, and such txs stay pending forever. The dev fork (base fee 0) takes it too.
const GAS_PRICE: u128 = 100_000_000;

/// How long a sent tx may take to be mined before it counts as dropped.
const RECEIPT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// Receipt poll interval (alloy's remote default is 7 s).
const RECEIPT_POLL: std::time::Duration = std::time::Duration::from_millis(500);

/// Batch tx lookups in flight at once while reading events.
const BATCH_TX_CONCURRENCY: usize = 16;

/// Max blocks per `eth_getLogs`.
const LOG_CHUNK: u64 = 2_000;

/// Consecutive failed `eth_getLogs` (each halving the range) before a poll gives up.
const LOG_RETRIES: u32 = 12;

impl RpcChain {
    pub fn new(
        rpc_url: &str,
        exchange: Address,
        portal: Address,
        operator_key: &str,
    ) -> anyhow::Result<Self> {
        let signer: PrivateKeySigner = operator_key
            .trim()
            .parse()
            .context("bad operator key")?;
        let operator = signer.address();
        let provider = ProviderBuilder::new()
            .wallet(EthereumWallet::from(signer.clone()))
            .connect_http(rpc_url.parse().context("bad rpc url")?)
            .erased();
        // alloy polls a remote RPC for receipts every 7 s by default, which delays every batch ~10 s
        // before it confirms (and a fill landing after its settleTime is skipped). BSC testnet makes a block every ~0.75 s.
        provider.client().set_poll_interval(RECEIPT_POLL);
        Ok(Self {
            provider,
            exchange,
            portal,
            operator,
            four_rail: Address::ZERO,
            signer,
            send_lock: tokio::sync::Mutex::new(()),
            batch_cache: None,
            log_cache: None,
        })
    }

    /// Keep batch calldata in `path` across restarts (see `BatchCache`).
    pub fn with_batch_cache(mut self, path: std::path::PathBuf) -> anyhow::Result<Self> {
        let cache = BatchCache::load(path)?;
        let n = cache.map.lock().unwrap().len();
        tracing::info!("batch cache {}: {n} batches", cache.path.display());
        self.batch_cache = Some(cache);
        Ok(self)
    }

    /// Keep Exchange logs in `path` across restarts (see `logcache`), for the deployment starting at `start`.
    pub fn with_log_cache(mut self, path: std::path::PathBuf, start: u64) -> anyhow::Result<Self> {
        let cache = crate::logcache::LogCache::load(path.clone(), self.exchange, start)?;
        let (n, upto) = cache.len();
        tracing::info!("log cache {}: {n} logs, up to block {upto:?}", path.display());
        self.log_cache = Some(cache);
        Ok(self)
    }

    async fn block_hash(&self, n: u64) -> anyhow::Result<B256> {
        let b = self
            .provider
            .get_block_by_number(n.into())
            .await?
            .with_context(|| format!("block {n} not found"))?;
        Ok(b.header.hash)
    }

    /// Once per run: keep the cache up to its newest mark the chain still agrees with.
    async fn verify_log_cache(&self, c: &crate::logcache::LogCache) -> anyhow::Result<()> {
        if c.is_verified() {
            return Ok(());
        }
        let marks = c.marks();
        let mut keep = None;
        for (i, m) in marks.iter().enumerate().rev() {
            if self.block_hash(m.block).await? == m.hash {
                keep = Some(i);
                break;
            }
        }
        if keep.map_or(0, |i| i + 1) != marks.len() {
            tracing::warn!("log cache: {} newest mark(s) no longer on chain, refetching from there", marks.len() - keep.map_or(0, |i| i + 1));
        }
        c.verify(keep)
    }

    /// Graduate Four launches (those whose rail is `rail`) through the OpenFour rail.
    pub fn with_four_rail(mut self, rail: Address) -> Self {
        self.four_rail = rail;
        self
    }

    /// Sign the rail's OpenFour create digest and call `FourRail.graduate`, which runs `Exchange.graduate`.
    async fn graduate_four(&self, launch: u64) -> anyhow::Result<B256> {
        let id = U256::from(launch);
        let now = self
            .provider
            .get_block_by_number(alloy::eips::BlockNumberOrTag::Latest)
            .await?
            .context("no latest block")?
            .header
            .timestamp;
        let valid = U256::from(now + FOUR_SIG_TTL);
        let digest = self
            .view(self.four_rail, IFourRail::createDigestCall { id, validTimestamp: valid })
            .await?;
        let sig = self.signer.sign_message(digest.as_slice()).await?;
        self.send_to(
            self.four_rail,
            IFourRail::graduateCall {
                id,
                validTimestamp: valid,
                sig: Bytes::from(sig.as_bytes().to_vec()),
            },
        )
        .await
    }

    /// First block where the Exchange has code (binary search), so log polling starts there.
    pub async fn deploy_block(&self) -> anyhow::Result<u64> {
        let head = self.provider.get_block_number().await?;
        let has_code = |n: u64| async move {
            self.provider
                .get_code_at(self.exchange)
                .block_id(BlockId::number(n))
                .await
                .map(|c| !c.is_empty())
                .unwrap_or(false)
        };
        anyhow::ensure!(
            has_code(head).await,
            "no contract at {} (is the Exchange deployed?)",
            self.exchange
        );
        let (mut lo, mut hi) = (0u64, head);
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            if has_code(mid).await {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        Ok(lo)
    }

    async fn view<C: SolCall>(&self, to: Address, call: C) -> anyhow::Result<C::Return> {
        let tx = TransactionRequest::default()
            .with_to(to)
            .with_input(call.abi_encode());
        let out = self.provider.call(tx).await?;
        Ok(C::abi_decode_returns(&out)?)
    }

    async fn send<C: SolCall>(&self, call: C) -> anyhow::Result<B256> {
        self.send_to(self.exchange, call).await
    }

    async fn send_to<C: SolCall>(&self, to: Address, call: C) -> anyhow::Result<B256> {
        let tx = TransactionRequest::default()
            .with_from(self.operator)
            .with_to(to)
            .with_input(call.abi_encode())
            .with_gas_price(GAS_PRICE);
        // Nothing here reads the `pending` block: some BSC testnet RPCs stamp it ~12 s in the future
        // (failing timing checks the mined tx passes) and report a pending nonce ahead of
        // the chain (txs behind a nonce gap that never mine). So nonce and gas come from `latest`,
        // set explicitly so alloy's fillers (which use `pending`) leave them alone.
        let _g = self.send_lock.lock().await;
        // The estimate doubles as the simulation: a revert comes back as an error, not a failed
        // receipt. Both reads at once: each RPC round trip is ~1 s on some testnet endpoints, and a
        // fill that lands after its market's settleTime is skipped.
        let (gas, nonce) = tokio::join!(
            self.provider
                .estimate_gas(tx.clone())
                .block(BlockId::latest())
                .into_future(),
            self.provider
                .get_transaction_count(self.operator)
                .block_id(BlockId::latest())
                .into_future()
        );
        let gas = gas.with_context(|| format!("{} would revert", C::SIGNATURE))?;
        let tx = tx.with_nonce(nonce?).with_gas_limit(gas + gas / 4);
        let pending = self.provider.send_transaction(tx).await?;
        let hash = *pending.tx_hash();
        // An RPC can accept a tx and then drop it; without a deadline the batch / keeper loop would
        // wait on its receipt forever. Timing out frees the loop to retry (the nonce is re-read).
        let receipt = tokio::time::timeout(RECEIPT_TIMEOUT, pending.get_receipt())
            .await
            .map_err(|_| {
                anyhow::anyhow!(
                    "{} tx {hash} not mined after {}s (dropped?)",
                    C::SIGNATURE,
                    RECEIPT_TIMEOUT.as_secs()
                )
            })??;
        anyhow::ensure!(
            receipt.status(),
            "{} reverted in tx {}",
            C::SIGNATURE,
            receipt.transaction_hash
        );
        Ok(receipt.transaction_hash)
    }

    async fn batch_of_tx(&self, tx: B256) -> Option<abi::Batch> {
        if let Some(input) = self.batch_cache.as_ref().and_then(|c| c.get(&tx)) {
            if let Ok(c) = IExchange::submitBatchCall::abi_decode(&input) {
                return Some(c.b);
            }
        }
        let t = self.provider.get_transaction_by_hash(tx).await.ok()??;
        let input: Bytes = t.input().clone();
        let b = IExchange::submitBatchCall::abi_decode(&input).ok().map(|c| c.b)?;
        if let Some(c) = &self.batch_cache {
            c.put(tx, input);
        }
        Some(b)
    }
}

impl Chain for RpcChain {
    async fn poll_events(&self, from: u64) -> anyhow::Result<(Vec<ChainEvent>, u64)> {
        use crate::logcache::RawLog;
        let head = self.provider.get_block_number().await?;
        let mut out = Vec::new();
        // (index in `out`, tx hash) of each BatchSubmitted: their calldata is fetched at the end.
        let mut batch_txs: Vec<(usize, B256)> = Vec::new();
        let mut from = from;
        // History already on disk first (restarts), then the RPC for the rest.
        let mut raw: Vec<RawLog> = Vec::new();
        if let Some(c) = &self.log_cache {
            self.verify_log_cache(c).await?;
            let (cached, next) = c.cached(from);
            raw = cached;
            from = from.max(next);
        }
        let fetch_from = from;
        let mut fetched: Vec<RawLog> = Vec::new();
        // Blocks per request, adaptive: the public book (OrderPosted) makes busy ranges megabytes of logs, which
        // some RPCs cut off mid-body. A failed request halves the range and retries; a good one grows it back.
        let mut span = LOG_CHUNK;
        let mut failures = 0u32;
        let proposed = <IExchange::OutcomeProposed as alloy_sol_types::SolEvent>::SIGNATURE_HASH;
        while from <= head {
            let to = head.min(from + span - 1);
            let filter = Filter::new()
                .address(self.exchange)
                .from_block(from)
                .to_block(to);
            let logs = match self.provider.get_logs(&filter).await {
                Ok(l) => l,
                Err(e) => {
                    failures += 1;
                    if failures > LOG_RETRIES {
                        return Err(e.into());
                    }
                    tracing::warn!("eth_getLogs {from}..{to} failed ({e}); retrying with {} blocks", (span / 2).max(1));
                    span = (span / 2).max(1);
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    continue;
                }
            };
            failures = 0;
            span = (span * 2).min(LOG_CHUNK);
            for log in logs {
                let topics = log.topics().to_vec();
                let mut ts = log.block_timestamp.unwrap_or(0);
                // A question proposal's challenge window runs from its block time: read the block
                // when the node leaves `blockTimestamp` out of its logs.
                if ts == 0 && topics.first() == Some(&proposed) {
                    if let Some(n) = log.block_number {
                        if let Ok(Some(b)) = self.provider.get_block_by_number(n.into()).await {
                            ts = b.header.timestamp;
                        }
                    }
                }
                fetched.push(RawLog {
                    block: log.block_number.unwrap_or(to),
                    tx: log.transaction_hash,
                    ts,
                    data: log.data().data.clone(),
                    topics,
                });
            }
            from = to + 1;
        }
        if let Some(c) = &self.log_cache {
            let confirmed = match c.mark_due(head) {
                Some(b) => self.block_hash(b).await.ok().map(|h| (b, h)),
                None => None,
            };
            c.record(fetch_from, from.saturating_sub(1), fetched.clone(), confirmed);
        }
        raw.extend(fetched);
        for log in raw {
            let RawLog { tx, ts, topics, data, .. } = log;
            match decode_log(&topics, &data, ts) {
                Some(ChainEvent::BatchSubmitted {
                    batch_id,
                    ts,
                    fills,
                    ..
                }) => {
                    if let Some(h) = tx {
                        batch_txs.push((out.len(), h));
                    }
                    out.push(ChainEvent::BatchSubmitted {
                        batch_id,
                        ts,
                        fills,
                        batch: None,
                    });
                }
                Some(e) => out.push(e),
                None => {
                    let known = event_topics().iter().any(|(t, _)| Some(t) == topics.first());
                    if known {
                        tracing::warn!("could not decode an Exchange log {:?}", topics.first());
                    }
                }
            }
        }
        // One tx lookup per batch, concurrently (and from the cache when it has them): on startup the
        // replay covers every batch since the deployment, and one at a time (~1 s each on some
        // testnet RPCs) outgrew the startup wait.
        use futures_util::StreamExt;
        let fetched: Vec<(usize, Option<abi::Batch>)> = futures_util::stream::iter(batch_txs)
            .map(|(i, h)| async move { (i, self.batch_of_tx(h).await) })
            .buffer_unordered(BATCH_TX_CONCURRENCY)
            .collect()
            .await;
        for (i, b) in fetched {
            if let ChainEvent::BatchSubmitted { batch, .. } = &mut out[i] {
                *batch = b;
            }
        }
        Ok((out, from))
    }

    async fn simulate_batch(&self, _b: &abi::Batch) -> anyhow::Result<()> {
        // `submit_batch` simulates through its gas estimate (at `latest`, see `send_to`); a separate
        // call here would only add an RPC round trip to the batch's age.
        Ok(())
    }

    async fn submit_batch(&self, b: &abi::Batch) -> anyhow::Result<B256> {
        self.send(IExchange::submitBatchCall { b: b.clone() }).await
    }

    async fn read_funds(&self, users: Vec<Address>, block: u64) -> anyhow::Result<Option<Vec<U256>>> {
        let n = users.len();
        let call = IExchange::fundsCall { users };
        let tx = TransactionRequest::default()
            .with_to(self.exchange)
            .with_input(call.abi_encode());
        let out = self.provider.call(tx).block(BlockId::number(block)).await?;
        let v = IExchange::fundsCall::abi_decode_returns(&out)?;
        anyhow::ensure!(v.len() == n, "funds() returned {} values for {n} users", v.len());
        Ok(Some(v))
    }

    async fn snapshot(&self, launch: u64) -> anyhow::Result<B256> {
        self.send(IExchange::snapshotCall {
            launchId: U256::from(launch),
        })
        .await
    }

    async fn resolve(&self, launch: u64) -> anyhow::Result<B256> {
        self.send(IExchange::resolveCall {
            launchId: U256::from(launch),
        })
        .await
    }

    async fn redeem(&self, launch: u64, users: Vec<Address>) -> anyhow::Result<B256> {
        self.send(IExchange::redeemCall {
            launchId: U256::from(launch),
            users,
        })
        .await
    }

    async fn graduate(&self, launch: u64) -> anyhow::Result<B256> {
        if !self.four_rail.is_zero() {
            let l = self
                .view(self.exchange, IExchange::getLaunchCall { id: U256::from(launch) })
                .await?;
            if l.rail == self.four_rail {
                return self.graduate_four(launch).await;
            }
        }
        self.send(IExchange::graduateCall {
            launchId: U256::from(launch),
        })
        .await
    }

    async fn propose_outcome(
        &self,
        launch: u64,
        outcome: u8,
        evidence_hash: B256,
    ) -> anyhow::Result<B256> {
        self.send(IExchange::proposeOutcomeCall {
            id: U256::from(launch),
            outcome,
            evidenceHash: evidence_hash,
        })
        .await
    }

    async fn read_feed(&self, feed: Address) -> anyhow::Result<(U256, u64)> {
        let r = self.view(feed, IAggregator::latestRoundDataCall {}).await?;
        Ok((r.answer.into_raw(), r.updatedAt.saturating_to()))
    }

    async fn set_balance(&self, who: Address, amount: U256) -> anyhow::Result<()> {
        let _: serde_json::Value = self
            .provider
            .raw_request("anvil_setBalance".into(), (who, amount))
            .await?;
        Ok(())
    }

    async fn mint_quote(&self, quote: Address, who: Address, amount: U256) -> anyhow::Result<()> {
        self.send_to(quote, IQuoteToken::mintCall { to: who, amount })
            .await?;
        Ok(())
    }

    async fn info(&self) -> anyhow::Result<ChainInfo> {
        let chain_id = self.provider.get_chain_id().await?;
        let salt_lock_fee = self
            .view(self.portal, IPortal::SALT_LOCK_FEECall {})
            .await
            .unwrap_or(U256::from(5_000_000_000_000_000u64));
        let min_target = self
            .view(self.exchange, IExchange::minTargetCall {})
            .await
            .unwrap_or(U256::from(2_150_000_000_000_000_000u64));
        // Exchanges deployed before the quote token existed have no `quoteToken()`: native.
        let quote_token = self
            .view(self.exchange, IExchange::quoteTokenCall {})
            .await
            .unwrap_or(Address::ZERO);
        let quote_symbol = if quote_token.is_zero() {
            "BNB".to_string()
        } else {
            self.view(quote_token, IQuoteToken::symbolCall {})
                .await
                .context("reading the quote token's symbol")?
        };
        // Exchanges deployed before question launches have neither view.
        let challenge_window = self
            .view(self.exchange, IExchange::challengeWindowCall {})
            .await
            .unwrap_or(predictlaunch_core::DEFAULT_CHALLENGE_WINDOW);
        let resolver = self
            .view(self.exchange, IExchange::resolverCall {})
            .await
            .unwrap_or(Address::ZERO);
        Ok(ChainInfo {
            chain_id,
            salt_lock_fee,
            min_target,
            quote_token,
            quote_symbol,
            challenge_window,
            resolver,
            operator: self.operator,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_sol_types::SolEvent;

    #[test]
    fn signatures_match_sol_bindings() {
        let t = event_topics();
        let get = |n: &str| t.iter().find(|(_, m)| *m == n).unwrap().0;
        assert_eq!(get("LaunchCreated"), IExchange::LaunchCreated::SIGNATURE_HASH);
        assert_eq!(get("Redeemed"), IExchange::Redeemed::SIGNATURE_HASH);
        assert_eq!(get("BatchSubmitted"), IExchange::BatchSubmitted::SIGNATURE_HASH);
        assert_eq!(get("WithdrawPaid"), IExchange::WithdrawPaid::SIGNATURE_HASH);
        assert_eq!(get("FillSkipped"), IExchange::FillSkipped::SIGNATURE_HASH);
        assert_eq!(get("QuestionSet"), IExchange::QuestionSet::SIGNATURE_HASH);
        assert_eq!(get("OutcomeProposed"), IExchange::OutcomeProposed::SIGNATURE_HASH);
        assert_eq!(get("ChallengeWindowSet"), IExchange::ChallengeWindowSet::SIGNATURE_HASH);
    }

    #[test]
    fn decodes_question_events() {
        let ev = IExchange::QuestionSet {
            launchId: U256::from(4u64),
            question: "Will it rain in Boston tomorrow?".into(),
            marketId: U256::from(2849008u64),
        };
        let e = decode_log(&[IExchange::QuestionSet::SIGNATURE_HASH], &ev.encode_data(), 9).unwrap();
        assert_eq!(
            e,
            ChainEvent::QuestionSet {
                launch_id: 4,
                question: "Will it rain in Boston tomorrow?".into(),
                market_id: 2849008,
            }
        );
        // launchId indexed, the rest in data.
        let by = Address::repeat_byte(0x99);
        let h = B256::repeat_byte(0xAB);
        let data = DynSolValue::Tuple(vec![
            DynSolValue::Uint(U256::from(1u64), 8),
            DynSolValue::FixedBytes(h, 32),
            DynSolValue::Address(by),
            DynSolValue::Bool(true),
        ])
        .abi_encode_params();
        let e = decode_log(
            &[IExchange::OutcomeProposed::SIGNATURE_HASH, B256::from(U256::from(4u64))],
            &data,
            1234,
        )
        .unwrap();
        assert_eq!(
            e,
            ChainEvent::OutcomeProposed {
                launch_id: 4,
                outcome: 1,
                evidence_hash: h,
                by,
                final_: true,
                proposed_at: 1234,
            }
        );
        let ev = IExchange::ChallengeWindowSet { seconds_: 120 };
        let e = decode_log(&[IExchange::ChallengeWindowSet::SIGNATURE_HASH], &ev.encode_data(), 0);
        assert_eq!(e, Some(ChainEvent::ChallengeWindowSet { seconds: 120 }));
    }

    #[test]
    fn decodes_any_indexing() {
        let user = Address::repeat_byte(0x11);
        let sig = keccak256(b"WithdrawRequested(uint64,address,uint256)");
        // idx and user indexed.
        let topics = vec![
            sig,
            B256::from(U256::from(7u64)),
            user.into_word(),
        ];
        let data = U256::from(5u64).to_be_bytes::<32>().to_vec();
        let e = decode_log(&topics, &data, 0).unwrap();
        assert_eq!(
            e,
            ChainEvent::WithdrawRequested { idx: 7, user, amount: U256::from(5u64) }
        );
        // Only user indexed.
        let topics = vec![sig, user.into_word()];
        let mut data = U256::from(7u64).to_be_bytes::<32>().to_vec();
        data.extend(U256::from(5u64).to_be_bytes::<32>());
        let e2 = decode_log(&topics, &data, 0).unwrap();
        assert_eq!(e, e2);
        // Nothing indexed, with strings.
        let ev = IExchange::LaunchCreated {
            launchId: U256::from(3u64),
            creator: user,
            rail: Address::repeat_byte(2),
            token: Address::repeat_byte(3),
            feed: Address::repeat_byte(4),
            strike: U256::from(10u64),
            settleTime: 99,
            cutBps: 1000,
            target: U256::from(1u64),
            name: "Moon".into(),
            symbol: "MOON".into(),
            imageURI: "ipfs://x".into(),
        };
        let data = ev.encode_data();
        let e = decode_log(&[IExchange::LaunchCreated::SIGNATURE_HASH], &data, 5).unwrap();
        match e {
            ChainEvent::LaunchCreated { launch_id, name, settle_time, created_at, .. } => {
                assert_eq!((launch_id, name.as_str(), settle_time, created_at), (3, "Moon", 99, 5));
            }
            _ => panic!(),
        }
        // launchId + creator indexed.
        let mut data2 = Vec::new();
        let rest = DynSolValue::Tuple(vec![
            DynSolValue::Address(Address::repeat_byte(2)),
            DynSolValue::Address(Address::repeat_byte(3)),
            DynSolValue::Address(Address::repeat_byte(4)),
            DynSolValue::Uint(U256::from(10u64), 256),
            DynSolValue::Uint(U256::from(99u64), 64),
            DynSolValue::Uint(U256::from(1000u64), 16),
            DynSolValue::Uint(U256::from(1u64), 256),
            DynSolValue::String("Moon".into()),
            DynSolValue::String("MOON".into()),
            DynSolValue::String("ipfs://x".into()),
        ]);
        data2.extend(rest.abi_encode_params());
        let e = decode_log(
            &[
                IExchange::LaunchCreated::SIGNATURE_HASH,
                B256::from(U256::from(3u64)),
                user.into_word(),
            ],
            &data2,
            5,
        )
        .unwrap();
        assert!(matches!(e, ChainEvent::LaunchCreated { launch_id: 3, cut_bps: 1000, .. }));
    }
}
