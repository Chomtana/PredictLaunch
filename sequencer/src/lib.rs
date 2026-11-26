//! # predictlaunch-sequencer
//!
//! Matches signed orders instantly (soft confirmation, `predictlaunch_core::state`), cuts batches and
//! submits them to `Exchange` with the operator key, runs the keeper (snapshot, resolve, redeem,
//! graduate), streams feed prices, and serves the HTTP/WS API of SPEC.md.

pub mod api;
pub mod app;
pub mod chain;
pub mod cournot;
pub mod keeper;
pub mod oracle;
pub mod prices;
pub mod testutil;
pub mod views;
