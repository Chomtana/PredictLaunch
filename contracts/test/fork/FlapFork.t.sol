// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {Exchange} from "src/Exchange.sol";
import {Eip712} from "src/lib/Eip712.sol";
import {IPortal} from "src/flap/IPortal.sol";
import {ILauncherDescription} from "src/flap/ILauncher.sol";
import {PredictLaunchLauncherFactory} from "src/flap/PredictLaunchLauncherFactory.sol";
import {PredictLaunchLauncher} from "src/flap/PredictLaunchLauncher.sol";
import {ITestnetFactoryWhitelist, TESTNET_FACTORY_WHITELIST} from "src/flap/ITestnetFactoryWhitelist.sol";

interface IMintable {
    function mint(address to, uint256 amount) external;
}

interface IProxyAdminLike {
    function owner() external view returns (address);
}

interface IRouterLike {
    function factory() external view returns (address);
}

interface IPairFactoryLike {
    function getPair(address, address) external view returns (address);
}

/// The full launch path on a BSC-testnet fork against the real Flap Portal:
/// Portal.newLauncher -> our factory -> PredictLaunchLauncher (salt locked) -> Exchange.registerLaunch; trade; settle on
/// the real BTCB Atlas feed (slot 0x32 driven by vm.store); resolve -> Graduating; graduate -> launchTaxTokenV2.
contract FlapForkTest is Test {
    address constant PORTAL = 0x000042108465206185A077Edc3F3fd2b49060000;
    address constant PROXY_ADMIN = 0x0000Ed588dfc01749C20bA69b5f8c77d706E0000;
    address constant GUARDIAN = 0x00004d58290854c5E9880F4b5B1993c6Ad8b0000;
    address constant TOKEN_IMPL = 0x7777c57ff7dc441c1715b2e36fa581c48B782222;
    address constant WBNB = 0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd;
    address constant ROUTER = 0xc9D63ddCB9549578057EAB6A83a543DdFEE2b8c3;
    address constant BTCB_FEED = 0xe20536BC715AaC6560394e33deB66ed205AEeC33;
    /// Flap's testnet faucet USDT (on-chain name/symbol "USD", 18 decimals, permissionless `mint`).
    address constant USDT = 0x190C989D5665a0e404B444b53CAE9AbCfb600157;

    IPortal portal = IPortal(PORTAL);
    Exchange ex;
    PredictLaunchLauncherFactory factory;
    address owner = address(uint160(0xC0DE1001));
    address operator = address(uint160(0xC0DE1002));
    address creator = address(uint160(0xC0DE1003));
    uint256 constant ALICE_PK = 0xA11CE;
    uint256 constant BOB_PK = 0xB0B;
    address alice = vm.addr(ALICE_PK);
    address bob = vm.addr(BOB_PK);

    function setUp() public {
        string memory rpc = vm.envOr("BSC_TESTNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        require(block.chainid == 97, "not BSC testnet");
        _deploy(address(0));

        vm.deal(creator, 1 ether);
        vm.deal(alice, 20 ether);
        vm.deal(bob, 20 ether);
    }

    function _deploy(address quote) internal {
        ex = new Exchange(owner, quote);
        factory = new PredictLaunchLauncherFactory(PORTAL, GUARDIAN, address(ex));
        vm.startPrank(owner);
        ex.setFactory(address(factory));
        ex.setFeed(BTCB_FEED, true);
        ex.setOperator(operator, true);
        ex.setResolver(operator);
        ex.setChallengeWindow(120);
        vm.stopPrank();
        // Atlas feeds only serve EOAs and authorized callers: authorize the Exchange (mapping at slot 1)
        vm.store(BTCB_FEED, keccak256(abi.encode(address(ex), uint256(1))), bytes32(uint256(1)));
    }

    /// Open the factory the way Deploy.s.sol does on real testnet: Flap's whitelist helper, called by an ordinary
    /// account (no prank of a Flap admin).
    function _openFactory() internal {
        vm.prank(creator);
        ITestnetFactoryWhitelist(TESTNET_FACTORY_WHITELIST).whitelist(address(factory));
    }

    /// A salt whose predicted token address ends in 0x7777 (hashing in scratch space, as Flap's ForkBase does).
    function _mineSalt(bytes32 seed) internal pure returns (bytes32 salt) {
        for (uint256 i;; ++i) {
            assembly ("memory-safe") {
                mstore(0x00, seed)
                mstore(0x20, i)
                salt := keccak256(0x00, 0x40)
            }
            if (uint16(uint160(Clones.predictDeterministicAddress(TOKEN_IMPL, salt, PORTAL))) == 0x7777) return salt;
        }
    }

    function _price() internal returns (uint256 p) {
        uint256 w = uint256(vm.load(BTCB_FEED, bytes32(uint256(0x32))));
        p = uint80(w);
    }

    function _setFeed(uint256 answer, uint256 updatedAt) internal {
        uint256 w = (updatedAt << 128) | (updatedAt << 80) | answer;
        vm.store(BTCB_FEED, bytes32(uint256(0x32)), bytes32(w));
    }

    function _cfg(bytes32 salt) internal returns (Exchange.LaunchConfig memory c) {
        c.name = "Loser Coin";
        c.symbol = "LOSE";
        c.imageURI = "ipfs://predictlaunch-test";
        c.feed = BTCB_FEED;
        c.strike = _price();
        c.settleTime = uint64(block.timestamp + 600);
        c.cutBps = 3000;
        c.target = 2.15 ether * _k();
        c.salt = salt;
        if (questionMode) {
            c.feed = address(0);
            c.strike = 0;
            c.question = "Will BTC close above $100k on 2026-12-31?";
            c.marketId = 1234;
        }
    }

    /// Set by the question-launch test: `_cfg` builds a question launch and `_fullFlow` settles it by proposal.
    bool questionMode;

    function _signed(Eip712.Order memory o, uint256 pk) internal view returns (Exchange.SignedOrder memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, ex.orderHash(o));
        return Exchange.SignedOrder(o, abi.encodePacked(r, s, v));
    }

    function _pauseCreation() internal {
        vm.prank(IProxyAdminLike(PROXY_ADMIN).owner());
        portal.setCreationPaused(true);
    }

    /// Plan C6 expected "newLauncher reverts before Flap opens the factory". The real testnet Portal (v1.2.0) does
    /// not gate it: with creation paused and the factory never opened, `newLauncher` and the Launcher's
    /// `launchTaxTokenV2` both go through. This pins that fact (see SPEC-NOTES.md); if Flap adds the gate, this test
    /// fails and the factory must be opened first (the dev script opens it anyway).
    function test_unopenedFactoryNotGatedOnTestnetPortal() public {
        _pauseCreation();
        assertEq(portal.featureFlags() & 1, 1, "paused");
        (bool enabled,) = portal.launcherFactoryMultiplier(address(factory));
        assertFalse(enabled, "factory not opened");
        _fullFlow(keccak256("unopened"));
    }

    /// Creation paused, factory opened by Flap: the complete launch goes through.
    function test_graduateOnRealPortal() public {
        _pauseCreation();
        _openFactory();
        _fullFlow(keccak256("predictlaunch-fork"));
    }

    /// Flap's testnet helper: any account can enable a deployed factory (1x, or a custom multiplier, which a later
    /// call overwrites), and it refuses an address without code.
    function test_whitelistHelperEnablesFactory() public {
        (bool on,) = portal.launcherFactoryMultiplier(address(factory));
        assertFalse(on, "fresh factory");
        _openFactory();
        (bool on1, uint16 bps1) = portal.launcherFactoryMultiplier(address(factory));
        assertTrue(on1);
        assertEq(bps1, 10_000);

        vm.prank(alice);
        ITestnetFactoryWhitelist(TESTNET_FACTORY_WHITELIST).whitelist(address(factory), 5000);
        (, uint16 bps2) = portal.launcherFactoryMultiplier(address(factory));
        assertEq(bps2, 5000, "overwritten by anyone");

        vm.prank(alice);
        vm.expectRevert();
        ITestnetFactoryWhitelist(TESTNET_FACTORY_WHITELIST).whitelist(alice);
    }

    /// Creation open (as on live testnet), factory enabled through the helper: the full launch graduates.
    function test_graduateWithHelperEnabledFactory() public {
        _openFactory();
        _fullFlow(keccak256("predictlaunch-fork-helper"));
    }

    /// The live testnet Portal has creation open (featureFlags == 0): an unopened factory works end to end there.
    function test_graduateWithCreationOpenAndUnopenedFactory() public {
        assertEq(portal.featureFlags() & 1, 0, "testnet creation is open");
        (bool enabled,) = portal.launcherFactoryMultiplier(address(factory));
        assertFalse(enabled);
        _fullFlow(keccak256("predictlaunch-fork-unopened"));
    }

    /// The same launch with Flap's testnet USDT as the quote: deposits, payouts and the pool are all USDT.
    function test_graduateWithUsdtQuote() public {
        _deploy(USDT);
        vm.prank(owner);
        ex.setMinTarget(1500 ether);
        assertEq(ex.quoteToken(), USDT);
        _fullFlow(keccak256("predictlaunch-fork-usdt"));
    }

    /// A question launch through the real Portal (the factory decodes the extended LaunchConfig), settled YES by the
    /// resolver after the challenge window, then graduated like a price launch.
    function test_questionLaunchOnRealPortal() public {
        questionMode = true;
        _fullFlow(keccak256("predictlaunch-fork-question"));
        assertTrue(ex.isQuestion(0));
        Exchange.QuestionView memory q = ex.getQuestion(0);
        assertEq(q.question, "Will BTC close above $100k on 2026-12-31?");
        assertEq(q.marketId, 1234);
        assertTrue(q.proposed);
    }

    /// Amount scale: native amounts are BNB; USDT ones are x1000 (the Portal's pool-quote floor is 1500 USDT, the
    /// dollar value of the 2.15 BNB native floor).
    function _k() internal view returns (uint256) {
        return _quote() == address(0) ? 1 : 1000;
    }

    function _quote() internal view returns (address) {
        return ex.quoteToken();
    }

    function _quoteBal(address a) internal view returns (uint256) {
        address q = _quote();
        return q == address(0) ? a.balance : IERC20(q).balanceOf(a);
    }

    function _fund(address u, uint256 amount) internal {
        address q = _quote();
        vm.startPrank(u);
        if (q == address(0)) {
            ex.deposit{value: amount}(amount);
        } else {
            IMintable(q).mint(u, amount);
            IERC20(q).approve(address(ex), amount);
            ex.deposit(amount);
        }
        vm.stopPrank();
    }

    function _fullFlow(bytes32 seed) internal {
        bytes32 salt = _mineSalt(seed);
        Exchange.LaunchConfig memory c = _cfg(salt);
        uint256 fee = portal.SALT_LOCK_FEE();

        vm.recordLogs();
        vm.prank(creator);
        address launcher = portal.newLauncher{value: fee}(address(factory), abi.encode(c));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertGt(logs.length, 0);

        assertEq(portal.getLauncher(launcher).launcherFactory, address(factory), "Portal records our factory");
        assertEq(ex.launchCount(), 1);
        Exchange.LaunchView memory l = ex.getLaunch(0);
        assertEq(l.rail, launcher);
        assertEq(l.creator, creator);
        assertEq(l.token, factory.predictedToken(salt));
        assertEq(PredictLaunchLauncher(launcher).launchId(), 0);
        assertEq(factory.predictedLauncher(salt), launcher);

        string memory d = ILauncherDescription(launcher).description();
        _assertContains(d, '{"v":1,"name":"Loser Coin","symbol":"LOSE"');
        _assertContains(d, string.concat('"quoteToken":"', _lower(_quote()), '"'));
        _assertContains(d, string.concat('"targetRaise":"', vm.toString(c.target), '"'));
        _assertContains(d, '"poolTokenRatio":"500000000000000000"');
        _assertContains(d, '"titleEn":"predictlaunch prediction launch"');

        // trade: 8 pairs at 50/50 (cut 30% -> projected raise 2.4 BNB >= 2.15)
        uint256 k = _k();
        uint128 amt = uint128(8e18 * k);
        _fund(alice, 10 ether * k);
        _fund(bob, 10 ether * k);
        uint64 exp = uint64(block.timestamp + 1 days);
        Exchange.Batch memory b;
        b.ts = uint64(block.timestamp);
        b.orders = new Exchange.SignedOrder[](2);
        b.orders[0] = _signed(Eip712.Order(bob, 0, 0, 1, 0, 50, amt, exp, 1), BOB_PK); // taker: Buy Down
        b.orders[1] = _signed(Eip712.Order(alice, 0, 0, 0, 0, 50, amt, exp, 1), ALICE_PK); // maker: Buy Up
        b.fills = new Exchange.Fill[](1);
        b.fills[0] = Exchange.Fill(0, 1, 1, amt);
        vm.prank(operator);
        ex.submitBatch(b);
        assertEq(ex.projectedRaised(0), 2.4 ether * k);

        if (questionMode) {
            // settle YES by the resolver's proposal once the challenge window has passed
            vm.warp(c.settleTime + 15);
            vm.prank(operator);
            ex.proposeOutcome(0, 0, keccak256("evidence"));
            vm.warp(c.settleTime + 15 + 120);
        } else {
            // settle above the strike on the real feed contract
            vm.warp(c.settleTime);
            _setFeed(c.strike + 1, c.settleTime);
            ex.snapshot(0);
            vm.warp(c.settleTime + 15);
        }
        ex.resolve(0);
        l = ex.getLaunch(0);
        assertEq(l.outcome, 0, "Up");
        assertEq(l.status, 1, "Graduating");
        assertEq(l.raised, 2.4 ether * k);

        uint256 exBal = _quoteBal(address(ex));
        ex.graduate(0);
        l = ex.getLaunch(0);
        assertEq(l.status, 2, "Graduated");
        address token = l.token;
        assertEq(uint16(uint160(token)), 0x7777, "token ends in 7777");
        assertEq(PredictLaunchLauncher(launcher).token(), token);
        assertEq(_quoteBal(address(ex)), exBal - 2.4 ether * k);
        assertEq(IERC20(token).balanceOf(address(ex)), 500_000_000e18, "Exchange holds the losers' 500M");
        address pair = IPairFactoryLike(IRouterLike(ROUTER).factory()).getPair(token, _quote() == address(0) ? WBNB : _quote());
        assertTrue(pair != address(0), "PancakeSwap pair exists");
        assertEq(IERC20(token).balanceOf(pair), 500_000_000e18, "pool holds 500M");
        if (_quote() != address(0)) assertEq(IERC20(_quote()).balanceOf(pair), 2.4 ether * k, "pool holds the USDT raise");

        // redeem: Alice (Up) gets 8 * 0.70, Bob's 8 Down make him the only loser -> he claims all 500M
        address[] memory us = new address[](2);
        us[0] = alice;
        us[1] = bob;
        ex.redeem(0, us);
        assertEq(ex.balanceOf(alice), (10 ether - 4 ether + 5.6 ether) * k);
        vm.prank(bob);
        ex.claimTokens(0);
        assertEq(IERC20(token).balanceOf(bob), 500_000_000e18);
        assertFalse(ex.isTradable(0, uint64(block.timestamp)));
    }

    function _lower(address a) internal pure returns (string memory) {
        return vm.toLowercase(vm.toString(a));
    }

    function _assertContains(string memory h, string memory n) internal pure {
        bytes memory hb = bytes(h);
        bytes memory nb = bytes(n);
        for (uint256 i; i + nb.length <= hb.length; ++i) {
            bool m = true;
            for (uint256 j; j < nb.length; ++j) {
                if (hb[i + j] != nb[j]) {
                    m = false;
                    break;
                }
            }
            if (m) return;
        }
        revert(string.concat("missing: ", n));
    }
}
