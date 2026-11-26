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

    // ---- approve-only trading: no deposit, funds pulled from / paid to the wallet ----

    function _approveOnly(address u, uint256 amt) internal {
        usd.mint(u, amt);
        vm.prank(u);
        usd.approve(address(ex), type(uint256).max);
    }

    function _usdLaunch() internal returns (uint256 id) {
        id = _register(_cfg());
        lid = id;
    }

    function test_tradeFromWalletWithoutDeposit() public {
        _usdLaunch();
        _approveOnly(carol, 10 ether);
        _approveOnly(dave, 10 ether);
        uint256 exBefore = usd.balanceOf(address(ex));
        _mint(carol, dave, 60, 5e18); // carol pays 3, dave pays 2
        assertEq(usd.balanceOf(carol), 7 ether);
        assertEq(usd.balanceOf(dave), 8 ether);
        assertEq(usd.balanceOf(address(ex)) - exBefore, 5 ether, "pairs fully collateralized");
        assertEq(ex.balanceOf(carol), 0);
        (uint128 up,) = _pos(carol);
        assertEq(up, 5e18);
    }

    function test_internalBalanceSpentFirst() public {
        _usdLaunch();
        _approveOnly(alice, 10 ether); // alice also has 50 deposited
        _approveOnly(carol, 10 ether);
        _mint(alice, carol, 50, 4e18);
        assertEq(ex.balanceOf(alice), 48 ether, "internal debited");
        assertEq(usd.balanceOf(alice), 10 ether, "wallet untouched");
    }

    function test_saleProceedsGoToWallet() public {
        _usdLaunch();
        _approveOnly(carol, 10 ether);
        _approveOnly(dave, 10 ether);
        _mint(carol, dave, 50, 4e18); // carol: 4 Up, wallet 8
        // carol sells 4 Up at 70 to dave (dave is taker buying Up)
        _fill(_o(dave, 0, 0, 70, 4e18), _o(carol, 0, 1, 70, 4e18), 0, 4e18);
        assertEq(usd.balanceOf(carol), 8 ether + 2.8 ether);
        assertEq(usd.balanceOf(dave), 8 ether - 2.8 ether);
        assertEq(ex.balanceOf(carol), 0);
    }

    function test_mergeProceedsGoToWallet() public {
        _usdLaunch();
        _approveOnly(carol, 10 ether);
        _approveOnly(dave, 10 ether);
        _mint(carol, dave, 50, 4e18);
        // carol sells Up at 40 (maker), dave sells Down at 60 (taker)
        _fill(_o(dave, 1, 1, 60, 4e18), _o(carol, 0, 1, 40, 4e18), 2, 4e18);
        assertEq(usd.balanceOf(carol), 8 ether + 1.6 ether);
        assertEq(usd.balanceOf(dave), 8 ether + 2.4 ether);
    }

    function test_redeemPaysWallet() public {
        uint256 id = _usdLaunch();
        _approveOnly(carol, 10 ether);
        _approveOnly(dave, 10 ether);
        _mint(carol, dave, 50, 4e18);
        _settle(id, 1e18); // below strike: Down wins; raise 0.4 < target -> failed, winner gets 1.00
        vm.warp(block.timestamp + 15);
        ex.resolve(id);
        address[] memory us = new address[](2);
        us[0] = carol;
        us[1] = dave;
        ex.redeem(id, us);
        assertEq(usd.balanceOf(dave), 8 ether + 4 ether);
        assertEq(ex.balanceOf(dave), 0);
    }

    function test_unfundedFillSkippedOthersSettle() public {
        _usdLaunch();
        _approveOnly(carol, 10 ether);
        _approveOnly(dave, 10 ether);
        // carol revokes before the batch lands
        vm.prank(carol);
        usd.approve(address(ex), 0);
        Exchange.SignedOrder[] memory os = new Exchange.SignedOrder[](4);
        os[0] = _s(_o(dave, 1, 0, 50, 2e18));
        os[1] = _s(_o(carol, 0, 0, 50, 2e18));
        os[2] = _s(_o(bob, 1, 0, 50, 2e18));
        os[3] = _s(_o(alice, 0, 0, 50, 2e18));
        Exchange.Fill[] memory fs = new Exchange.Fill[](2);
        fs[0] = Exchange.Fill(0, 1, 1, 2e18);
        fs[1] = Exchange.Fill(2, 3, 1, 2e18);
        Exchange.Batch memory b = _batch(uint64(block.timestamp), os, fs);
        vm.expectEmit(address(ex));
        emit Exchange.FillSkipped(1, 0, carol);
        _submit(b);
        assertEq(usd.balanceOf(dave), 10 ether, "skipped fill moved nothing");
        assertEq(ex.filled(ex.orderHash(os[0].order)), 0);
        assertEq(ex.filled(ex.orderHash(os[1].order)), 0);
        assertEq(ex.filled(ex.orderHash(os[3].order)), 2e18, "other fill settled");
        assertEq(ex.balanceOf(alice), 49 ether);
    }

    function test_sameOwnerMintNeedsBothLegs() public {
        _usdLaunch();
        _approveOnly(carol, 3 ether); // needs 4 for both legs of 4 pairs at 50/50
        Exchange.Batch memory b = _batch(
            uint64(block.timestamp),
            _orders2(_s(_o(carol, 1, 0, 50, 4e18)), _s(_o(carol, 0, 0, 50, 4e18))),
            _fills1(0, 1, 1, 4e18)
        );
        vm.expectEmit(address(ex));
        emit Exchange.FillSkipped(1, 0, carol);
        _submit(b);
        assertEq(usd.balanceOf(carol), 3 ether);
    }

    function test_fundsView() public {
        _approveOnly(carol, 7 ether);
        usd.mint(dave, 5 ether);
        vm.prank(dave);
        usd.approve(address(ex), 2 ether);
        address[] memory us = new address[](3);
        us[0] = alice;
        us[1] = carol;
        us[2] = dave;
        uint256[] memory f = ex.funds(us);
        assertEq(f[0], 50 ether);
        assertEq(f[1], 7 ether);
        assertEq(f[2], 2 ether, "capped by allowance");
    }

    function _pos(address u) internal view returns (uint128 up, uint128 down) {
        (up, down) = ex.position(lid, u);
    }
}
