//! Pending batches (open → sealed → sent) and their ABI form.
//!
//! Rules (Review Focus 1): a batch's `ts` is the time of its first message (sequencer-side only; the
//! contract checks everything at `block.timestamp`); a fill joins the open batch only if
//! `batch.ts < settleTime` of its launch; the open batch is sealed when the batch timer fires
//! (`batch_ms`, capped at `MAX_OPEN_MS`), at any settleTime of a launch it holds fills for, or when it
//! reaches `MAX_BATCH_FILLS`. A fill that lands after its settleTime is skipped on chain (`FillSkipped`).

use std::collections::HashMap;

use alloy_primitives::{Address, Bytes, B256};

use crate::abi;
use crate::types::FillKind;

/// The open batch is sealed at the latest this long after its first message.
pub const MAX_OPEN_MS: u64 = 8_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FillRec {
    pub id: u64,
    pub launch: u64,
    pub taker: B256,
    pub maker: B256,
    pub kind: FillKind,
    pub maker_price: u8,
    pub amount: u128,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyRec {
    pub owner: Address,
    pub key: Address,
    pub expiry: u64,
    pub nonce: u64,
    pub sig: Vec<u8>,
}

/// A signed offchain cancel, carried onchain in the batch (after its fills).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CancelRec {
    pub order_hash: B256,
    pub nonce: u64,
    pub sig: Vec<u8>,
    /// Recovered signer: the owner or one of its trading keys.
    pub signer: Address,
}

#[derive(Clone, Debug)]
pub struct PendingBatch {
    /// Batch timestamp (seconds): time of its first message.
    pub ts: u64,
    pub opened_ms: u64,
    pub fills: Vec<FillRec>,
    pub keys: Vec<KeyRec>,
    pub cancels: Vec<CancelRec>,
    /// Resting orders published to the onchain book (`OrderPosted`); chosen when the batch is sent.
    pub posts: Vec<B256>,
    pub withdraw_to: u64,
    /// Earliest settleTime among the launches it holds fills for.
    pub min_settle: u64,
    pub sealed: bool,
    /// Set once handed to the chain (in flight). Its content no longer changes.
    pub sent: Option<abi::Batch>,
}

impl PendingBatch {
    pub fn new(now_ms: u64) -> Self {
        PendingBatch {
            ts: now_ms / 1000,
            opened_ms: now_ms,
            fills: Vec::new(),
            keys: Vec::new(),
            cancels: Vec::new(),
            posts: Vec::new(),
            withdraw_to: 0,
            min_settle: u64::MAX,
            sealed: false,
            sent: None,
        }
    }

    /// Upper bound of the batch's calldata before posts (see `MAX_BATCH_BYTES`).
    pub fn approx_bytes(&self) -> usize {
        use crate::types::{CANCEL_BYTES, FILL_BYTES, KEY_BYTES};
        1024 + self.fills.len() * FILL_BYTES + self.cancels.len() * CANCEL_BYTES + self.keys.len() * KEY_BYTES
    }

    pub fn is_empty(&self) -> bool {
        self.fills.is_empty() && self.keys.is_empty() && self.cancels.is_empty()
    }

    /// Due for sealing at `now_ms`?
    pub fn due(&self, now_ms: u64, batch_ms: u64) -> bool {
        now_ms >= self.opened_ms + batch_ms.min(MAX_OPEN_MS)
            || now_ms / 1000 >= self.min_settle
            || self.fills.len() >= crate::types::MAX_BATCH_FILLS
            || self.cancels.len() >= crate::types::MAX_BATCH_FILLS
            || self.approx_bytes() >= crate::types::MAX_BATCH_BYTES
    }
}

/// Signed order data the batch needs to reference.
pub struct OrderData<'a> {
    pub order: &'a crate::types::Order,
    pub sig: &'a [u8],
}

/// Build the ABI `Batch`: orders deduplicated in first-use order, fills index into them.
pub fn to_abi<'a>(
    b: &PendingBatch,
    lookup: impl Fn(&B256) -> OrderData<'a>,
) -> abi::Batch {
    let mut orders: Vec<abi::SignedOrder> = Vec::new();
    let mut idx: HashMap<B256, u16> = HashMap::new();
    let mut index_of = |h: &B256, orders: &mut Vec<abi::SignedOrder>| -> u16 {
        *idx.entry(*h).or_insert_with(|| {
            let d = lookup(h);
            orders.push(abi::SignedOrder {
                order: d.order.into(),
                sig: Bytes::copy_from_slice(d.sig),
            });
            (orders.len() - 1) as u16
        })
    };
    let fills = b
        .fills
        .iter()
        .map(|f| abi::Fill {
            taker: index_of(&f.taker, &mut orders),
            maker: index_of(&f.maker, &mut orders),
            kind: f.kind.as_u8(),
            amount: f.amount,
        })
        .collect();
    let posts = b
        .posts
        .iter()
        .map(|h| index_of(h, &mut orders))
        .collect();
    abi::Batch {
        keys: b
            .keys
            .iter()
            .map(|k| abi::KeyAuth {
                owner: k.owner,
                key: k.key,
                expiry: k.expiry,
                nonce: k.nonce,
                sig: Bytes::copy_from_slice(&k.sig),
            })
            .collect(),
        orders,
        posts,
        fills,
        cancels: b
            .cancels
            .iter()
            .map(|c| abi::SignedCancel {
                order: lookup(&c.order_hash).order.into(),
                nonce: c.nonce,
                sig: Bytes::copy_from_slice(&c.sig),
            })
            .collect(),
        withdrawTo: b.withdraw_to,
    }
}
