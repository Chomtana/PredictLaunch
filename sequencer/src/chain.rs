//! What the sequencer needs from the chain. `RpcChain` talks to a node through alloy with the
//! operator key; tests use `testutil::FakeChain`.
//!
//! Events are decoded by signature with `alloy-dyn-abi`, because SPEC does not fix which event
//! parameters are `indexed`: for each log, the decoder tries the leading parameters as the indexed
//! ones first, then every other choice, and keeps the first layout that re-encodes to exactly the
//! log's data. `BatchSubmitted` logs are completed with the decoded `submitBatch` calldata of their
//! transaction, so the mirror can be rebuilt from the chain alone.

use std::future::Future;

use alloy::consensus::Transaction as _;
use alloy::dyn_abi::{DynSolType, DynSolValue};
use alloy::eips::BlockId;
use alloy::network::{EthereumWallet, TransactionBuilder};
use alloy::providers::{DynProvider, Provider, ProviderBuilder};
use alloy::rpc::types::{Filter, TransactionRequest};
use alloy::signers::local::PrivateKeySigner;
use alloy_primitives::{keccak256, Address, Bytes, B256, U256};
use alloy_sol_types::SolCall;
use anyhow::Context;
use bilauncher_core::abi::{self, IAggregator, IExchange, IPortal, IQuoteToken};
use bilauncher_core::state::ChainEvent;

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
}

/// Max blocks per `eth_getLogs`.
const LOG_CHUNK: u64 = 2_000;

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
            .wallet(EthereumWallet::from(signer))
            .connect_http(rpc_url.parse().context("bad rpc url")?)
            .erased();
        Ok(Self {
            provider,
            exchange,
            portal,
            operator,
        })
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
            .with_input(call.abi_encode());
        // Simulate first so a revert comes back as an error instead of a failed receipt.
        self.provider
            .call(tx.clone())
            .block(BlockId::pending())
            .await
            .with_context(|| format!("{} would revert", C::SIGNATURE))?;
        let receipt = self
            .provider
            .send_transaction(tx)
            .await?
            .get_receipt()
            .await?;
        anyhow::ensure!(
            receipt.status(),
            "{} reverted in tx {}",
            C::SIGNATURE,
            receipt.transaction_hash
        );
        Ok(receipt.transaction_hash)
    }

    async fn batch_of_tx(&self, tx: B256) -> Option<abi::Batch> {
        let t = self.provider.get_transaction_by_hash(tx).await.ok()??;
        let input: Bytes = t.input().clone();
        IExchange::submitBatchCall::abi_decode(&input).ok().map(|c| c.b)
    }
}

impl Chain for RpcChain {
    async fn poll_events(&self, from: u64) -> anyhow::Result<(Vec<ChainEvent>, u64)> {
        let head = self.provider.get_block_number().await?;
        let mut out = Vec::new();
        let mut from = from;
        while from <= head {
            let to = head.min(from + LOG_CHUNK - 1);
            let filter = Filter::new()
                .address(self.exchange)
                .from_block(from)
                .to_block(to);
            let logs = self.provider.get_logs(&filter).await?;
            for log in logs {
                let topics = log.topics().to_vec();
                let data = log.data().data.clone();
                let mut ts = log.block_timestamp.unwrap_or(0);
                // A question proposal's challenge window runs from its block time: read the block
                // when the node leaves `blockTimestamp` out of its logs.
                let proposed =
                    <IExchange::OutcomeProposed as alloy_sol_types::SolEvent>::SIGNATURE_HASH;
                if ts == 0 && topics.first() == Some(&proposed) {
                    if let Some(n) = log.block_number {
                        if let Ok(Some(b)) = self.provider.get_block_by_number(n.into()).await {
                            ts = b.header.timestamp;
                        }
                    }
                }
                match decode_log(&topics, &data, ts) {
                    Some(ChainEvent::BatchSubmitted {
                        batch_id,
                        ts,
                        fills,
                        ..
                    }) => {
                        let batch = match log.transaction_hash {
                            Some(h) => self.batch_of_tx(h).await,
                            None => None,
                        };
                        out.push(ChainEvent::BatchSubmitted {
                            batch_id,
                            ts,
                            fills,
                            batch,
                        });
                    }
                    Some(e) => out.push(e),
                    None => {
                        let known = event_topics()
                            .iter()
                            .any(|(t, _)| Some(t) == topics.first());
                        if known {
                            tracing::warn!("could not decode an Exchange log {:?}", topics.first());
                        }
                    }
                }
            }
            from = to + 1;
        }
        Ok((out, from))
    }

    async fn simulate_batch(&self, b: &abi::Batch) -> anyhow::Result<()> {
        let call = IExchange::submitBatchCall { b: b.clone() };
        let tx = TransactionRequest::default()
            .with_from(self.operator)
            .with_to(self.exchange)
            .with_input(call.abi_encode());
        self.provider
            .call(tx)
            .block(BlockId::pending())
            .await
            .context("submitBatch would revert")?;
        Ok(())
    }

    async fn submit_batch(&self, b: &abi::Batch) -> anyhow::Result<B256> {
        self.send(IExchange::submitBatchCall { b: b.clone() }).await
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
            .unwrap_or(bilauncher_core::DEFAULT_CHALLENGE_WINDOW);
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
