//! # bilauncher-core
//!
//! Pure logic shared by the sequencer (and its tests): SPEC types, `sol!` ABI bindings, EIP-712
//! hashing, the per-launch order book, the state mirror of `Exchange`, and the batcher.
//! No I/O here: the contract is the validator, and this crate mirrors its rules so batches never
//! revert.

pub mod abi;
pub mod batcher;
pub mod book;
pub mod eip712;
pub mod state;
pub mod types;

pub use eip712::{order_hash, recover, Domain};
pub use types::*;
