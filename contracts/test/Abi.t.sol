// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Exchange} from "src/Exchange.sol";

/// Pins the event signatures the sequencer decodes (core/src/abi.rs). No event parameter is indexed.
contract AbiTest is Test {
    function test_eventSignatures() public pure {
        assertEq(Exchange.Deposited.selector, keccak256("Deposited(address,uint256)"));
        assertEq(Exchange.WithdrawRequested.selector, keccak256("WithdrawRequested(uint64,address,uint256)"));
        assertEq(Exchange.WithdrawPaid.selector, keccak256("WithdrawPaid(uint64,address,uint256,uint256)"));
        assertEq(Exchange.KeyAuthorized.selector, keccak256("KeyAuthorized(address,address,uint64)"));
        assertEq(Exchange.KeyRevoked.selector, keccak256("KeyRevoked(address,address)"));
        assertEq(Exchange.OrderCancelled.selector, keccak256("OrderCancelled(address,bytes32)"));
        assertEq(Exchange.MinNonceBumped.selector, keccak256("MinNonceBumped(address,uint64)"));
        assertEq(
            Exchange.LaunchCreated.selector,
            keccak256(
                "LaunchCreated(uint256,address,address,address,address,uint256,uint64,uint16,uint256,string,string,string)"
            )
        );
        assertEq(Exchange.Snapshot.selector, keccak256("Snapshot(uint256,uint256,uint64)"));
        assertEq(Exchange.Resolved.selector, keccak256("Resolved(uint256,uint8,uint256,uint256)"));
        assertEq(Exchange.Graduating.selector, keccak256("Graduating(uint256)"));
        assertEq(Exchange.Graduated.selector, keccak256("Graduated(uint256,address,uint256)"));
        assertEq(Exchange.LaunchFailed.selector, keccak256("LaunchFailed(uint256)"));
        assertEq(Exchange.Redeemed.selector, keccak256("Redeemed(uint256,address,uint256,uint256)"));
        assertEq(Exchange.TokensClaimed.selector, keccak256("TokensClaimed(uint256,address,uint256)"));
        assertEq(Exchange.BatchSubmitted.selector, keccak256("BatchSubmitted(uint64,uint64,uint256)"));
        assertEq(Exchange.Trade.selector, keccak256("Trade(uint256,bytes32,bytes32,uint8,uint8,uint128)"));
    }
}
