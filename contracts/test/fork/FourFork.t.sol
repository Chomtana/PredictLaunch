// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {Exchange} from "src/Exchange.sol";
import {Eip712} from "src/lib/Eip712.sol";
import {FourRail} from "src/openfour/FourRail.sol";
import {IOpenFourCore} from "src/openfour/interfaces/IOpenFourCore.sol";
import {IOpenFourFeeRouter} from "src/openfour/interfaces/IOpenFourFeeRouter.sol";
import {OpenFourTypes} from "src/openfour/libraries/OpenFourTypes.sol";
import {FairLaunchCurveModule} from "src/openfour/modules/curve/FairLaunchCurveModule.sol";
import {FairLaunchMigrateModule} from "src/openfour/modules/migrate/FairLaunchMigrateModule.sol";
import {PredictLaunchTradeModule} from "src/openfour/modules/trade/PredictLaunchTradeModule.sol";
import {PredictLaunchPresetValidator} from "src/openfour/validators/PredictLaunchPresetValidator.sol";
import {IOpenFourRegistryAdmin, IOpenFourCoreAdmin} from "script/DeployFour.s.sol";

interface IMintable4 {
    function mint(address to, uint256 amount) external;
}

interface IRouter4 {
    function factory() external view returns (address);
}

interface IPairFactory4 {
    function getPair(address, address) external view returns (address);
}

interface IVault4 {
    function phase() external view returns (uint8);
}

