// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Base} from "test/helpers/Base.t.sol";
import {Exchange} from "src/Exchange.sol";
import {MockRail} from "test/helpers/MockRail.sol";

/// An 18-decimal quote token that can refuse transfers to one address (a blacklist, like real stablecoins).
contract MockQuote is ERC20 {
    uint8 internal immutable dec;
    address public blocked;

    constructor(uint8 d) ERC20("Test USD", "USD") {
        dec = d;
    }

    function decimals() public view override returns (uint8) {
        return dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function block_(address a) external {
        blocked = a;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(to != blocked || to == address(0), "blocked");
        super._update(from, to, value);
    }
}

/// The Exchange with an ERC20 quote token (address(0) = native is covered by every other suite).
contract QuoteTokenTest is Base {
    MockQuote usd;
    MockRail rail;

    function setUp() public override {
        super.setUp();
        usd = new MockQuote(18);
        ex = new Exchange(owner, address(usd));
        vm.startPrank(owner);
        ex.setFactory(address(this));
        ex.setFeed(address(feed), true);
        ex.setOperator(operator, true);
        vm.stopPrank();
        _fundUsd(alice, 50 ether);
        _fundUsd(bob, 50 ether);
    }

    function _fundUsd(address u, uint256 amt) internal {
        usd.mint(u, amt);
        vm.startPrank(u);
        usd.approve(address(ex), amt);
        ex.deposit(amt);
        vm.stopPrank();
    }

    function test_constructorRejectsNon18Decimals() public {
        MockQuote six = new MockQuote(6);
        vm.expectRevert(Exchange.BadToken.selector);
        new Exchange(owner, address(six));
    }

    function test_depositPullsTokenAndRejectsValue() public {
        assertEq(ex.quoteToken(), address(usd));
        assertEq(ex.balanceOf(alice), 50 ether);
        assertEq(usd.balanceOf(address(ex)), 100 ether);

        usd.mint(carol, 1 ether);
        vm.startPrank(carol);
        usd.approve(address(ex), 1 ether);
        vm.expectRevert(Exchange.BadValue.selector);
        ex.deposit{value: 1 ether}(1 ether);
        vm.expectRevert(Exchange.ZeroAmount.selector);
        ex.deposit(0);
        vm.expectEmit(address(ex));
        emit Exchange.Deposited(carol, 1 ether);
        ex.deposit(1 ether);
        vm.stopPrank();
        assertEq(ex.balanceOf(carol), 1 ether);
        assertEq(address(ex).balance, 0);
    }

    function test_nativeModeRejectsMismatchedValue() public {
        Exchange nat = new Exchange(owner, address(0));
        vm.prank(alice);
        vm.expectRevert(Exchange.BadValue.selector);
        nat.deposit{value: 1 ether}(2 ether);
    }

    function test_withdrawPaysToken() public {
        vm.prank(alice);
        uint64 idx = ex.requestWithdraw(20 ether);
        vm.prank(operator);
        ex.submitBatch(_emptyBatch(uint64(block.timestamp), idx + 1));
        assertEq(usd.balanceOf(alice), 20 ether);
        assertEq(ex.balanceOf(alice), 30 ether);
    }

    function test_blockedReceiverGoesPendingThenClaims() public {
        usd.block_(alice);
        vm.prank(alice);
        uint64 idx = ex.requestWithdraw(5 ether);
        vm.prank(operator);
        ex.submitBatch(_emptyBatch(uint64(block.timestamp), idx + 1));
        assertEq(ex.pendingPayout(alice), 5 ether);
        assertEq(usd.balanceOf(address(ex)), 100 ether);
        vm.prank(alice);
        vm.expectRevert(bytes("blocked"));
        ex.claimPayout();
        usd.block_(address(0xdead));
        vm.prank(alice);
        ex.claimPayout();
        assertEq(usd.balanceOf(alice), 5 ether);
        assertEq(ex.pendingPayout(alice), 0);
    }

    function test_graduationTransfersRaiseToRail() public {
        rail = new MockRail(ex);
        Exchange.LaunchConfig memory c = _cfg();
        uint256 id = ex.registerLaunch(address(rail), alice, address(rail.token()), c);
        lid = id;
        _mint(alice, bob, 50, 22e18); // cut 10% -> raised 2.2
        _settle(id, 1e18);
        vm.warp(c.settleTime + 15);
        ex.resolve(id);
        ex.graduate(id);
        assertEq(usd.balanceOf(address(rail)), 2.2 ether, "rail holds the USD raise");
        assertEq(rail.quoteArg(), 2.2 ether);
        assertEq(rail.received(), 0, "no native value");
        assertEq(usd.balanceOf(address(ex)), 100 ether - 2.2 ether);
        assertEq(ex.getLaunch(id).status, 2);
    }
}
