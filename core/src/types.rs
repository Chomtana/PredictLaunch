//! SPEC types and constants.

use alloy_primitives::{address, Address, U256};
use serde::{Deserialize, Serialize};

/// Share amounts must be multiples of this (SPEC "Constants").
pub const SHARE_UNIT: u128 = 10_000_000_000_000_000; // 1e16
pub const SNAP_TOLERANCE: u64 = 5;
pub const GRACE: u64 = 60;
pub const MAX_LAG: u64 = 15;
pub const FORCE_DELAY: u64 = 600;
pub const MIN_DURATION: u64 = 300;
pub const MAX_DURATION: u64 = 30 * 86_400;
pub const CUTS: [u16; 5] = [1000, 1500, 2000, 2500, 3000];
pub const LOSER_SUPPLY: u128 = 500_000_000 * 10u128.pow(18);
/// Fills per batch cap (gas).
pub const MAX_BATCH_FILLS: usize = 200;
/// Users per `redeem` call.
pub const REDEEM_CHUNK: usize = 50;
/// Max messages per atomic group.
pub const MAX_GROUP: usize = 16;
pub const ONE_BNB: u128 = 10u128.pow(18);

pub const PORTAL: Address = address!("000042108465206185A077Edc3F3fd2b49060000");
/// Atlas BNB/USD (BSC testnet): always streamed for the USD estimate.
pub const BNB_USD_FEED: Address = address!("b3d1614bf894e68add1ea50ca250c152bad5256f");

/// The spec's feed table (BSC testnet Atlas SingleFeeds). FDUSD and VAI are excluded.
pub const FEEDS: [(&str, Address); 18] = [
    ("BTCB/USD", address!("e20536bc715aac6560394e33deb66ed205aeec33")),
    ("BNB/USD", address!("b3d1614bf894e68add1ea50ca250c152bad5256f")),
    ("ANKR/USD", address!("ed2ce62b7bfdd31876b1e956a672e8fbe8b29403")),
    ("CAKE/USD", address!("060d5be909a3f775ddc239d982e4fe46879bce4a")),
    ("ASTER/USD", address!("ee9483fd2d380384d42326143f4bc9bd0513234d")),
    ("WLFI/USD", address!("6eba8b28f2411ab14f7ecdc3a2477ad436acbd21")),
    ("B/USD", address!("2bcdfbc731fd179c70794854a4260774369c8d27")),
    ("B2/USD", address!("d6cf91a4d545462821a43997a6df104c5068d71d")),
    ("AT/USD", address!("8b8678dc64b7539a59e68e25d10cb2846f0918fe")),
    ("TAKE/USD", address!("61e4be67372e5dff1b8539cc5441b170ede68a48")),
    ("EGL1/USD", address!("e659636dbe70e9a53f7762d9eef385a4fa528475")),
    ("PUFFER/USD", address!("2bc9c150981d74e24b85c3d714852631928599b4")),
    ("CDL/USD", address!("5036f6f0b618b5eb12452b9fc782c8d2e5e996c9")),
    ("AB/USD", address!("ff45b658838fb3afa2d00cca5033258c262f98de")),
    ("SPA/USD", address!("9a97167364dd00f8bc52e346ccb8d603e0b9a740")),
    ("OIK/USD", address!("fe9a5337da82a0fc8476c2a1edc292d729d29f71")),
    ("USDT/USD", address!("9dfd7992952bb9e8fb4bc6065fdc3518addc4e8b")),
    ("BUSD/USD", address!("14a20eafffada4d78afeef1185e7317cf98f6a1f")),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Outcome {
    Up,
    Down,
}

impl Outcome {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::Up),
            1 => Some(Self::Down),
            _ => None,
        }
    }
    pub fn as_u8(self) -> u8 {
        self as u8
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Side {
    Buy,
    Sell,
}

impl Side {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::Buy),
            1 => Some(Self::Sell),
            _ => None,
        }
    }
    pub fn as_u8(self) -> u8 {
        self as u8
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum FillKind {
    Transfer,
    Mint,
    Merge,
}

impl FillKind {
    pub fn as_u8(self) -> u8 {
        self as u8
    }
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::Transfer),
            1 => Some(Self::Mint),
            2 => Some(Self::Merge),
            _ => None,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Transfer => "transfer",
            Self::Mint => "mint",
            Self::Merge => "merge",
        }
    }
    /// Fill kind from the two real orders: same outcome → Transfer; both Buy → Mint; both Sell →
    /// Merge. `None` = they cannot trade (same outcome, same side).
    pub fn of(a: (Outcome, Side), b: (Outcome, Side)) -> Option<Self> {
        if a.0 == b.0 {
            (a.1 != b.1).then_some(Self::Transfer)
        } else if a.1 != b.1 {
            None
        } else if a.1 == Side::Buy {
            Some(Self::Mint)
        } else {
            Some(Self::Merge)
        }
    }
}

/// SPEC `Order` (EIP-712). `round` must be 0 (Amendment A1).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Order {
    pub owner: Address,
    pub launch_id: U256,
    pub round: u32,
    pub outcome: Outcome,
    pub side: Side,
    pub price: u8,
    pub amount: u128,
    pub expiry: u64,
    pub nonce: u64,
}

impl Order {
    /// Launch id as a map key (launch ids are small sequential numbers).
    pub fn launch(&self) -> u64 {
        self.launch_id.saturating_to()
    }
    /// Up-terms side: Buy Up / Sell Down are bids.
    pub fn is_bid(&self) -> bool {
        matches!(
            (self.outcome, self.side),
            (Outcome::Up, Side::Buy) | (Outcome::Down, Side::Sell)
        )
    }
    /// Up-terms price: Up @p → p; Down @p → 100 − p.
    pub fn up_price(&self) -> u8 {
        match self.outcome {
            Outcome::Up => self.price,
            Outcome::Down => 100 - self.price,
        }
    }
}

/// `amount × price / 100`, exact for multiples of `SHARE_UNIT`.
pub fn cost(amount: u128, price: u8) -> U256 {
    U256::from(amount) * U256::from(price) / U256::from(100u8)
}

/// Rejection codes (SPEC "Error codes"), plus `bad_request` for malformed input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorCode {
    BadSignature,
    BadAmount,
    BadPrice,
    NotTradable,
    InsufficientBalance,
    InsufficientShares,
    UnknownOrder,
    Expired,
    KeyExpired,
    GroupTooLarge,
    BadRequest,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BadSignature => "bad_signature",
            Self::BadAmount => "bad_amount",
            Self::BadPrice => "bad_price",
            Self::NotTradable => "not_tradable",
            Self::InsufficientBalance => "insufficient_balance",
            Self::InsufficientShares => "insufficient_shares",
            Self::UnknownOrder => "unknown_order",
            Self::Expired => "expired",
            Self::KeyExpired => "key_expired",
            Self::GroupTooLarge => "group_too_large",
            Self::BadRequest => "bad_request",
        }
    }
}

impl std::fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}
