// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Exchange} from "src/Exchange.sol";
import {MockFeed} from "test/helpers/MockFeed.sol";
import {Eip712} from "src/lib/Eip712.sol";

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
    uint256 constant DAVE_PK = 0xDA4E;
    address dave = vm.addr(DAVE_PK);

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        ex = new Exchange(owner, address(0));
        feed = new MockFeed();
        vm.startPrank(owner);
        ex.setFactory(address(this));
        ex.setFeed(address(feed), true);
        vm.stopPrank();
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
        vm.deal(dave, 100 ether);
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

    // ---- orders and batches ----

    uint256 lid; // launch the order helpers target
    uint64 nonceCtr;

    function _pk(address u) internal view returns (uint256) {
        if (u == alice) return ALICE_PK;
        if (u == bob) return BOB_PK;
        if (u == carol) return CAROL_PK;
        if (u == dave) return DAVE_PK;
        revert("unknown user");
    }

    function _o(address u, uint8 outcome, uint8 side, uint8 price, uint128 amount)
        internal
        returns (Eip712.Order memory)
    {
        return Eip712.Order(u, lid, 0, outcome, side, price, amount, uint64(block.timestamp + 1 days), ++nonceCtr);
    }

    function _sign(Eip712.Order memory o, uint256 pk) internal view returns (Exchange.SignedOrder memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, ex.orderHash(o));
        return Exchange.SignedOrder(o, abi.encodePacked(r, s, v));
    }

    function _s(Eip712.Order memory o) internal view returns (Exchange.SignedOrder memory) {
        return _sign(o, _pk(o.owner));
    }

    function _orders2(Exchange.SignedOrder memory a, Exchange.SignedOrder memory b)
        internal
        pure
        returns (Exchange.SignedOrder[] memory os)
    {
        os = new Exchange.SignedOrder[](2);
        os[0] = a;
        os[1] = b;
    }

    function _fills1(uint16 taker, uint16 maker, uint8 kind, uint128 amount)
        internal
        pure
        returns (Exchange.Fill[] memory fs)
    {
        fs = new Exchange.Fill[](1);
        fs[0] = Exchange.Fill(taker, maker, kind, amount);
    }

    function _batch(uint64 ts, Exchange.SignedOrder[] memory os, Exchange.Fill[] memory fs)
        internal
        view
        returns (Exchange.Batch memory b)
    {
        b.ts = ts;
        b.orders = os;
        b.fills = fs;
        b.withdrawTo = ex.withdrawProcessed();
    }

    function _submit(Exchange.Batch memory b) internal {
        vm.prank(operator);
        ex.submitBatch(b);
    }

    /// One fill between two orders (index 0 taker, 1 maker), stamped now.
    function _fill(Eip712.Order memory taker, Eip712.Order memory maker, uint8 kind, uint128 amount) internal {
        _submit(_batch(uint64(vm.getBlockTimestamp()), _orders2(_s(taker), _s(maker)), _fills1(0, 1, kind, amount)));
    }

    function _expectFillRevert(
        Eip712.Order memory taker,
        Eip712.Order memory maker,
        uint8 kind,
        uint128 amount,
        bytes4 sel
    ) internal {
        Exchange.Batch memory b =
            _batch(uint64(vm.getBlockTimestamp()), _orders2(_s(taker), _s(maker)), _fills1(0, 1, kind, amount));
        vm.prank(operator);
        vm.expectRevert(sel);
        ex.submitBatch(b);
    }

    /// Mint `amount` pairs: `up` buys Up at `pu`, `down` buys Down at 100 - pu.
    function _mint(address up, address down, uint8 pu, uint128 amount) internal {
        _fill(_o(down, 1, 0, 100 - pu, amount), _o(up, 0, 0, pu, amount), 1, amount);
    }

    function _deposit(address u, uint256 amt) internal {
        vm.prank(u);
        ex.deposit{value: amt}(amt);
    }

    function _warpTo(uint256 t) internal {
        vm.warp(t);
    }

    function _emptyBatch(uint64 ts, uint64 withdrawTo) internal pure returns (Exchange.Batch memory b) {
        b.ts = ts;
        b.withdrawTo = withdrawTo;
    }
}
