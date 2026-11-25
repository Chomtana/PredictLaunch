// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base} from "test/helpers/Base.t.sol";
import {Exchange} from "src/Exchange.sol";
import {MockChainlink} from "test/helpers/MockChainlink.sol";
import {RevertingFeed} from "test/helpers/RevertingFeed.sol";

/// Chainlink fallback for the settlement snapshot (Atlas stays the primary source).
contract FallbackTest is Base {
    event Snapshot(uint256 launchId, uint256 price, uint64 updatedAt);
    event SnapshotSource(uint256 launchId, address source);

    RevertingFeed atlas;
    MockChainlink cl;

    function setUp() public override {
        super.setUp();
        atlas = new RevertingFeed();
        cl = new MockChainlink(8);
        vm.prank(owner);
        ex.setFeed(address(atlas), true);
    }

    function _launchOn(address f) internal returns (uint256 id, uint64 st) {
        Exchange.LaunchConfig memory c = _cfg();
        c.feed = f;
        id = _register(c);
        st = c.settleTime;
    }

    function test_setFallbackFeedOnlyOwner() public {
        vm.expectRevert();
        ex.setFallbackFeed(address(atlas), address(cl));
        vm.prank(owner);
        ex.setFallbackFeed(address(atlas), address(cl));
        assertEq(ex.fallbackFeed(address(atlas)), address(cl));
        vm.prank(owner);
        ex.setFallbackFeed(address(atlas), address(0));
        assertEq(ex.fallbackFeed(address(atlas)), address(0));
    }

    function test_revertingAtlasUsesChainlinkScaledTo18() public {
        vm.prank(owner);
        ex.setFallbackFeed(address(atlas), address(cl));
        (uint256 id, uint64 st) = _launchOn(address(atlas));
        vm.warp(st);
        cl.set(9_876_543_210_000, st - 1); // 98,765.4321 with 8 decimals
        vm.expectEmit();
        emit Snapshot(id, 98_765.4321e18, st - 1);
        vm.expectEmit();
        emit SnapshotSource(id, address(cl));
        ex.snapshot(id);
        Exchange.LaunchView memory l = ex.getLaunch(id);
        assertTrue(l.snapped);
        assertEq(l.settlePrice, 98_765.4321e18);
        assertEq(l.settleUpdatedAt, st - 1);
    }

    function test_fallbackSameRules() public {
        vm.prank(owner);
        ex.setFallbackFeed(address(atlas), address(cl));
        (uint256 id, uint64 st) = _launchOn(address(atlas));
        vm.warp(st);
        cl.set(1e8, st + 6); // updated after settleTime + SNAP_TOLERANCE
        vm.expectRevert(Exchange.StaleOrFuturePrice.selector);
        ex.snapshot(id);
        cl.set(0, st);
        vm.expectRevert(Exchange.BadPrice.selector);
        ex.snapshot(id);
        cl.set(1e8, st);
        vm.warp(st + 61);
        vm.expectRevert(Exchange.NotInWindow.selector);
        ex.snapshot(id);
    }

    function test_noFallbackReverts() public {
        (uint256 id, uint64 st) = _launchOn(address(atlas));
        vm.warp(st);
        vm.expectRevert(RevertingFeed.OnlyAuthorizedCallerAllowed.selector);
        ex.snapshot(id);
    }

    function test_atlasZeroAnswerFallsBack() public {
        vm.prank(owner);
        ex.setFallbackFeed(address(feed), address(cl));
        (uint256 id, uint64 st) = _launchOn(address(feed));
        vm.warp(st);
        feed.set(0, st);
        cl.set(5e8, st);
        ex.snapshot(id);
        assertEq(ex.getLaunch(id).settlePrice, 5e18);
    }

    function test_atlasReadableIsUsedEvenWithFallback() public {
        vm.prank(owner);
        ex.setFallbackFeed(address(feed), address(cl));
        (uint256 id, uint64 st) = _launchOn(address(feed));
        vm.warp(st);
        feed.set(123e18, st);
        cl.set(999e8, st);
        vm.expectEmit();
        emit SnapshotSource(id, address(feed));
        ex.snapshot(id);
        assertEq(ex.getLaunch(id).settlePrice, 123e18);
    }
}
