// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base} from "test/helpers/Base.t.sol";
import {Exchange} from "src/Exchange.sol";

contract Rejecter {
    Exchange ex;
    bool public accept;

    constructor(Exchange e) payable {
        ex = e;
    }

    function dep() external {
        ex.deposit{value: address(this).balance}(address(this).balance);
    }

    function req(uint256 a) external returns (uint64) {
        return ex.requestWithdraw(a);
    }

    function claim() external {
        ex.claimPayout();
    }

    function setAccept(bool a) external {
        accept = a;
    }

    receive() external payable {
        require(accept, "no");
    }
}

contract FundsTest is Base {
    function test_depositCredits() public {
        vm.expectEmit(address(ex));
        emit Exchange.Deposited(alice, 3 ether);
        _deposit(alice, 3 ether);
        assertEq(ex.balanceOf(alice), 3 ether);
        assertEq(address(ex).balance, 3 ether);
    }

    function test_requestWithdrawQueues() public {
        _deposit(alice, 3 ether);
        vm.prank(alice);
        vm.expectEmit(address(ex));
        emit Exchange.WithdrawRequested(0, alice, 1 ether);
        assertEq(ex.requestWithdraw(1 ether), 0);
        vm.prank(bob);
        assertEq(ex.requestWithdraw(2 ether), 1);
        assertEq(ex.withdrawQueueLength(), 2);
        assertEq(ex.withdrawProcessed(), 0);
        // nothing is locked until processed
        assertEq(ex.balanceOf(alice), 3 ether);
    }

    function test_forceWithdrawAfterDelay() public {
        _deposit(alice, 3 ether);
        vm.prank(alice);
        uint64 idx = ex.requestWithdraw(5 ether);
        vm.warp(block.timestamp + 599);
        vm.prank(alice);
        vm.expectRevert(Exchange.TooEarly.selector);
        ex.forceWithdraw(idx);
        vm.warp(block.timestamp + 1);
        vm.prank(bob);
        vm.expectRevert(Exchange.NotRequester.selector);
        ex.forceWithdraw(idx);
        uint256 before = alice.balance;
        vm.prank(alice);
        vm.expectEmit(address(ex));
        emit Exchange.WithdrawPaid(idx, alice, 5 ether, 3 ether);
        ex.forceWithdraw(idx);
        assertEq(alice.balance - before, 3 ether);
        assertEq(ex.balanceOf(alice), 0);
        vm.prank(alice);
        vm.expectRevert(Exchange.AlreadyProcessed.selector);
        ex.forceWithdraw(idx);
        // a later batch skips it (no second payment)
        _deposit(alice, 1 ether);
        vm.prank(operator);
        ex.submitBatch(_emptyBatch(1));
        assertEq(ex.withdrawProcessed(), 1);
        assertEq(ex.balanceOf(alice), 1 ether);
    }

    function test_onlyOwnerAdmin() public {
        vm.startPrank(alice);
        vm.expectRevert();
        ex.setFactory(alice);
        vm.expectRevert();
        ex.setFeed(alice, true);
        vm.expectRevert();
        ex.setMinTarget(1);
        vm.stopPrank();
        assertEq(ex.minTarget(), 2.15 ether);
        vm.prank(owner);
        ex.setMinTarget(3 ether);
        assertEq(ex.minTarget(), 3 ether);
        assertTrue(ex.feedEnabled(address(feed)));
        assertEq(ex.factory(), address(this));
    }

    function test_payoutToRevertingReceiverGoesPending() public {
        Rejecter r = new Rejecter{value: 2 ether}(ex);
        r.dep();
        uint64 idx = r.req(2 ether);
        vm.prank(operator);
        ex.submitBatch(_emptyBatch(idx + 1));
        assertEq(ex.balanceOf(address(r)), 0);
        assertEq(ex.pendingPayout(address(r)), 2 ether);
        assertEq(address(ex).balance, 2 ether);
        r.setAccept(true);
        r.claim();
        assertEq(address(r).balance, 2 ether);
        assertEq(ex.pendingPayout(address(r)), 0);
        vm.expectRevert(Exchange.NothingToClaim.selector);
        r.claim();
    }
}
