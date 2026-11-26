// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {Exchange} from "src/Exchange.sol";
import {FourRail} from "src/openfour/FourRail.sol";
import {IOpenFourCore} from "src/openfour/interfaces/IOpenFourCore.sol";
import {IOpenFourFeeRouter} from "src/openfour/interfaces/IOpenFourFeeRouter.sol";
import {OpenFourTypes} from "src/openfour/libraries/OpenFourTypes.sol";
import {FairLaunchCurveModule} from "src/openfour/modules/curve/FairLaunchCurveModule.sol";
import {FairLaunchMigrateModule} from "src/openfour/modules/migrate/FairLaunchMigrateModule.sol";
import {PredictLaunchTradeModule} from "src/openfour/modules/trade/PredictLaunchTradeModule.sol";
import {PredictLaunchPresetValidator} from "src/openfour/validators/PredictLaunchPresetValidator.sol";

/// @dev Registry writes of a developer-owned OpenFour fork (signatures as in openfour-docs fork-deploy).
interface IOpenFourRegistryAdmin {
    function upsertModule(
        bytes32 moduleKey,
        address implementation,
        uint8 kind,
        OpenFourTypes.ModuleMetadata calldata metadata,
        bool active
    ) external;
    function upsertPreset(OpenFourTypes.Preset calldata preset) external;
    function getPreset(uint256 presetId) external view returns (OpenFourTypes.Preset memory);
}

interface IOpenFourCoreAdmin {
    function setSigner(address signer) external;
    function signer() external view returns (address);
}

