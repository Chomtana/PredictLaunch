//! The keeper schedule (pure): what to send to the chain at `now`.
//!
//! Per launch: `snapshot` from the first block ≥ settleTime (retried until settleTime + GRACE),
//! `resolve` once `now ≥ settleTime + MAX_LAG` and (snapped or past the grace window), then
//! `redeem` every holder (chunks of `REDEEM_CHUNK`), then `graduate` while Graduating.
//! Withdrawals ride in batches (`State::cut` sets `withdrawTo` = queue length).
//!
//! Question launches (feed = 0) are never snapshotted. They resolve once `now ≥ settleTime + MAX_LAG`
//! and one of: the proposal is final (owner override); a proposal's challenge window has passed; or
//! no proposal by `settleTime + QUESTION_DEADLINE` (void). The resolver's `Propose` actions come from
//! `crate::oracle` (it needs the Cournot evidence); `proposals_due` and `decide` are its pure rules.

use alloy_primitives::{Address, B256};
use predictlaunch_core::state::{Launch, LaunchStatus, State};
use predictlaunch_core::{GRACE, MAX_LAG, QUESTION_DEADLINE, REDEEM_CHUNK};

/// Resolver thresholds on the YES probability (SPEC: ≥ 0.97 → YES, ≤ 0.03 → NO).
pub const YES_THRESHOLD: f64 = 0.97;
pub const NO_THRESHOLD: f64 = 0.03;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum KeeperAction {
    Snapshot(u64),
    Resolve(u64),
    Redeem(u64, Vec<Address>),
    Graduate(u64),
    /// `proposeOutcome(launch, outcome, evidenceHash)` (resolver).
    Propose(u64, u8, B256),
}

impl KeeperAction {
    pub fn launch(&self) -> u64 {
        match self {
            Self::Snapshot(l)
            | Self::Resolve(l)
            | Self::Redeem(l, _)
            | Self::Graduate(l)
            | Self::Propose(l, _, _) => *l,
        }
    }
}

/// SPEC `resolve` rule for a question launch (before `MAX_LAG` is checked).
fn question_resolvable(l: &Launch, challenge_window: u64, now: u64) -> bool {
    match &l.proposal {
        Some(p) if p.final_ => true,
        Some(p) => now >= p.proposed_at.saturating_add(challenge_window),
        None => now > l.settle_time.saturating_add(QUESTION_DEADLINE),
    }
}

pub fn keeper_actions(state: &State, now: u64) -> Vec<KeeperAction> {
    let mut out = Vec::new();
    for (id, l) in &state.launches {
        let t = l.settle_time;
        if !l.resolved {
            if l.is_question() {
                if now >= t + MAX_LAG && question_resolvable(l, state.challenge_window, now) {
                    out.push(KeeperAction::Resolve(*id));
                }
                continue;
            }
            if !l.snapped && now >= t && now <= t + GRACE {
                out.push(KeeperAction::Snapshot(*id));
            }
            if now >= t + MAX_LAG && (l.snapped || now > t + GRACE) {
                out.push(KeeperAction::Resolve(*id));
            }
            continue;
        }
        let holders = state.holders(*id);
        for chunk in holders.chunks(REDEEM_CHUNK) {
            out.push(KeeperAction::Redeem(*id, chunk.to_vec()));
        }
        if l.status == LaunchStatus::Graduating {
            out.push(KeeperAction::Graduate(*id));
        }
    }
    out
}

/// Question launches the resolver should try to settle now: unresolved, unproposed, and
/// `now ≥ settleTime + MAX_LAG` (the contract's `proposeOutcome` rule).
pub fn proposals_due(state: &State, now: u64) -> Vec<u64> {
    state
        .launches
        .values()
        .filter(|l| {
            l.is_question() && !l.resolved && l.proposal.is_none() && now >= l.settle_time + MAX_LAG
        })
        .map(|l| l.id)
        .collect()
}

/// The resolver's decision from a YES probability: `Some(0)` YES, `Some(1)` NO, `None` undecided.
pub fn decide(p: f64) -> Option<u8> {
    if p >= YES_THRESHOLD {
        Some(0)
    } else if p <= NO_THRESHOLD {
        Some(1)
    } else {
        None
    }
}
