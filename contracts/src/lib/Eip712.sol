// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title Eip712
/// @notice The predictlaunch EIP-712 types (SPEC.md "EIP-712"). The Rust sequencer and the frontend hash the same
///         structs; `fixtures/eip712-vectors.json` (written by test/Vectors.t.sol) pins all three implementations.
library Eip712 {
    /// outcome 0=Up 1=Down; side 0=Buy 1=Sell; price 1..99 (hundredths of 1 BNB per share, in the order's own
    /// outcome terms); amount = shares (18 decimals), a multiple of 1e16.
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

    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant NAME_HASH = keccak256("predictlaunch");
    bytes32 internal constant VERSION_HASH = keccak256("1");

    bytes32 internal constant ORDER_TYPEHASH = keccak256(
        "Order(address owner,uint256 launchId,uint32 round,uint8 outcome,uint8 side,uint8 price,uint128 amount,uint64 expiry,uint64 nonce)"
    );
    bytes32 internal constant AUTHORIZE_KEY_TYPEHASH =
        keccak256("AuthorizeKey(address owner,address key,uint64 expiry,uint64 nonce)");
    /// Signed offchain, sent to the sequencer, which carries it onchain in the next batch (`Batch.cancels`).
    bytes32 internal constant CANCEL_TYPEHASH = keccak256("Cancel(address owner,bytes32 orderHash,uint64 nonce)");

    function domainSeparator(uint256 chainId, address verifyingContract) internal pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, chainId, verifyingContract));
    }

    function digest(bytes32 domain, bytes32 structHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function hashOrderStruct(Order memory o) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ORDER_TYPEHASH, o.owner, o.launchId, o.round, o.outcome, o.side, o.price, o.amount, o.expiry, o.nonce
            )
        );
    }

    function hashOrder(bytes32 domain, Order memory o) internal pure returns (bytes32) {
        return digest(domain, hashOrderStruct(o));
    }

    function hashAuthorizeKey(bytes32 domain, address owner, address key, uint64 expiry, uint64 nonce)
        internal
        pure
        returns (bytes32)
    {
        return digest(domain, keccak256(abi.encode(AUTHORIZE_KEY_TYPEHASH, owner, key, expiry, nonce)));
    }

    function hashCancel(bytes32 domain, address owner, bytes32 orderHash, uint64 nonce)
        internal
        pure
        returns (bytes32)
    {
        return digest(domain, keccak256(abi.encode(CANCEL_TYPEHASH, owner, orderHash, nonce)));
    }
}
