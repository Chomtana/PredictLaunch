//! The keeper schedule (pure): what to send to the chain at `now`.
//!
//! Per launch: `snapshot` from the first block ≥ settleTime (retried until settleTime + GRACE),
//! `resolve` once `now ≥ settleTime + MAX_LAG` and (snapped or past the grace window), then
//! `redeem` every holder (chunks of `REDEEM_CHUNK`), then `graduate` while Graduating.
//! Withdrawals ride in batches (`State::cut` sets `withdrawTo` = queue length).

use alloy_primitives::Address;
use bilauncher_core::state::{LaunchStatus, State};
use bilauncher_core::{GRACE, MAX_LAG, REDEEM_CHUNK};

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum KeeperAction {
    Snapshot(u64),
    Resolve(u64),
    Redeem(u64, Vec<Address>),
    Graduate(u64),
}

impl KeeperAction {
    pub fn launch(&self) -> u64 {
        match self {
            Self::Snapshot(l) | Self::Resolve(l) | Self::Redeem(l, _) | Self::Graduate(l) => *l,
        }
    }
}

pub fn keeper_actions(state: &State, now: u64) -> Vec<KeeperAction> {
    let mut out = Vec::new();
    for (id, l) in &state.launches {
        let t = l.settle_time;
        if !l.resolved {
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
