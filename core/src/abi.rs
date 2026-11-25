//! `sol!` bindings for every SPEC struct, function and event of `Exchange`, plus the feed and
//! Portal views the sequencer reads.
//!
//! Event parameters are declared without `indexed`: SPEC does not say which ones are indexed, so
//! the sequencer decodes logs by signature with `alloy-dyn-abi` (see `sequencer/src/chain.rs`).
//! The signatures (topic0) do not depend on indexing.

alloy_sol_types::sol! {
    #[derive(Debug, PartialEq, Eq)]
    struct Order {
        address owner;
        uint256 launchId;
        uint32 round;
        uint8 outcome;
        uint8 side;
        uint8 price;
        uint128 amount;
        uint64 expiry;
        uint64 nonce;
    }

    #[derive(Debug, PartialEq, Eq)]
    struct AuthorizeKey {
        address owner;
        address key;
        uint64 expiry;
        uint64 nonce;
    }

    #[derive(Debug, PartialEq, Eq)]
    struct Cancel {
        address owner;
        bytes32 orderHash;
        uint64 nonce;
    }

    #[derive(Debug, PartialEq, Eq)]
    struct SignedOrder { Order order; bytes sig; }
    #[derive(Debug, PartialEq, Eq)]
    struct KeyAuth { address owner; address key; uint64 expiry; uint64 nonce; bytes sig; }
    #[derive(Debug, PartialEq, Eq)]
    struct Fill { uint16 taker; uint16 maker; uint8 kind; uint128 amount; }
    #[derive(Debug, PartialEq, Eq)]
    struct Batch { uint64 ts; KeyAuth[] keys; SignedOrder[] orders; Fill[] fills; uint64 withdrawTo; }

    #[derive(Debug, PartialEq, Eq)]
    struct LaunchConfig {
        string name; string symbol; string imageURI; address feed; uint256 strike;
        uint64 settleTime; uint16 cutBps; uint256 target; bytes32 salt;
    }

    #[derive(Debug, PartialEq, Eq)]
    struct LaunchView {
        address creator; address rail; address feed; uint256 strike; uint64 settleTime;
        uint64 createdAt; uint16 cutBps; uint256 target; uint256 pairs; uint256 raised;
        uint8 status; uint8 outcome; uint256 settlePrice; uint64 settleUpdatedAt; bool snapped;
        bool resolved; address token; uint256 totalLoserShares; string name; string symbol;
        string imageURI;
    }

    interface IExchange {
        function setFactory(address factory) external;
        function setOperator(address op, bool on) external;
        function setFeed(address feed, bool enabled) external;
        function setMinTarget(uint256 bnb) external;

        function deposit() external payable;
        function requestWithdraw(uint256 amount) external returns (uint64 idx);
        function forceWithdraw(uint64 idx) external;
        function claimPayout() external;

        function authorizeKey(address key, uint64 expiry) external;
        function revokeKey(address key) external;
        function cancelOrder(Order calldata o) external;
        function bumpMinNonce(uint64 minNonce) external;

        function registerLaunch(address rail, address creator, address token, LaunchConfig calldata c)
            external returns (uint256 launchId);
        function snapshot(uint256 launchId) external;
        function resolve(uint256 launchId) external;
        function redeem(uint256 launchId, address[] calldata users) external;
        function graduate(uint256 launchId) external;
        function receiveLoserTokens(uint256 launchId, address token, uint256 amount) external;
        function claimTokens(uint256 launchId) external;

        function submitBatch(Batch calldata b) external;

        function launchCount() external view returns (uint256);
        function getLaunch(uint256 id) external view returns (LaunchView memory);
        function isTradable(uint256 id, uint64 ts) external view returns (bool);
        function projectedRaised(uint256 id) external view returns (uint256);
        function balanceOf(address u) external view returns (uint256);
        function position(uint256 id, address u) external view returns (uint128 up, uint128 down);
        function filled(bytes32 orderHash) external view returns (uint128);
        function orderHash(Order calldata o) external view returns (bytes32);
        function withdrawQueueLength() external view returns (uint64);
        function withdrawProcessed() external view returns (uint64);
        /// Public state variable behind `setMinTarget` (not in SPEC's view list; read with a fallback).
        function minTarget() external view returns (uint256);

        event Deposited(address user, uint256 amount);
        event WithdrawRequested(uint64 idx, address user, uint256 amount);
        event WithdrawPaid(uint64 idx, address user, uint256 requested, uint256 paid);
        event KeyAuthorized(address owner, address key, uint64 expiry);
        event KeyRevoked(address owner, address key);
        event OrderCancelled(address owner, bytes32 orderHash);
        event MinNonceBumped(address owner, uint64 minNonce);
        event LaunchCreated(uint256 launchId, address creator, address rail, address token, address feed,
            uint256 strike, uint64 settleTime, uint16 cutBps, uint256 target, string name, string symbol,
            string imageURI);
        event Snapshot(uint256 launchId, uint256 price, uint64 updatedAt);
        event Resolved(uint256 launchId, uint8 outcome, uint256 pairs, uint256 raised);
        event Graduating(uint256 launchId);
        event Graduated(uint256 launchId, address token, uint256 raised);
        event LaunchFailed(uint256 launchId);
        event Redeemed(uint256 launchId, address user, uint256 credit, uint256 loserShares);
        event TokensClaimed(uint256 launchId, address user, uint256 amount);
        event BatchSubmitted(uint64 batchId, uint64 ts, uint256 fills);
        event Trade(uint256 launchId, bytes32 takerHash, bytes32 makerHash, uint8 kind, uint8 makerPrice,
            uint128 amount);
    }

    interface IAggregator {
        function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt,
            uint256 updatedAt, uint80 answeredInRound);
    }

    interface IPortal {
        function SALT_LOCK_FEE() external view returns (uint256);
    }
}

impl From<&crate::types::Order> for Order {
    fn from(o: &crate::types::Order) -> Self {
        Order {
            owner: o.owner,
            launchId: o.launch_id,
            round: o.round,
            outcome: o.outcome.as_u8(),
            side: o.side.as_u8(),
            price: o.price,
            amount: o.amount,
            expiry: o.expiry,
            nonce: o.nonce,
        }
    }
}

impl TryFrom<&Order> for crate::types::Order {
    type Error = anyhow::Error;
    fn try_from(o: &Order) -> anyhow::Result<Self> {
        Ok(crate::types::Order {
            owner: o.owner,
            launch_id: o.launchId,
            round: o.round,
            outcome: crate::types::Outcome::from_u8(o.outcome)
                .ok_or_else(|| anyhow::anyhow!("bad outcome"))?,
            side: crate::types::Side::from_u8(o.side).ok_or_else(|| anyhow::anyhow!("bad side"))?,
            price: o.price,
            amount: o.amount,
            expiry: o.expiry,
            nonce: o.nonce,
        })
    }
}
