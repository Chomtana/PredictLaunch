// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base} from "test/helpers/Base.t.sol";
import {Exchange} from "src/Exchange.sol";
import {MockRail} from "test/helpers/MockRail.sol";

contract LifecycleTest is Base {
    MockRail rail;
    uint256 constant LS = 500_000_000e18;

    function setUp() public override {
        super.setUp();
        _deposit(alice, 50 ether);
        _deposit(bob, 50 ether);
        _deposit(carol, 50 ether);
    }

    function _newLaunch(uint16 cut) internal returns (uint256 id) {
        rail = new MockRail(ex);
        Exchange.LaunchConfig memory c = _cfg();
        c.cutBps = cut;
        id = ex.registerLaunch(address(rail), alice, address(rail.token()), c);
        lid = id;
    }

    function _resolveAt(uint256 id, int256 price) internal {
        _settle(id, price);
        vm.warp(ex.getLaunch(id).settleTime + 15);
        ex.resolve(id);
    }

    function _redeem(uint256 id, address u) internal {
        address[] memory us = new address[](1);
        us[0] = u;
        ex.redeem(id, us);
    }

    function test_redeemWinnerGetsOneMinusCut() public {
        uint256 id = _newLaunch(2500);
        _mint(alice, bob, 50, 10e18); // raised = 2.5 >= 2.15
        // Carol buys 2 Up from Alice @50
        _fill(_o(carol, 0, 0, 50, 2e18), _o(alice, 0, 1, 50, 2e18), 0, 2e18);
        address[] memory us = new address[](1);
        us[0] = carol;
        vm.expectRevert(Exchange.NotResolved.selector);
        ex.redeem(id, us);
        _resolveAt(id, 100e18); // Up wins
        assertEq(ex.getLaunch(id).status, 1);
        uint256 before = ex.balanceOf(carol);
        vm.expectEmit(address(ex));
        emit Exchange.Redeemed(id, carol, 1.5 ether, 0);
        ex.redeem(id, us);
        assertEq(ex.balanceOf(carol) - before, 1.5 ether);
        (uint128 up, uint128 down) = ex.position(id, carol);
        assertEq(up + down, 0);
        // idempotent
        ex.redeem(id, us);
        assertEq(ex.balanceOf(carol) - before, 1.5 ether);
        // the loser's shares are counted
        _redeem(id, bob);
        assertEq(ex.loserShares(id, bob), 10e18);
        assertEq(ex.balanceOf(bob), 50 ether - 5 ether);
    }

    function test_graduationCallsRail() public {
        uint256 id = _newLaunch(1000);
        _mint(alice, bob, 50, 22e18); // raised 2.2
        vm.expectRevert(Exchange.NotGraduating.selector);
        ex.graduate(id);
        _resolveAt(id, 1e18); // Down wins
        Exchange.LaunchView memory l = ex.getLaunch(id);
        assertEq(l.status, 1);
        assertEq(l.raised, 2.2 ether);
        uint256 exBal = address(ex).balance;
        vm.expectEmit(address(ex));
        emit Exchange.Graduated(id, address(rail.token()), 2.2 ether);
        ex.graduate(id);
        assertEq(rail.received(), 2.2 ether);
        assertEq(address(ex).balance, exBal - 2.2 ether);
        assertEq(rail.token().balanceOf(address(ex)), LS);
        assertEq(ex.getLaunch(id).status, 2);
        assertFalse(ex.isTradable(id, uint64(l.settleTime - 1)));
        vm.expectRevert(Exchange.NotGraduating.selector);
        ex.graduate(id);
        // solvency after graduation: winners' credits + raised == pairs
        address[] memory us = new address[](2);
        us[0] = alice;
        us[1] = bob;
        ex.redeem(id, us);
        assertEq(address(ex).balance, ex.balanceOf(alice) + ex.balanceOf(bob) + ex.balanceOf(carol));
    }

    function test_railSkippingLoserTokensReverts() public {
        uint256 id = _newLaunch(1000);
        _mint(alice, bob, 50, 22e18);
        _resolveAt(id, 1e18);
        rail.setSkipReceive(true);
        vm.expectRevert(Exchange.LoserTokensMissing.selector);
        ex.graduate(id);
        assertEq(ex.getLaunch(id).status, 1);
    }

    function test_receiveLoserTokensOnlyRailOnce() public {
        uint256 id = _newLaunch(1000);
        _mint(alice, bob, 50, 22e18);
        _resolveAt(id, 1e18);
        // not during a graduation
        vm.expectRevert(Exchange.NotGraduated.selector);
        rail.push(id, LS);
        address tok = address(rail.token());
        // not from anyone but the rail
        vm.expectRevert(Exchange.NotRail.selector);
        ex.receiveLoserTokens(id, tok, LS);
        ex.graduate(id);
        // and only once
        vm.expectRevert(Exchange.LoserTokensAlreadyIn.selector);
        rail.push(id, LS);
    }

    function test_incrementalClaimsSumToLoserSupply() public {
        uint256 id = _newLaunch(1000);
        _deposit(dave, 50 ether);
        // three losers holding Down: 7, 11 and 12.33 (total 30.33, which does not divide 500M evenly); Dave holds Up
        _mint(dave, alice, 50, 7e18);
        _mint(dave, bob, 50, 11e18);
        _mint(dave, carol, 50, 12.33e18);
        _resolveAt(id, 1000e18); // Up wins
        ex.graduate(id);
        assertEq(ex.getLaunch(id).totalLoserShares, 30.33e18);

        // nothing to claim before redeeming
        vm.prank(alice);
        vm.expectRevert(Exchange.NothingToClaim.selector);
        ex.claimTokens(id);
        // Alice redeems and claims while Bob and Carol have not redeemed yet
        _redeem(id, alice);
        assertEq(ex.claimableTokens(id, alice), uint256(7e18) * LS / 30.33e18);
        vm.prank(alice);
        vm.expectEmit(address(ex));
        emit Exchange.TokensClaimed(id, alice, uint256(7e18) * LS / 30.33e18);
        ex.claimTokens(id);
        vm.prank(alice);
        vm.expectRevert(Exchange.NothingToClaim.selector);
        ex.claimTokens(id);
        _redeem(id, bob);
        vm.prank(bob);
        ex.claimTokens(id);
        _redeem(id, dave);
        _redeem(id, carol);
        vm.prank(carol);
        ex.claimTokens(id);

        uint256 a = rail.token().balanceOf(alice);
        uint256 b = rail.token().balanceOf(bob);
        uint256 c = rail.token().balanceOf(carol);
        assertEq(a, uint256(7e18) * LS / 30.33e18);
        assertEq(b, uint256(11e18) * LS / 30.33e18);
        assertEq(c, uint256(12.33e18) * LS / 30.33e18);
        uint256 paid = a + b + c;
        assertLe(LS - paid, 3 * 2, "dust <= 2 wei per claimer");
        assertEq(rail.token().balanceOf(address(ex)), LS - paid, "dust stays in Exchange");
        assertEq(ex.loserShares(id, dave), 0);
        // Dave won 30.33 shares at 0.90
        assertEq(ex.balanceOf(dave), 50 ether - 15.165 ether + 27.297 ether);
    }

    function test_redeemAfterFailurePaysFull() public {
        uint256 id = _newLaunch(1000);
        _mint(alice, bob, 50, 20e18); // projected 2.0 < 2.15
        _resolveAt(id, 100e18); // Up
        Exchange.LaunchView memory l = ex.getLaunch(id);
        assertEq(l.status, 3);
        assertEq(l.raised, 0);
        _redeem(id, alice);
        _redeem(id, bob);
        assertEq(ex.balanceOf(alice), 50 ether - 10 ether + 20 ether);
        assertEq(ex.balanceOf(bob), 50 ether - 10 ether);
        assertEq(address(ex).balance, ex.balanceOf(alice) + ex.balanceOf(bob) + ex.balanceOf(carol));
        vm.expectRevert(Exchange.NotGraduating.selector);
        ex.graduate(id);
        vm.prank(bob);
        vm.expectRevert(Exchange.NotGraduated.selector);
        ex.claimTokens(id);
    }

    function test_voidRedeemsHalf() public {
        uint256 id = _newLaunch(1000);
        _mint(alice, bob, 70, 30e18); // alice paid 21, bob 9
        _fill(_o(carol, 1, 0, 50, 4e18), _o(bob, 1, 1, 50, 4e18), 0, 4e18);
        vm.warp(ex.getLaunch(id).settleTime + 61); // nobody snapshotted
        ex.resolve(id);
        assertEq(ex.getLaunch(id).outcome, 2);
        address[] memory us = new address[](3);
        us[0] = alice;
        us[1] = bob;
        us[2] = carol;
        ex.redeem(id, us);
        assertEq(ex.balanceOf(alice), 50 ether - 21 ether + 15 ether);
        assertEq(ex.balanceOf(bob), 50 ether - 9 ether + 2 ether + 13 ether);
        assertEq(ex.balanceOf(carol), 50 ether - 2 ether + 2 ether);
        assertEq(ex.loserShares(id, bob), 0);
        assertEq(address(ex).balance, ex.balanceOf(alice) + ex.balanceOf(bob) + ex.balanceOf(carol));
    }
}
