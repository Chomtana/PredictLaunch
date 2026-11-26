// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base} from "test/helpers/Base.t.sol";
import {Exchange} from "src/Exchange.sol";
import {ExchangeHarness} from "test/helpers/ExchangeHarness.sol";

/// C3 (Amendment A1): launch registration, the settlement snapshot, resolution.
contract MarketTest is Base {
    ExchangeHarness hx;

    function setUp() public override {
        super.setUp();
        // use the harness everywhere in this suite (so pairs can be set without a batch)
        hx = new ExchangeHarness(owner);
        ex = hx;
        vm.startPrank(owner);
        ex.setFactory(address(this));
        ex.setFeed(address(feed), true);
        vm.stopPrank();
    }

    function _expectRegisterRevert(Exchange.LaunchConfig memory c, bytes4 sel) internal {
        vm.expectRevert(sel);
        ex.registerLaunch(RAIL, alice, TOKEN, c);
    }

    function test_registerValidates() public {
        Exchange.LaunchConfig memory c = _cfg();
        vm.prank(alice);
        vm.expectRevert(Exchange.NotFactory.selector);
        ex.registerLaunch(RAIL, alice, TOKEN, c);

        c = _cfg();
        c.feed = address(0xFEED);
        _expectRegisterRevert(c, Exchange.FeedNotEnabled.selector);

        c = _cfg();
        c.strike = 0;
        _expectRegisterRevert(c, Exchange.BadConfig.selector);

        c = _cfg();
        c.settleTime = uint64(block.timestamp + 59);
        _expectRegisterRevert(c, Exchange.BadDuration.selector);
        c.settleTime = uint64(block.timestamp + 30 days + 1);
        _expectRegisterRevert(c, Exchange.BadDuration.selector);
        c.settleTime = uint64(block.timestamp - 1);
        _expectRegisterRevert(c, Exchange.BadDuration.selector);

        c = _cfg();
        c.cutBps = 1200;
        _expectRegisterRevert(c, Exchange.BadCut.selector);

        c = _cfg();
        c.target = 2.15 ether - 1;
        _expectRegisterRevert(c, Exchange.TargetTooLow.selector);

        c = _cfg();
        c.name = "";
        _expectRegisterRevert(c, Exchange.BadConfig.selector);
        c.name = "123456789012345678901234567890123"; // 33 bytes
        _expectRegisterRevert(c, Exchange.BadConfig.selector);
        c = _cfg();
        c.symbol = "12345678901";
        _expectRegisterRevert(c, Exchange.BadConfig.selector);

        // valid: bounds inclusive
        c = _cfg();
        c.settleTime = uint64(block.timestamp + 60);
        c.cutBps = 3000;
        vm.expectEmit(address(ex));
        emit Exchange.LaunchCreated(
            0, alice, RAIL, TOKEN, address(feed), 100e18, c.settleTime, 3000, 2.15 ether, "Moon", "MOON", "ipfs://moon"
        );
        assertEq(_register(c), 0);
        c.settleTime = uint64(block.timestamp + 30 days);
        assertEq(_register(c), 1);
        assertEq(ex.launchCount(), 2);
        Exchange.LaunchView memory l = ex.getLaunch(0);
        assertEq(l.creator, alice);
        assertEq(l.rail, RAIL);
        assertEq(l.token, TOKEN);
        assertEq(l.createdAt, block.timestamp);
        assertEq(l.settleTime, block.timestamp + 60);
        assertEq(l.cutBps, 3000);
        assertEq(l.status, 0);
        assertEq(l.name, "Moon");
        assertEq(l.imageURI, "ipfs://moon");
        assertFalse(l.snapped);
        assertFalse(l.resolved);
    }

    function test_snapshotWindow() public {
        uint256 id = _register(_cfg());
        uint64 st = ex.getLaunch(id).settleTime;
        feed.set(105e18, st);
        vm.warp(st - 1);
        vm.expectRevert(Exchange.NotInWindow.selector);
        ex.snapshot(id);
        vm.warp(st);
        feed.set(105e18, st + 6);
        vm.expectRevert(Exchange.StaleOrFuturePrice.selector);
        ex.snapshot(id);
        feed.set(0, st + 5);
        vm.expectRevert(Exchange.BadPrice.selector);
        ex.snapshot(id);
        feed.set(105e18, st + 5);
        vm.expectEmit(address(ex));
        emit Exchange.Snapshot(id, 105e18, st + 5);
        ex.snapshot(id);
        Exchange.LaunchView memory l = ex.getLaunch(id);
        assertTrue(l.snapped);
        assertEq(l.settlePrice, 105e18);
        assertEq(l.settleUpdatedAt, st + 5);
        vm.expectRevert(Exchange.AlreadySnapped.selector);
        ex.snapshot(id);

        uint256 id2 = _register(_cfg());
        uint64 st2 = ex.getLaunch(id2).settleTime;
        feed.set(105e18, st2);
        vm.warp(st2 + 61);
        vm.expectRevert(Exchange.NotInWindow.selector);
        ex.snapshot(id2);
        vm.warp(st2 + 60);
        ex.snapshot(id2);
    }

    function test_resolveOutcomes() public {
        // price == strike -> Up; enough pairs -> Graduating
        uint256 a = _register(_cfg());
        hx.setPairs(a, 30e18); // 30 * 0.10 = 3 BNB >= 2.15
        assertEq(ex.projectedRaised(a), 3 ether);
        _settle(a, 100e18);
        vm.expectRevert(Exchange.TooEarly.selector);
        ex.resolve(a);
        vm.warp(ex.getLaunch(a).settleTime + 15);
        vm.expectEmit(address(ex));
        emit Exchange.Graduating(a);
        vm.expectEmit(address(ex));
        emit Exchange.Resolved(a, 0, 30e18, 3 ether);
        ex.resolve(a);
        Exchange.LaunchView memory l = ex.getLaunch(a);
        assertEq(l.outcome, 0);
        assertEq(l.status, 1);
        assertEq(l.raised, 3 ether);
        assertEq(l.totalLoserShares, 30e18);
        assertTrue(l.resolved);
        assertEq(ex.projectedRaised(a), 3 ether);
        vm.expectRevert(Exchange.AlreadyResolved.selector);
        ex.resolve(a);

        // below strike -> Down; not enough pairs -> Failed, raised 0
        uint256 b = _register(_cfg());
        hx.setPairs(b, 20e18); // 2 BNB < 2.15
        _settle(b, 100e18 - 1);
        vm.warp(ex.getLaunch(b).settleTime + 15);
        vm.expectEmit(address(ex));
        emit Exchange.LaunchFailed(b);
        ex.resolve(b);
        l = ex.getLaunch(b);
        assertEq(l.outcome, 1);
        assertEq(l.status, 3);
        assertEq(l.raised, 0);
        assertEq(l.totalLoserShares, 20e18);
    }

    function test_missedSnapshotVoids() public {
        uint256 id = _register(_cfg());
        hx.setPairs(id, 50e18);
        uint64 st = ex.getLaunch(id).settleTime;
        vm.warp(st + 15);
        vm.expectRevert(Exchange.TooEarly.selector);
        ex.resolve(id);
        vm.warp(st + 60);
        vm.expectRevert(Exchange.TooEarly.selector);
        ex.resolve(id);
        vm.warp(st + 61);
        ex.resolve(id);
        Exchange.LaunchView memory l = ex.getLaunch(id);
        assertEq(l.outcome, 2);
        assertEq(l.status, 3);
        assertEq(l.raised, 0);
        assertEq(l.totalLoserShares, 0);
        // a late snapshot is impossible now
        vm.expectRevert();
        ex.snapshot(id);
    }

    function test_tradableUntilSettle() public {
        uint256 id = _register(_cfg());
        uint64 st = ex.getLaunch(id).settleTime;
        assertTrue(ex.isTradable(id, uint64(block.timestamp)));
        assertTrue(ex.isTradable(id, st - 1));
        assertFalse(ex.isTradable(id, st));
        assertFalse(ex.isTradable(id, st + 100));
        assertFalse(ex.isTradable(99, uint64(block.timestamp)));
        hx.setPairs(id, 30e18);
        _settle(id, 1e18);
        vm.warp(st + 15);
        ex.resolve(id);
        assertFalse(ex.isTradable(id, st - 1));
    }
}
