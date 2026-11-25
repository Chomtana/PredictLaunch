// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Exchange} from "src/Exchange.sol";
import {MockFeed} from "test/helpers/MockFeed.sol";

abstract contract Base is Test {
    Exchange ex;
    MockFeed feed;
    address owner = makeAddr("owner");
    address operator = makeAddr("operator");
    uint256 constant ALICE_PK = 0xA11CE;
    uint256 constant BOB_PK = 0xB0B;
    uint256 constant CAROL_PK = 0xCA401;
    address alice = vm.addr(ALICE_PK);
    address bob = vm.addr(BOB_PK);
    address carol = vm.addr(CAROL_PK);

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        ex = new Exchange(owner);
        feed = new MockFeed();
        vm.startPrank(owner);
        ex.setFactory(address(this));
        ex.setFeed(address(feed), true);
        ex.setOperator(operator, true);
        vm.stopPrank();
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
    }

    address constant RAIL = address(0x8A11);
    address constant TOKEN = address(0x7777);

    function _cfg() internal view returns (Exchange.LaunchConfig memory c) {
        c.name = "Moon";
        c.symbol = "MOON";
        c.imageURI = "ipfs://moon";
        c.feed = address(feed);
        c.strike = 100e18;
        c.settleTime = uint64(block.timestamp + 3600);
        c.cutBps = 1000;
        c.target = 2.15 ether;
        c.salt = bytes32(uint256(1));
    }

    function _register(Exchange.LaunchConfig memory c) internal returns (uint256) {
        return ex.registerLaunch(RAIL, alice, TOKEN, c);
    }

    /// Snapshot the settlement price `p` (feed updated exactly at settleTime).
    function _settle(uint256 id, int256 p) internal {
        uint64 st = ex.getLaunch(id).settleTime;
        if (block.timestamp < st) vm.warp(st);
        feed.set(p, st);
        ex.snapshot(id);
    }

    function _deposit(address u, uint256 amt) internal {
        vm.prank(u);
        ex.deposit{value: amt}();
    }

    function _warpTo(uint256 t) internal {
        vm.warp(t);
    }

    function _emptyBatch(uint64 ts, uint64 withdrawTo) internal pure returns (Exchange.Batch memory b) {
        b.ts = ts;
        b.withdrawTo = withdrawTo;
    }
}
