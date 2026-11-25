// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ISingleFeed} from "src/interfaces/ISingleFeed.sol";

interface IAtlasAuth {
    function isAuthorizedCaller(address) external view returns (bool);
}

/// A contract reader, standing in for the Exchange.
contract FeedReader {
    function read(address feed) external view returns (int256 a) {
        (, a,,,) = ISingleFeed(feed).latestRoundData();
    }
}

/// Atlas SingleFeed facts the contracts and the dev script rely on:
///  - state lives in storage slot 0x32: updatedAt(uint48) | startedAt(uint48) | answer(uint80);
///  - `latestRoundData` reverts `OnlyAuthorizedCallerAllowed()` unless msg.sender == tx.origin or msg.sender is an
///    authorized caller; the authorized-caller mapping is at slot 1 (`keccak256(abi.encode(caller, 1)) = 1`).
contract FeedForkTest is Test {
    address constant BTCB = 0xe20536BC715AaC6560394e33deB66ed205AEeC33;
    address constant BNB = 0xb3d1614Bf894E68ADd1EA50CA250C152BAd5256F;
    address constant ANKR = 0xEd2ce62b7BFDD31876B1e956a672e8fBE8b29403;

    function setUp() public {
        string memory rpc = vm.envOr("BSC_TESTNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
    }

    function _check(address feed) internal {
        uint256 w = uint256(vm.load(feed, bytes32(uint256(0x32))));
        uint256 answer = uint80(w);
        uint256 startedAt = uint48(w >> 80);
        uint256 updatedAt = uint48(w >> 128);
        // read as an EOA (sender == origin), which needs no authorization
        vm.prank(address(0xC0DE0009), address(0xC0DE0009));
        (, int256 a, uint256 s, uint256 u,) = ISingleFeed(feed).latestRoundData();
        assertGt(a, 0);
        assertEq(answer, uint256(a), "answer");
        assertEq(startedAt, s, "startedAt");
        assertEq(updatedAt, u, "updatedAt");

        // writing the slot drives latestRoundData (what the feed relay and the fork tests rely on)
        uint256 nw = (uint256(block.timestamp) << 128) | (uint256(block.timestamp) << 80) | 12_345e18;
        vm.store(feed, bytes32(uint256(0x32)), bytes32(nw));
        vm.prank(address(0xC0DE0009), address(0xC0DE0009));
        (, a,, u,) = ISingleFeed(feed).latestRoundData();
        assertEq(a, 12_345e18);
        assertEq(u, block.timestamp);
    }

    function test_slot32Layout() public {
        _check(BTCB);
        _check(BNB);
        _check(ANKR);
    }

    function test_contractReadsNeedAuthorization() public {
        FeedReader r = new FeedReader();
        address[3] memory feeds = [BTCB, BNB, ANKR];
        for (uint256 i; i < 3; ++i) {
            vm.expectRevert(bytes4(keccak256("OnlyAuthorizedCallerAllowed()")));
            r.read(feeds[i]);
            vm.store(feeds[i], keccak256(abi.encode(address(r), uint256(1))), bytes32(uint256(1)));
            assertTrue(IAtlasAuth(feeds[i]).isAuthorizedCaller(address(r)));
            assertGt(r.read(feeds[i]), 0);
        }
    }
}
