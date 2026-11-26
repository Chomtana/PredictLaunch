// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Base} from "test/helpers/Base.t.sol";
import {Exchange} from "src/Exchange.sol";
import {MockRail} from "test/helpers/MockRail.sol";

/// Question launches (Cournot): registration, resolver proposals, owner overrides, resolution and payouts.
contract QuestionTest is Base {
    MockRail rail;
    address resolver = makeAddr("resolver");
    string constant Q = "Will it rain in Paris on 2026-12-01?";
    bytes32 constant EVIDENCE = keccak256("cournot evidence");

    function setUp() public override {
        super.setUp();
        vm.prank(owner);
        ex.setResolver(resolver);
        _deposit(alice, 50 ether);
        _deposit(bob, 50 ether);
        _deposit(carol, 50 ether);
    }

    function _qcfg() internal view returns (Exchange.LaunchConfig memory c) {
        c = _cfg();
        c.feed = address(0);
        c.strike = 0;
        c.question = Q;
        c.marketId = 42;
    }

    function _newQ(uint16 cut) internal returns (uint256 id) {
        rail = new MockRail(ex);
        Exchange.LaunchConfig memory c = _qcfg();
        c.cutBps = cut;
        id = ex.registerLaunch(address(rail), alice, address(rail.token()), c);
        lid = id;
    }

    function _newPrice() internal returns (uint256 id) {
        id = _register(_cfg());
        lid = id;
    }

    function _st(uint256 id) internal view returns (uint256) {
        return ex.getLaunch(id).settleTime;
    }

    function _propose(uint256 id, uint8 outcome) internal {
        vm.prank(resolver);
        ex.proposeOutcome(id, outcome, EVIDENCE);
    }

    function _override(uint256 id, uint8 outcome) internal {
        vm.prank(owner);
        ex.overrideOutcome(id, outcome, EVIDENCE);
    }

    function _redeem(uint256 id, address u) internal {
        address[] memory us = new address[](1);
        us[0] = u;
        ex.redeem(id, us);
    }

    function _expectRegisterRevert(Exchange.LaunchConfig memory c, bytes4 sel) internal {
        vm.expectRevert(sel);
        ex.registerLaunch(RAIL, alice, TOKEN, c);
    }

    function _str(uint256 n) internal pure returns (string memory) {
        bytes memory b = new bytes(n);
        for (uint256 i; i < n; ++i) {
            b[i] = "a";
        }
        return string(b);
    }

    // ---- admin ----

    function test_adminDefaultsAndSetters() public {
        assertEq(ex.QUESTION_DEADLINE(), 7 days);
        assertEq(ex.challengeWindow(), 3600);
        assertEq(ex.resolver(), resolver);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        ex.setResolver(alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        ex.setChallengeWindow(10);

        vm.startPrank(owner);
        vm.expectEmit(address(ex));
        emit Exchange.ResolverSet(bob);
        ex.setResolver(bob);
        assertEq(ex.resolver(), bob);

        vm.expectRevert(Exchange.BadConfig.selector);
        ex.setChallengeWindow(7 days + 1);
        vm.expectEmit(address(ex));
        emit Exchange.ChallengeWindowSet(7 days);
        ex.setChallengeWindow(7 days);
        assertEq(ex.challengeWindow(), 7 days);
        ex.setChallengeWindow(0);
        assertEq(ex.challengeWindow(), 0);
        vm.stopPrank();
    }

    // ---- registration ----

    function test_registerQuestionValidates() public {
        Exchange.LaunchConfig memory c = _qcfg();
        c.feed = address(feed); // a question launch must not name a feed
        _expectRegisterRevert(c, Exchange.BadConfig.selector);

        c = _qcfg();
        c.strike = 1;
        _expectRegisterRevert(c, Exchange.BadConfig.selector);

        c = _qcfg();
        c.question = _str(281);
        _expectRegisterRevert(c, Exchange.BadConfig.selector);

        // an empty question is a price launch, which needs an enabled feed
        c = _qcfg();
        c.question = "";
        _expectRegisterRevert(c, Exchange.FeedNotEnabled.selector);

        // a price launch must carry marketId 0
        c = _cfg();
        c.marketId = 1;
        _expectRegisterRevert(c, Exchange.BadConfig.selector);

        // the shared rules still apply
        c = _qcfg();
        c.settleTime = uint64(block.timestamp + 59);
        _expectRegisterRevert(c, Exchange.BadDuration.selector);
        c = _qcfg();
        c.cutBps = 1200;
        _expectRegisterRevert(c, Exchange.BadCut.selector);
        c = _qcfg();
        c.target = 2.15 ether - 1;
        _expectRegisterRevert(c, Exchange.TargetTooLow.selector);
        c = _qcfg();
        c.name = "";
        _expectRegisterRevert(c, Exchange.BadConfig.selector);
        c = _qcfg();
        c.symbol = "12345678901";
        _expectRegisterRevert(c, Exchange.BadConfig.selector);

        // bounds inclusive: 1 and 280 bytes, marketId 0 allowed (no Cournot match)
        c = _qcfg();
        c.question = "?";
        c.marketId = 0;
        assertEq(_register(c), 0);
        c.question = _str(280);
        assertEq(_register(c), 1);
        assertEq(ex.getQuestion(1).question, _str(280));
    }

    function test_registerQuestionEmitsAndStores() public {
        Exchange.LaunchConfig memory c = _qcfg();
        vm.expectEmit(address(ex));
        emit Exchange.LaunchCreated(
            0, alice, RAIL, TOKEN, address(0), 0, c.settleTime, 1000, 2.15 ether, "Moon", "MOON", "ipfs://moon"
        );
        vm.expectEmit(address(ex));
        emit Exchange.QuestionSet(0, Q, 42);
        assertEq(_register(c), 0);

        assertTrue(ex.isQuestion(0));
        Exchange.QuestionView memory q = ex.getQuestion(0);
        assertEq(q.question, Q);
        assertEq(q.marketId, 42);
        assertFalse(q.proposed);
        assertEq(q.proposedOutcome, 0);
        assertEq(q.proposedAt, 0);
        assertEq(q.evidenceHash, bytes32(0));
        assertFalse(q.final_);

        Exchange.LaunchView memory l = ex.getLaunch(0);
        assertEq(l.feed, address(0));
        assertEq(l.strike, 0);
        assertEq(l.settleTime, c.settleTime);
        assertEq(l.status, 0);

        // a price launch: no question data, and no QuestionSet
        vm.recordLogs();
        uint256 p = _register(_cfg());
        assertEq(vm.getRecordedLogs().length, 1, "only LaunchCreated");
        assertFalse(ex.isQuestion(p));
        q = ex.getQuestion(p);
        assertEq(bytes(q.question).length, 0);
        assertEq(q.marketId, 0);
        assertFalse(ex.isQuestion(99));
    }

    function test_snapshotOnQuestionReverts() public {
        uint256 id = _newQ(1000);
        vm.warp(_st(id));
        vm.expectRevert(Exchange.NotPriceLaunch.selector);
        ex.snapshot(id);
    }

    // ---- trading ----

    function test_tradesLikeAPriceLaunchUntilSettleTime() public {
        uint256 id = _newQ(2500);
        assertTrue(ex.isTradable(id, uint64(vm.getBlockTimestamp())));
        _mint(alice, bob, 60, 10e18); // alice YES @60, bob NO @40
        (uint128 up, uint128 down) = ex.position(id, alice);
        assertEq(up, 10e18);
        assertEq(down, 0);
        (up, down) = ex.position(id, bob);
        assertEq(down, 10e18);
        assertEq(ex.balanceOf(alice), 44 ether);
        assertEq(ex.balanceOf(bob), 46 ether);
        // carol buys 2 YES from alice
        _fill(_o(carol, 0, 0, 55, 2e18), _o(alice, 0, 1, 55, 2e18), 0, 2e18);
        (up,) = ex.position(id, carol);
        assertEq(up, 2e18);
        assertEq(ex.getLaunch(id).pairs, 10e18);
        assertEq(ex.projectedRaised(id), 2.5 ether);

        vm.warp(_st(id));
        assertFalse(ex.isTradable(id, uint64(vm.getBlockTimestamp())));
        _expectFillRevert(_o(carol, 0, 0, 55, 1e18), _o(alice, 0, 1, 55, 1e18), 0, 1e18, Exchange.NotTradable.selector);
    }

    // ---- proposeOutcome / overrideOutcome access ----

    function test_proposeAccess() public {
        uint256 id = _newQ(1000);
        uint256 st = _st(id);

        vm.warp(st + 15);
        vm.prank(alice);
        vm.expectRevert(Exchange.NotResolver.selector);
        ex.proposeOutcome(id, 0, EVIDENCE);

        vm.warp(st + 14);
        vm.prank(resolver);
        vm.expectRevert(Exchange.TooEarly.selector);
        ex.proposeOutcome(id, 0, EVIDENCE);

        vm.warp(st + 15);
        vm.prank(resolver);
        vm.expectRevert(Exchange.BadOutcome.selector);
        ex.proposeOutcome(id, 3, EVIDENCE);

        vm.expectEmit(address(ex));
        emit Exchange.OutcomeProposed(id, 1, EVIDENCE, resolver, false);
        _propose(id, 1);
        Exchange.QuestionView memory q = ex.getQuestion(id);
        assertTrue(q.proposed);
        assertEq(q.proposedOutcome, 1);
        assertEq(q.proposedAt, st + 15);
        assertEq(q.evidenceHash, EVIDENCE);
        assertFalse(q.final_);
        assertEq(q.question, Q);

        vm.prank(resolver);
        vm.expectRevert(Exchange.AlreadyProposed.selector);
        ex.proposeOutcome(id, 0, EVIDENCE);

        // a price launch
        uint256 p = _newPrice();
        vm.warp(_st(p) + 15);
        vm.prank(resolver);
        vm.expectRevert(Exchange.NotQuestionLaunch.selector);
        ex.proposeOutcome(p, 0, EVIDENCE);

        vm.prank(resolver);
        vm.expectRevert(Exchange.UnknownLaunch.selector);
        ex.proposeOutcome(99, 0, EVIDENCE);
    }

    function test_proposeAfterResolvedReverts() public {
        uint256 id = _newQ(1000);
        vm.warp(_st(id) + 7 days + 1);
        ex.resolve(id); // void, nobody proposed
        vm.prank(resolver);
        vm.expectRevert(Exchange.AlreadyResolved.selector);
        ex.proposeOutcome(id, 0, EVIDENCE);
        vm.prank(owner);
        vm.expectRevert(Exchange.AlreadyResolved.selector);
        ex.overrideOutcome(id, 0, EVIDENCE);
    }

    function test_overrideAccess() public {
        uint256 id = _newQ(1000);
        uint256 st = _st(id);

        vm.warp(st + 15);
        vm.prank(resolver);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, resolver));
        ex.overrideOutcome(id, 0, EVIDENCE);

        vm.warp(st + 14);
        vm.prank(owner);
        vm.expectRevert(Exchange.TooEarly.selector);
        ex.overrideOutcome(id, 0, EVIDENCE);

        vm.warp(st + 15);
        vm.prank(owner);
        vm.expectRevert(Exchange.BadOutcome.selector);
        ex.overrideOutcome(id, 3, EVIDENCE);

        uint256 p = _newPrice();
        vm.warp(_st(p) + 15);
        vm.prank(owner);
        vm.expectRevert(Exchange.NotQuestionLaunch.selector);
        ex.overrideOutcome(p, 0, EVIDENCE);
    }

    // ---- resolve timing ----

    function test_resolveAfterChallengeWindow() public {
        uint256 id = _newQ(1000);
        uint256 st = _st(id);

        vm.warp(st + 14);
        vm.expectRevert(Exchange.TooEarly.selector);
        ex.resolve(id);

        vm.warp(st + 100);
        _propose(id, 0);
        vm.expectRevert(Exchange.TooEarly.selector);
        ex.resolve(id);
        vm.warp(st + 100 + 3600 - 1);
        vm.expectRevert(Exchange.TooEarly.selector);
        ex.resolve(id);

        vm.warp(st + 100 + 3600);
        ex.resolve(id);
        Exchange.LaunchView memory l = ex.getLaunch(id);
        assertTrue(l.resolved);
        assertEq(l.outcome, 0);
        vm.expectRevert(Exchange.AlreadyResolved.selector);
        ex.resolve(id);
    }

    function test_challengeWindowIsReadAtResolve() public {
        vm.prank(owner);
        ex.setChallengeWindow(120);
        uint256 id = _newQ(1000);
        uint256 st = _st(id);
        vm.warp(st + 15);
        _propose(id, 1);
        vm.warp(st + 15 + 119);
        vm.expectRevert(Exchange.TooEarly.selector);
        ex.resolve(id);
        vm.warp(st + 15 + 120);
        ex.resolve(id);
        assertEq(ex.getLaunch(id).outcome, 1);
    }

    function test_overrideReplacesProposalAndIsFinal() public {
        uint256 id = _newQ(1000);
        uint256 st = _st(id);
        vm.warp(st + 15);
        _propose(id, 0);

        vm.warp(st + 20);
        vm.expectEmit(address(ex));
        emit Exchange.OutcomeProposed(id, 1, EVIDENCE, owner, true);
        _override(id, 1);
        Exchange.QuestionView memory q = ex.getQuestion(id);
        assertTrue(q.proposed);
        assertTrue(q.final_);
        assertEq(q.proposedOutcome, 1);
        assertEq(q.proposedAt, st + 20);

        // a second override still replaces; the resolver cannot propose over it
        _override(id, 2);
        vm.prank(resolver);
        vm.expectRevert(Exchange.AlreadyProposed.selector);
        ex.proposeOutcome(id, 0, EVIDENCE);

        // resolvable immediately, no challenge window
        ex.resolve(id);
        assertEq(ex.getLaunch(id).outcome, 2);
        assertEq(ex.getLaunch(id).status, 3);
    }

    function test_overrideWithoutProposalResolvesImmediately() public {
        uint256 id = _newQ(1000);
        vm.warp(_st(id) + 15);
        _override(id, 0);
        ex.resolve(id);
        assertEq(ex.getLaunch(id).outcome, 0);
    }

    function test_noProposalVoidsAfterDeadline() public {
        uint256 id = _newQ(1000);
        _mint(alice, bob, 50, 30e18); // would graduate if settled
        uint256 st = _st(id);
        vm.warp(st + 7 days);
        vm.expectRevert(Exchange.TooEarly.selector);
        ex.resolve(id);
        vm.warp(st + 7 days + 1);
        vm.expectEmit(address(ex));
        emit Exchange.LaunchFailed(id);
        vm.expectEmit(address(ex));
        emit Exchange.Resolved(id, 2, 30e18, 0);
        ex.resolve(id);
        Exchange.LaunchView memory l = ex.getLaunch(id);
        assertEq(l.outcome, 2);
        assertEq(l.status, 3);
        assertEq(l.raised, 0);
        assertEq(l.totalLoserShares, 0);
    }

    // ---- outcome effects ----

    function test_yesGraduatesAndPaysOneMinusCut() public {
        uint256 id = _newQ(2500);
        _mint(alice, bob, 50, 10e18); // raised 2.5 >= 2.15; alice YES, bob NO
        _fill(_o(carol, 0, 0, 50, 2e18), _o(alice, 0, 1, 50, 2e18), 0, 2e18); // carol buys 2 YES
        vm.warp(_st(id) + 15);
        _propose(id, 0);
        vm.warp(vm.getBlockTimestamp() + 3600);
        vm.expectEmit(address(ex));
        emit Exchange.Graduating(id);
        vm.expectEmit(address(ex));
        emit Exchange.Resolved(id, 0, 10e18, 2.5 ether);
        ex.resolve(id);
        Exchange.LaunchView memory l = ex.getLaunch(id);
        assertEq(l.status, 1);
        assertEq(l.raised, 2.5 ether);
        assertEq(l.totalLoserShares, 10e18);

        uint256 before = ex.balanceOf(carol);
        vm.expectEmit(address(ex));
        emit Exchange.Redeemed(id, carol, 1.5 ether, 0);
        _redeem(id, carol);
        assertEq(ex.balanceOf(carol) - before, 1.5 ether);
        _redeem(id, alice);
        assertEq(ex.balanceOf(alice), 50 ether - 5 ether + 1 ether + 6 ether); // 8 YES x 0.75
        _redeem(id, bob);
        assertEq(ex.loserShares(id, bob), 10e18);
        assertEq(ex.balanceOf(bob), 45 ether);

        ex.graduate(id);
        assertEq(ex.getLaunch(id).status, 2);
        assertEq(rail.received(), 2.5 ether);
        vm.prank(bob);
        ex.claimTokens(id);
        assertEq(rail.token().balanceOf(bob), 500_000_000e18);
        assertEq(address(ex).balance, ex.balanceOf(alice) + ex.balanceOf(bob) + ex.balanceOf(carol));
    }

    function test_noBelowTargetFailsAndPaysWinnersFull() public {
        uint256 id = _newQ(1000);
        _mint(alice, bob, 50, 20e18); // raised 2.0 < 2.15
        vm.warp(_st(id) + 15);
        _propose(id, 1); // NO
        vm.warp(vm.getBlockTimestamp() + 3600);
        vm.expectEmit(address(ex));
        emit Exchange.LaunchFailed(id);
        ex.resolve(id);
        Exchange.LaunchView memory l = ex.getLaunch(id);
        assertEq(l.outcome, 1);
        assertEq(l.status, 3);
        assertEq(l.raised, 0);
        _redeem(id, alice);
        _redeem(id, bob);
        assertEq(ex.balanceOf(bob), 50 ether - 10 ether + 20 ether);
        assertEq(ex.balanceOf(alice), 40 ether);
        assertEq(ex.loserShares(id, alice), 0);
        vm.expectRevert(Exchange.NotGraduating.selector);
        ex.graduate(id);
    }

    function test_voidPaysHalf() public {
        uint256 id = _newQ(1000);
        _mint(alice, bob, 70, 30e18); // alice paid 21, bob 9
        vm.warp(_st(id) + 15);
        _propose(id, 2);
        vm.warp(vm.getBlockTimestamp() + 3600);
        ex.resolve(id);
        assertEq(ex.getLaunch(id).outcome, 2);
        assertEq(ex.getLaunch(id).status, 3);
        _redeem(id, alice);
        _redeem(id, bob);
        assertEq(ex.balanceOf(alice), 50 ether - 21 ether + 15 ether);
        assertEq(ex.balanceOf(bob), 50 ether - 9 ether + 15 ether);
        assertEq(address(ex).balance, ex.balanceOf(alice) + ex.balanceOf(bob) + ex.balanceOf(carol));
    }
}
