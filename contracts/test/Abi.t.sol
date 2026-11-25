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
        assertEq(Exchange.QuestionSet.selector, keccak256("QuestionSet(uint256,string,uint256)"));
        assertEq(Exchange.OutcomeProposed.selector, keccak256("OutcomeProposed(uint256,uint8,bytes32,address,bool)"));
        assertEq(Exchange.ResolverSet.selector, keccak256("ResolverSet(address)"));
        assertEq(Exchange.ChallengeWindowSet.selector, keccak256("ChallengeWindowSet(uint64)"));
    }

    /// Pins the question-launch function selectors and the LaunchConfig tuple the factory decodes.
    function test_questionFunctionSelectors() public pure {
        assertEq(
            Exchange.registerLaunch.selector,
            bytes4(
                keccak256(
                    "registerLaunch(address,address,address,(string,string,string,address,uint256,uint64,uint16,uint256,bytes32,string,uint256))"
                )
            )
        );
        assertEq(Exchange.proposeOutcome.selector, bytes4(keccak256("proposeOutcome(uint256,uint8,bytes32)")));
        assertEq(Exchange.overrideOutcome.selector, bytes4(keccak256("overrideOutcome(uint256,uint8,bytes32)")));
        assertEq(Exchange.setResolver.selector, bytes4(keccak256("setResolver(address)")));
        assertEq(Exchange.setChallengeWindow.selector, bytes4(keccak256("setChallengeWindow(uint64)")));
        assertEq(Exchange.getQuestion.selector, bytes4(keccak256("getQuestion(uint256)")));
        assertEq(Exchange.isQuestion.selector, bytes4(keccak256("isQuestion(uint256)")));
    }
}
