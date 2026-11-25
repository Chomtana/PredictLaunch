//! # bilauncher-sequencer
//!
//! Matches signed orders instantly (soft confirmation, `bilauncher_core::state`), cuts batches and
//! submits them to `Exchange` with the operator key, runs the keeper (snapshot, resolve, redeem,
//! graduate), streams feed prices, and serves the HTTP/WS API of SPEC.md.

pub mod api;
pub mod app;
pub mod chain;
pub mod keeper;
pub mod testutil;
pub mod views;