/// The Four path against a developer-owned OpenFour fork (openfour-docs fork-deploy, see scripts/openfour-fork.sh):
/// register the PredictLaunch preset, create a launch through FourRail, trade, settle on the real BTCB Atlas feed,
/// then graduate with a Core.signer signature: createToken -> rail buys the 500M sale -> Core migrates to PancakeSwap.
///   OPENFOUR_RPC=http://127.0.0.1:8546 OPENFOUR_JSON=<fork-deployment.json> forge test --mc FourForkTest
contract FourForkTest is Test {
    address constant BTCB_FEED = 0xe20536BC715AaC6560394e33deB66ed205AEeC33;
    address constant USDT = 0x190C989D5665a0e404B444b53CAE9AbCfb600157;
    address constant PCS_V2_ROUTER = 0xD99D1c33F9fC3444f8101754aBC46c52416550D1;
    uint256 constant PRESET_ID = 7_770_000_042;
    uint8 constant PHASE_MIGRATED = 3;

    Exchange ex;
    FourRail rail;
    IOpenFourCore core;
    address forkOwner;
    address owner = address(uint160(0xC0DE1001));
    address operator = address(uint160(0xC0DE1002));
    address creator = address(uint160(0xC0DE1003));
    uint256 constant SIGNER_PK = 0x5161E7;
    uint256 constant ALICE_PK = 0xA11CE;
    uint256 constant BOB_PK = 0xB0B;
    address alice = vm.addr(ALICE_PK);
    address bob = vm.addr(BOB_PK);
    string fork;

    function setUp() public {
        string memory rpc = vm.envOr("OPENFOUR_RPC", string(""));
        string memory path = vm.envOr("OPENFOUR_JSON", string(""));
        if (bytes(rpc).length == 0 || bytes(path).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        fork = vm.readFile(path);
        forkOwner = vm.parseJsonAddress(fork, ".deployer");
        core = IOpenFourCore(vm.parseJsonAddress(fork, ".addresses.core"));
        vm.deal(creator, 1 ether);
        vm.deal(alice, 20_000 ether);
        vm.deal(bob, 20_000 ether);
    }

    /// The same wiring as script/DeployFour.s.sol, done with pranks.
    function _deploy(address quote) internal {
        ex = new Exchange(owner, quote);
        vm.startPrank(owner);
        ex.setFeed(BTCB_FEED, true);
        ex.setResolver(operator);
        ex.setMinTarget(quote == address(0) ? 2 ether : 1500 ether);
        vm.stopPrank();
        vm.store(BTCB_FEED, keccak256(abi.encode(address(ex), uint256(1))), bytes32(uint256(1)));

        IOpenFourRegistryAdmin registry = IOpenFourRegistryAdmin(vm.parseJsonAddress(fork, ".addresses.registry"));
        rail = new FourRail(ex, core, PRESET_ID);
        PredictLaunchPresetValidator validator = new PredictLaunchPresetValidator(PRESET_ID, address(rail));
        address curve = address(new FairLaunchCurveModule());
        address trade = address(new PredictLaunchTradeModule());
        address migrate = address(new FairLaunchMigrateModule());

        vm.startPrank(forkOwner);
        bytes32 curveKey = _register(registry, "module.curve.fair_launch", curve, 2);
        bytes32 tradeKey = _register(registry, "module.trade.predict_launch", trade, 3);
        bytes32 migrateKey = _register(registry, "module.migrate.fair_launch", migrate, 4);
        uint256 bonding = vm.parseUint(vm.parseJsonString(fork, ".presets.bondingV1"));
        registry.upsertPreset(
            OpenFourTypes.Preset({
                id: PRESET_ID,
                name: "PredictLaunch",
                description: "test",
                version: "1.0.0",
                active: true,
                createEnabled: true,
                validator: address(validator),
                tokenModuleId: vm.parseJsonBytes32(fork, ".moduleIds.TOKEN_STANDARD"),
                vaultModuleId: vm.parseJsonBytes32(fork, ".moduleIds.VAULT_BASIC"),
                curveModuleId: curveKey,
                tradeModuleId: tradeKey,
                migrateModuleId: migrateKey,
                tokenImplId: registry.getPreset(bonding).tokenImplId,
                customDataId: bytes32(0),
                author: forkOwner
            })
        );
        IOpenFourFeeRouter(vm.parseJsonAddress(fork, ".addresses.feeRouter"))
            .setPresetFeeConfig(PRESET_ID, IOpenFourFeeRouter.OverriddenFeeConfig(0, 0, 100, 1000, 5, true, 0));
        IOpenFourCoreAdmin(address(core)).setSigner(vm.addr(SIGNER_PK));
        vm.stopPrank();
        vm.prank(owner);
        ex.setExtraFactory(address(rail), true);
    }

    function _register(IOpenFourRegistryAdmin registry, string memory key, address impl, uint8 kind)
        internal
        returns (bytes32 k)
    {
        k = keccak256(bytes(key));
        registry.upsertModule(k, impl, kind, OpenFourTypes.ModuleMetadata(k, "1.0.0", key, key, forkOwner, 0), true);
    }

    function test_graduateOnOpenFourUsdt() public {
        _deploy(USDT);
        _fullFlow(1000);
    }

    function test_graduateOnOpenFourNative() public {
        _deploy(address(0));
        _fullFlow(1);
    }

    function test_graduateNeedsSignature() public {
        _deploy(USDT);
        _toGraduating(1000);
        vm.expectRevert(FourRail.NoSignature.selector);
        ex.graduate(0);
        // a signature by any other key is refused by OpenFour Core
        uint256 ts = block.timestamp + 600;
        bytes32 h = MessageHashUtils.toEthSignedMessageHash(rail.createDigest(0, ts));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ALICE_PK, h);
        vm.expectRevert();
        rail.graduate(0, ts, abi.encodePacked(r, s, v));
        assertEq(ex.getLaunch(0).status, 1, "still Graduating");
    }

    function test_onlyExtraFactoryOrFactoryRegisters() public {
        _deploy(USDT);
        Exchange.LaunchConfig memory c = _cfg(1000);
        vm.prank(owner);
        ex.setExtraFactory(address(rail), false);
        vm.prank(creator);
        vm.expectRevert(Exchange.NotFactory.selector);
        rail.createLaunch(c);
    }

    function _cfg(uint256 k) internal view returns (Exchange.LaunchConfig memory c) {
        c.name = "Four Loser";
        c.symbol = "FLOSE";
        c.imageURI = "ipfs://predictlaunch-four";
        c.feed = BTCB_FEED;
        c.strike = uint80(uint256(vm.load(BTCB_FEED, bytes32(uint256(0x32)))));
        c.settleTime = uint64(block.timestamp + 600);
        c.cutBps = 3000;
        c.target = (k == 1 ? 2 ether : 1500 ether);
    }

    function _fund(address u, uint256 amount) internal {
        address q = ex.quoteToken();
        vm.startPrank(u);
        if (q == address(0)) {
            ex.deposit{value: amount}(amount);
        } else {
            IMintable4(q).mint(u, amount);
            IERC20(q).approve(address(ex), amount);
            ex.deposit(amount);
        }
        vm.stopPrank();
    }

    function _signed(Eip712.Order memory o, uint256 pk) internal view returns (Exchange.SignedOrder memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, ex.orderHash(o));
        return Exchange.SignedOrder(o, abi.encodePacked(r, s, v));
    }

    /// Create through the rail, mint 8k pairs (cut 30% -> raise 2.4k), settle Up: Graduating.
    function _toGraduating(uint256 k) internal returns (Exchange.LaunchConfig memory c) {
        c = _cfg(k);
        vm.prank(creator);
        uint256 id = rail.createLaunch(c);
        assertEq(id, 0);
        Exchange.LaunchView memory l = ex.getLaunch(0);
        assertEq(l.rail, address(rail));
        assertEq(l.creator, creator);
        assertEq(l.token, address(0), "token is created at graduation");

        uint128 amt = uint128(8e18 * k);
        _fund(alice, 10 ether * k);
        _fund(bob, 10 ether * k);
        uint64 exp = uint64(block.timestamp + 1 days);
        Exchange.Batch memory b;
        b.orders = new Exchange.SignedOrder[](2);
        b.orders[0] = _signed(Eip712.Order(bob, 0, 0, 1, 0, 50, amt, exp, 1), BOB_PK);
        b.orders[1] = _signed(Eip712.Order(alice, 0, 0, 0, 0, 50, amt, exp, 1), ALICE_PK);
        b.fills = new Exchange.Fill[](1);
        b.fills[0] = Exchange.Fill(0, 1, 1, amt);
        vm.prank(operator);
        ex.submitBatch(b);

        vm.warp(c.settleTime);
        uint256 w = (uint256(c.settleTime) << 128) | (uint256(c.settleTime) << 80) | (c.strike + 1);
        vm.store(BTCB_FEED, bytes32(uint256(0x32)), bytes32(w));
        ex.snapshot(0);
        vm.warp(c.settleTime + 15);
        ex.resolve(0);
        l = ex.getLaunch(0);
        assertEq(l.status, 1, "Graduating");
        assertEq(l.raised, 2.4 ether * k);
    }

    function _fullFlow(uint256 k) internal {
        _toGraduating(k);
        uint256 raise = 2.4 ether * k;
        address quote = rail.quoteAsset();

        uint256 ts = block.timestamp + 600;
        bytes32 h = MessageHashUtils.toEthSignedMessageHash(rail.createDigest(0, ts));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_PK, h);
        rail.graduate(0, ts, abi.encodePacked(r, s, v));

        Exchange.LaunchView memory l = ex.getLaunch(0);
        assertEq(l.status, 2, "Graduated");
        address token = l.token;
        assertTrue(token != address(0), "token recorded");
        (,, uint256 presetId,,,,,,,, address vault,,,,,,, bool exists,,) = core.tokens(token);
        assertTrue(exists, "an OpenFour token");
        assertEq(presetId, PRESET_ID, "on the PredictLaunch preset");
        assertEq(IVault4(vault).phase(), PHASE_MIGRATED, "migrated in the graduate tx");
        assertEq(IERC20(token).totalSupply(), 1_000_000_000e18);
        assertEq(IERC20(token).balanceOf(address(ex)), 500_000_000e18, "Exchange holds the losers' 500M");
        address pair = IPairFactory4(IRouter4(PCS_V2_ROUTER).factory()).getPair(token, quote);
        assertTrue(pair != address(0), "PancakeSwap pair");
        assertEq(IERC20(token).balanceOf(pair), 500_000_000e18, "pool holds the other 500M");
        uint256 dust = IERC20(quote).balanceOf(creator);
        assertEq(IERC20(quote).balanceOf(pair) + dust, raise, "pool holds the raise (minus rounding dust)");
        assertLt(dust, 1e9, "dust only");
        assertEq(IERC20(quote).balanceOf(address(rail)), 0);
        assertEq(IERC20(token).balanceOf(address(rail)), 0);

        address[] memory us = new address[](2);
        us[0] = alice;
        us[1] = bob;
        ex.redeem(0, us);
        vm.prank(bob);
        ex.claimTokens(0);
        assertEq(IERC20(token).balanceOf(bob), 500_000_000e18, "the only loser claims all 500M");
    }
}
