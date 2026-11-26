// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base} from "test/helpers/Base.t.sol";
import {Exchange} from "src/Exchange.sol";
import {Eip712} from "src/lib/Eip712.sol";

contract BatchTest is Base {
    uint64 st;

    function setUp() public override {
        super.setUp();
        lid = _register(_cfg());
        st = ex.getLaunch(lid).settleTime;
        _deposit(alice, 10 ether);
        _deposit(bob, 10 ether);
        _deposit(carol, 10 ether);
    }

    function _pos(address u) internal view returns (uint128 up, uint128 down) {
        return ex.position(lid, u);
    }

    function test_mintFill() public {
        Eip712.Order memory maker = _o(alice, 0, 0, 60, 1e18);
        Eip712.Order memory taker = _o(bob, 1, 0, 45, 1e18);
        bytes32 mh = ex.orderHash(maker);
        bytes32 th = ex.orderHash(taker);
        vm.expectEmit(address(ex));
        emit Exchange.Trade(lid, th, mh, 1, 60, 1e18);
        vm.expectEmit(address(ex));
        emit Exchange.BatchSubmitted(1, uint64(vm.getBlockTimestamp()), 1);
        _fill(taker, maker, 1, 1e18);
        assertEq(ex.balanceOf(alice), 10 ether - 0.6 ether);
        assertEq(ex.balanceOf(bob), 10 ether - 0.4 ether);
        assertEq(ex.getLaunch(lid).pairs, 1e18);
        (uint128 up, uint128 down) = _pos(alice);
        assertEq(up, 1e18);
        assertEq(down, 0);
        (up, down) = _pos(bob);
        assertEq(up, 0);
        assertEq(down, 1e18);
        assertEq(ex.filled(mh), 1e18);
        assertEq(ex.filled(th), 1e18);
        assertEq(ex.projectedRaised(lid), 0.1 ether);
    }

    function test_transferFill() public {
        _mint(alice, bob, 50, 2e18);
        // Bob sells Down @50 (maker); Carol buys Down @55 (taker) and pays the maker price
        _fill(_o(carol, 1, 0, 55, 1e18), _o(bob, 1, 1, 50, 1e18), 0, 1e18);
        assertEq(ex.balanceOf(carol), 10 ether - 0.5 ether);
        assertEq(ex.balanceOf(bob), 10 ether - 1 ether + 0.5 ether);
        (, uint128 down) = _pos(carol);
        assertEq(down, 1e18);
        (, down) = _pos(bob);
        assertEq(down, 1e18);
        // taker sell: Bob sells Down @40 into Carol's resting bid @45 -> Bob gets 0.45
        _fill(_o(bob, 1, 1, 40, 1e18), _o(carol, 1, 0, 45, 1e18), 0, 1e18);
        assertEq(ex.balanceOf(bob), 10 ether - 1 ether + 0.5 ether + 0.45 ether);
        (, down) = _pos(carol);
        assertEq(down, 2e18);
        assertEq(ex.getLaunch(lid).pairs, 2e18);
    }

    function test_mergeFill() public {
        _mint(alice, bob, 50, 2e18);
        _fill(_o(bob, 1, 1, 25, 1e18), _o(alice, 0, 1, 70, 1e18), 2, 1e18);
        assertEq(ex.balanceOf(alice), 10 ether - 1 ether + 0.7 ether);
        assertEq(ex.balanceOf(bob), 10 ether - 1 ether + 0.3 ether);
        assertEq(ex.getLaunch(lid).pairs, 1e18);
        (uint128 up,) = _pos(alice);
        assertEq(up, 1e18);
        (, uint128 down) = _pos(bob);
        assertEq(down, 1e18);
    }

    function test_limitViolationsRevert() public {
        _mint(alice, bob, 50, 2e18);
        // transfer, taker buy: pm 55 > pt 54
        _expectFillRevert(_o(carol, 1, 0, 54, 1e18), _o(bob, 1, 1, 55, 1e18), 0, 1e18, Exchange.BadCross.selector);
        // transfer, taker sell: pm 44 < pt 45
        _expectFillRevert(_o(bob, 1, 1, 45, 1e18), _o(carol, 1, 0, 44, 1e18), 0, 1e18, Exchange.BadCross.selector);
        // transfer with the same side / different outcome
        _expectFillRevert(_o(carol, 1, 0, 60, 1e18), _o(bob, 1, 0, 50, 1e18), 0, 1e18, Exchange.BadCross.selector);
        _expectFillRevert(_o(carol, 0, 0, 60, 1e18), _o(bob, 1, 1, 50, 1e18), 0, 1e18, Exchange.BadCross.selector);
        // mint: 60 + 39 = 99 < 100
        _expectFillRevert(_o(carol, 1, 0, 39, 1e18), _o(alice, 0, 0, 60, 1e18), 1, 1e18, Exchange.BadCross.selector);
        // mint with a sell order
        _expectFillRevert(_o(carol, 1, 1, 50, 1e18), _o(alice, 0, 0, 60, 1e18), 1, 1e18, Exchange.BadCross.selector);
        // merge: 70 + 31 = 101 > 100
        _expectFillRevert(_o(bob, 1, 1, 31, 1e18), _o(alice, 0, 1, 70, 1e18), 2, 1e18, Exchange.BadCross.selector);
        // unknown kind
        _expectFillRevert(_o(bob, 1, 1, 30, 1e18), _o(alice, 0, 1, 70, 1e18), 3, 1e18, Exchange.BadFill.selector);
        // boundaries pass: mint 60 + 40, merge 70 + 30
        _fill(_o(carol, 1, 0, 40, 1e18), _o(alice, 0, 0, 60, 1e18), 1, 1e18);
        _fill(_o(bob, 1, 1, 30, 1e18), _o(alice, 0, 1, 70, 1e18), 2, 1e18);
    }

    function test_insufficientFundsRevert() public {
        // Carol has no Down shares to sell
        _expectFillRevert(
            _o(alice, 1, 0, 50, 1e18), _o(carol, 1, 1, 50, 1e18), 0, 1e18, Exchange.InsufficientShares.selector
        );
        // Bob cannot pay for 100 shares
        _expectFillRevert(
            _o(bob, 1, 0, 50, 100e18), _o(alice, 0, 0, 50, 100e18), 1, 100e18, Exchange.InsufficientBalance.selector
        );
    }

    /// Checked at block.timestamp: a fill landing at or after settleTime is skipped, the rest of the batch lands.
    function test_fillAtOrAfterSettleSkipped() public {
        Exchange.Batch memory b =
            _batch(_orders2(_s(_o(bob, 1, 0, 50, 1e18)), _s(_o(alice, 0, 0, 50, 1e18))), _fills1(0, 1, 1, 1e18));
        vm.warp(st - 1);
        _submit(b);
        assertEq(ex.getLaunch(lid).pairs, 1e18);
        b = _batch(_orders2(_s(_o(bob, 1, 0, 50, 1e18)), _s(_o(alice, 0, 0, 50, 1e18))), _fills1(0, 1, 1, 1e18));
        vm.warp(st);
        vm.expectEmit(address(ex));
        emit Exchange.FillSkipped(2, 0, address(0));
        _submit(b);
        assertEq(ex.batchCount(), 2);
        assertEq(ex.getLaunch(lid).pairs, 1e18);
        assertEq(ex.filled(ex.orderHash(b.orders[0].order)), 0);
    }

    function test_rejectsBadOrders() public {
        // order amount not a multiple of 1e16
        _expectFillRevert(_o(bob, 1, 0, 50, 1e16 + 1), _o(alice, 0, 0, 50, 1e18), 1, 1e16, Exchange.BadOrder.selector);
        // fill amount not a multiple of 1e16, or zero
        _expectFillRevert(_o(bob, 1, 0, 50, 1e18), _o(alice, 0, 0, 50, 1e18), 1, 1e16 + 1, Exchange.BadAmount.selector);
        _expectFillRevert(_o(bob, 1, 0, 50, 1e18), _o(alice, 0, 0, 50, 1e18), 1, 0, Exchange.BadAmount.selector);
        // price 0 and 100
        _expectFillRevert(_o(bob, 1, 0, 0, 1e18), _o(alice, 0, 0, 100, 1e18), 1, 1e18, Exchange.BadOrder.selector);
        _expectFillRevert(_o(bob, 1, 0, 50, 1e18), _o(alice, 0, 0, 100, 1e18), 1, 1e18, Exchange.BadOrder.selector);
        // round != 0
        Eip712.Order memory r1 = _o(bob, 1, 0, 50, 1e18);
        r1.round = 1;
        _expectFillRevert(r1, _o(alice, 0, 0, 50, 1e18), 1, 1e18, Exchange.BadOrder.selector);
        // different launches
        Eip712.Order memory other = _o(bob, 1, 0, 50, 1e18);
        other.launchId = lid + 1;
        _expectFillRevert(other, _o(alice, 0, 0, 50, 1e18), 1, 1e18, Exchange.BadFill.selector);

        // an expired trading key
        uint256 keyPk = 0x4E7;
        vm.prank(bob);
        ex.authorizeKey(vm.addr(keyPk), uint64(vm.getBlockTimestamp() + 10));
        Eip712.Order memory kb = _o(bob, 1, 0, 50, 1e18);
        Exchange.Batch memory b =
            _batch(_orders2(_sign(kb, keyPk), _s(_o(alice, 0, 0, 50, 1e18))), _fills1(0, 1, 1, 1e18));
        uint256 t0 = vm.getBlockTimestamp();
        vm.warp(t0 + 11);
        vm.prank(operator);
        vm.expectRevert(Exchange.BadSignature.selector);
        ex.submitBatch(b);
        // ...which works while the key is live
        vm.warp(t0 + 10); // key expiry == block.timestamp is still valid
        _submit(b);

        // overfill: two fills summing above order.amount
        Exchange.SignedOrder[] memory os = new Exchange.SignedOrder[](3);
        os[0] = _s(_o(alice, 0, 0, 50, 1e18));
        os[1] = _s(_o(bob, 1, 0, 50, 1e18));
        os[2] = _s(_o(carol, 1, 0, 50, 1e18));
        Exchange.Fill[] memory fs = new Exchange.Fill[](2);
        fs[0] = Exchange.Fill(1, 0, 1, 0.6e18);
        fs[1] = Exchange.Fill(2, 0, 1, 0.5e18);
        b = _batch(os, fs);
        vm.prank(operator);
        vm.expectRevert(Exchange.Overfill.selector);
        ex.submitBatch(b);
        fs[1].amount = 0.4e18;
        _submit(b);
        // replaying the same fills later overfills
        vm.prank(operator);
        vm.expectRevert(Exchange.Overfill.selector);
        ex.submitBatch(b);

        // a cancelled order
        Eip712.Order memory c = _o(alice, 0, 0, 50, 1e18);
        vm.prank(alice);
        ex.cancelOrder(c);
        _expectFillRevert(_o(bob, 1, 0, 50, 1e18), c, 1, 1e18, Exchange.OrderDead.selector);
        // a self-referencing fill
        b = _batch(_orders2(_s(_o(bob, 1, 0, 50, 1e18)), _s(_o(alice, 0, 0, 50, 1e18))), _fills1(0, 0, 1, 1e18));
        vm.prank(operator);
        vm.expectRevert(Exchange.BadFill.selector);
        ex.submitBatch(b);
    }

    function test_withdrawPaysMinOfBalance() public {
        vm.deal(address(0xD00D), 3 ether);
        _depositFrom(address(0xD00D), 3 ether);
        vm.prank(address(0xD00D));
        uint64 idx = ex.requestWithdraw(5 ether);
        Exchange.Batch memory b = _emptyBatch(idx + 1);
        vm.expectEmit(address(ex));
        emit Exchange.WithdrawPaid(idx, address(0xD00D), 5 ether, 3 ether);
        _submit(b);
        assertEq(address(0xD00D).balance, 3 ether);
        assertEq(ex.balanceOf(address(0xD00D)), 0);
        assertEq(ex.withdrawProcessed(), idx + 1);
        // beyond the queue reverts
        b = _emptyBatch(idx + 2);
        vm.prank(operator);
        vm.expectRevert(Exchange.BadIndex.selector);
        ex.submitBatch(b);
    }

    function _depositFrom(address u, uint256 amt) internal {
        vm.prank(u);
        ex.deposit{value: amt}(amt);
    }

    function test_anyoneCanSubmit() public {
        vm.prank(alice);
        ex.submitBatch(_emptyBatch(0));
        assertEq(ex.batchCount(), 1);
        vm.prank(bob);
        ex.submitBatch(_emptyBatch(0));
        assertEq(ex.batchCount(), 2);
    }

    function test_keyAuthInBatch() public {
        uint256 keyPk = 0x4E7;
        address key = vm.addr(keyPk);
        bytes32 h = keccak256(
            abi.encodePacked(
                "\x19\x01",
                ex.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(Eip712.AUTHORIZE_KEY_TYPEHASH, bob, key, uint64(vm.getBlockTimestamp() + 100), uint64(1))
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BOB_PK, h);
        Exchange.Batch memory b = _batch(
            _orders2(_sign(_o(bob, 1, 0, 50, 1e18), keyPk), _s(_o(alice, 0, 0, 50, 1e18))), _fills1(0, 1, 1, 1e18)
        );
        b.keys = new Exchange.KeyAuth[](1);
        b.keys[0] = Exchange.KeyAuth(bob, key, uint64(vm.getBlockTimestamp() + 100), 1, abi.encodePacked(r, s, v));
        _submit(b);
        assertEq(ex.keyExpiry(bob, key), vm.getBlockTimestamp() + 100);
        assertEq(ex.getLaunch(lid).pairs, 1e18);
    }

    function test_solvencyInvariant() public {
        _mint(alice, bob, 55, 3e18);
        _mint(carol, alice, 40, 2e18);
        _fill(_o(carol, 1, 0, 60, 1e18), _o(bob, 1, 1, 52, 1e18), 0, 1e18);
        _fill(_o(alice, 0, 1, 45, 1e18), _o(carol, 0, 0, 47, 1e18), 0, 1e18);
        _fill(_o(carol, 1, 1, 30, 1e18), _o(alice, 0, 1, 66, 1e18), 2, 1e18);
        vm.prank(alice);
        ex.requestWithdraw(4 ether);
        vm.prank(bob);
        ex.requestWithdraw(100 ether);
        _submit(_emptyBatch(2));
        uint256 sumBal = ex.balanceOf(alice) + ex.balanceOf(bob) + ex.balanceOf(carol);
        uint256 sumPending = ex.pendingPayout(alice) + ex.pendingPayout(bob) + ex.pendingPayout(carol);
        assertEq(address(ex).balance, sumBal + sumPending + ex.getLaunch(lid).pairs);
        // and positions are balanced: total Up == total Down == pairs
        uint256 ups;
        uint256 downs;
        address[3] memory us = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            (uint128 u, uint128 d) = _pos(us[i]);
            ups += u;
            downs += d;
        }
        assertEq(ups, ex.getLaunch(lid).pairs);
        assertEq(downs, ex.getLaunch(lid).pairs);
    }
}