/// Registers the PredictLaunch preset on a developer-owned OpenFour fork and wires it to an existing Exchange.
///
/// Prerequisite: an OpenFour proxy set you own, made by openfour-docs `developer/fork-deploy` (`npm run fork`; see
/// scripts/openfour-fork.sh), whose `out/fork-deployment.json` is OPENFOUR_JSON. The broadcaster must own that
/// Registry / Core / FeeRouter (the fork deployer) and the Exchange.
///
/// It deploys and registers (kind 2 curve, 3 trade, 4 migrate) FairLaunchCurveModule, PredictLaunchTradeModule and
/// FairLaunchMigrateModule, deploys FourRail and PredictLaunchPresetValidator, upserts the preset (fork standard
/// token + vault modules and the bonding preset's token impl), sets zero protocol/dev fees for it (so the pool gets
/// the whole raise), makes SIGNER (the keeper's operator key) `Core.signer`, enables the rail as an Exchange
/// factory, and writes ../.dev/four.json {rail, core, registry, tools, presetId, signer, quoteAsset}.
///
///   OPENFOUR_JSON=<fork-deployment.json> EXCHANGE=<exchange> SIGNER=<operator> \
///   forge script script/DeployFour.s.sol --rpc-url <rpc> --broadcast --private-key <fork deployer>
///   env: PRESET_ID (default 7770000001), FOUR_JSON (output, default ../.dev/four.json)
contract DeployFour is Script {
    uint8 constant KIND_CURVE = 2;
    uint8 constant KIND_TRADE = 3;
    uint8 constant KIND_MIGRATE = 4;

    function run() external {
        string memory fork = vm.readFile(vm.envString("OPENFOUR_JSON"));
        require(vm.parseJsonUint(fork, ".chainId") == block.chainid, "OPENFOUR_JSON is for another chain");
        IOpenFourRegistryAdmin registry = IOpenFourRegistryAdmin(vm.parseJsonAddress(fork, ".addresses.registry"));
        address core = vm.parseJsonAddress(fork, ".addresses.core");
        address feeRouter = vm.parseJsonAddress(fork, ".addresses.feeRouter");
        address tools = vm.parseJsonAddress(fork, ".addresses.tools");
        bytes32 tokenModuleId = vm.parseJsonBytes32(fork, ".moduleIds.TOKEN_STANDARD");
        bytes32 vaultModuleId = vm.parseJsonBytes32(fork, ".moduleIds.VAULT_BASIC");
        uint256 bondingPreset = vm.parseUint(vm.parseJsonString(fork, ".presets.bondingV1"));
        Exchange ex = Exchange(payable(vm.envAddress("EXCHANGE")));
        address signer = vm.envAddress("SIGNER");
        uint256 presetId = vm.envOr("PRESET_ID", uint256(7_770_000_001));

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();

        bytes32 curveKey = _register(registry, "module.curve.fair_launch", address(new FairLaunchCurveModule()), KIND_CURVE, deployer);
        bytes32 tradeKey =
            _register(registry, "module.trade.predict_launch", address(new PredictLaunchTradeModule()), KIND_TRADE, deployer);
        bytes32 migrateKey =
            _register(registry, "module.migrate.fair_launch", address(new FairLaunchMigrateModule()), KIND_MIGRATE, deployer);

        FourRail rail = new FourRail(ex, IOpenFourCore(core), presetId);
        PredictLaunchPresetValidator validator = new PredictLaunchPresetValidator(presetId, address(rail));

        registry.upsertPreset(
            OpenFourTypes.Preset({
                id: presetId,
                name: "PredictLaunch",
                description: "A prediction market raises the pool: at graduation the rail buys the whole 500M sale with the raise, which seeds PancakeSwap with the other 500M; losers claim the 500M.",
                version: "1.0.0",
                active: true,
                createEnabled: true,
                validator: address(validator),
                tokenModuleId: tokenModuleId,
                vaultModuleId: vaultModuleId,
                curveModuleId: curveKey,
                tradeModuleId: tradeKey,
                migrateModuleId: migrateKey,
                tokenImplId: registry.getPreset(bondingPreset).tokenImplId,
                customDataId: bytes32(0),
                author: deployer
            })
        );
        IOpenFourFeeRouter(feeRouter).setPresetFeeConfig(
            presetId,
            IOpenFourFeeRouter.OverriddenFeeConfig({
                protocolFeeBps: 0,
                developerFeePoolBps: 0,
                maxProtocolDevFeeBps: 100,
                maxTaxBps: 1000, // caps only (the FeeRouter refuses 0 tiers); the preset's tokens have no tax
                maxTaxTiers: 5,
                active: true,
                partnerProtocolShareBps: 0
            })
        );
        IOpenFourCoreAdmin(core).setSigner(signer);
        ex.setExtraFactory(address(rail), true);
        vm.stopBroadcast();

        require(IOpenFourCoreAdmin(core).signer() == signer, "Core.signer not set");
        console.log("four rail ", address(rail));
        console.log("preset    ", presetId);
        console.log("validator ", address(validator));
        console.log("signer    ", signer);

        string memory k = "four";
        vm.serializeAddress(k, "rail", address(rail));
        vm.serializeAddress(k, "core", core);
        vm.serializeAddress(k, "registry", address(registry));
        vm.serializeAddress(k, "tools", tools);
        vm.serializeAddress(k, "validator", address(validator));
        vm.serializeAddress(k, "quoteAsset", rail.quoteAsset());
        vm.serializeUint(k, "presetId", presetId);
        string memory out = vm.serializeAddress(k, "signer", signer);
        string memory dir = string.concat(vm.projectRoot(), "/../.dev");
        vm.createDir(dir, true);
        vm.writeJson(out, vm.envOr("FOUR_JSON", string.concat(dir, "/four.json")));
    }

    function _register(IOpenFourRegistryAdmin registry, string memory key, address impl, uint8 kind, address author)
        internal
        returns (bytes32 moduleKey)
    {
        moduleKey = keccak256(bytes(key));
        registry.upsertModule(
            moduleKey,
            impl,
            kind,
            OpenFourTypes.ModuleMetadata({
                moduleId: moduleKey,
                version: "1.0.0",
                name: key,
                description: string.concat("PredictLaunch preset ", key),
                author: author,
                feeShareBps: 0
            }),
            true
        );
    }
}
