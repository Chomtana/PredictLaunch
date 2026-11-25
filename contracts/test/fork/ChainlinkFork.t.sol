// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {Exchange} from "src/Exchange.sol";

interface IAggV3 {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// Live BSC-testnet state, Exchange NOT authorized on Atlas (as on the real chain today): the BTCB snapshot falls
/// back to Chainlink BTC/USD, scaled to 18 decimals, and emits SnapshotSource(chainlink).
contract ChainlinkForkTest is Test {
    address constant BTCB_FEED = 0xe20536BC715AaC6560394e33deB66ed205AEeC33;
    address constant CL_BTC = 0x5741306c21795FdCBb9b265Ea0255F499DFe515C;

    event SnapshotSource(uint256 launchId, address source);

    Exchange ex;
    address owner = address(uint160(0xC0DE1001));

    function setUp() public {
        string memory rpc = vm.envOr("BSC_TESTNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        ex = new Exchange(owner, address(0));
        vm.startPrank(owner);
        ex.setFactory(address(this));
        ex.setFeed(BTCB_FEED, true);
        vm.stopPrank();
    }

    function _launch() internal returns (uint256 id, uint64 st) {
        Exchange.LaunchConfig memory c;
        c.name = "Fallback";
        c.symbol = "FB";
        c.feed = BTCB_FEED;
        c.strike = uint80(uint256(vm.load(BTCB_FEED, bytes32(uint256(0x32)))));
        c.settleTime = st = uint64(block.timestamp + 600);
        c.cutBps = 1000;
        c.target = 2.15 ether;
        id = ex.registerLaunch(address(0xBEEF), address(0xCAFE), address(0x7777), c);
    }

    function test_unauthorizedAtlasRevertsWithoutFallback() public {
        (uint256 id, uint64 st) = _launch();
        vm.warp(st);
        vm.expectRevert();
        ex.snapshot(id);
    }

    function test_snapshotFallsBackToChainlink() public {
        assertEq(IAggV3(CL_BTC).decimals(), 8);
        vm.prank(owner);
        ex.setFallbackFeed(BTCB_FEED, CL_BTC);
        (uint256 id, uint64 st) = _launch();
        vm.warp(st);
        (, int256 clAnswer,, uint256 clUpdated,) = IAggV3(CL_BTC).latestRoundData();
        vm.expectEmit();
        emit SnapshotSource(id, CL_BTC);
        ex.snapshot(id);
        Exchange.LaunchView memory l = ex.getLaunch(id);
        assertTrue(l.snapped);
        assertEq(l.settlePrice, uint256(clAnswer) * 1e10);
        assertEq(l.settleUpdatedAt, clUpdated);
        // same units as the Atlas strike: within 5% of the Atlas BTCB price
        assertApproxEqRel(l.settlePrice, l.strike, 0.05e18);
    }
}
