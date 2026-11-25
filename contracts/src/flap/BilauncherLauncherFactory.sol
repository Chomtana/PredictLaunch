// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {LibClone} from "solady/utils/LibClone.sol";
import {UpgradeableBeacon} from "solady/utils/UpgradeableBeacon.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {LauncherFactoryBase} from "src/flap/LauncherFactoryBase.sol";
import {LauncherDataSchema, FieldDescriptor} from "src/flap/IVaultSchemas.sol";
import {BilauncherLauncher} from "src/flap/BilauncherLauncher.sol";
import {Exchange} from "src/Exchange.sol";

/// @title BilauncherLauncherFactory
/// @notice Flap Launcher Factory for bilauncher. Call path:
///           Portal.newLauncher{value: SALT_LOCK_FEE}(factory, abi.encode(Exchange.LaunchConfig))
///             -> factory.newLauncher(creator, data)                          (onlyHub)
///             -> beacon proxy at (beacon, c.salt); BilauncherLauncher.initialize{value}(...)   (locks the salt)
///             -> Exchange.registerLaunch(launcher, creator, predictedToken(c.salt), c)  (validates the market)
///             -> launcher.setLaunchId(id)
///         Flap enables the factory with `setLauncherFactoryMultiplier(factory, multiplier, true)`.
contract BilauncherLauncherFactory is LauncherFactoryBase {
    /// @notice Flap's tax token implementation (same on BNB Chain and BNB Testnet); a token is CREATE2(impl, salt, hub).
    address public constant TOKEN_IMPL = 0x7777c57ff7dc441c1715b2e36fa581c48B782222;

    address public immutable hub;
    address public immutable guardian;
    address public immutable exchange;
    address public immutable beacon;

    event BilauncherLauncherCreated(
        address indexed launcher, address indexed creator, uint256 indexed launchId, address token, bytes32 salt
    );
    event FlapLauncherImplementationUpgraded(address implementation);

    error ZeroAddress();

    constructor(address hub_, address guardian_, address exchange_) {
        if (hub_ == address(0) || guardian_ == address(0) || exchange_ == address(0)) revert ZeroAddress();
        hub = hub_;
        guardian = guardian_;
        exchange = exchange_;
        BilauncherLauncher impl = new BilauncherLauncher();
        beacon = address(new UpgradeableBeacon(address(this), address(impl)));
    }

    function _getHub() internal view override returns (address) {
        return hub;
    }

    function _getGuardian() internal view override returns (address) {
        return guardian;
    }

    /// @notice The memecoin address the Portal will create for `salt`.
    function predictedToken(bytes32 salt) public view returns (address) {
        return Clones.predictDeterministicAddress(TOKEN_IMPL, salt, hub);
    }

    /// @notice The Launcher address `salt` deploys to.
    function predictedLauncher(bytes32 salt) external view returns (address) {
        return LibClone.predictDeterministicAddressERC1967BeaconProxy(beacon, salt, address(this));
    }

    function _newLauncher(address creator, bytes calldata data) internal override returns (address launcher) {
        Exchange.LaunchConfig memory c = abi.decode(data, (Exchange.LaunchConfig));
        launcher = LibClone.deployDeterministicERC1967BeaconProxy(beacon, c.salt);
        BilauncherLauncher(launcher).initialize{value: msg.value}(hub, creator, exchange, c);
        address token = predictedToken(c.salt);
        uint256 id = Exchange(exchange).registerLaunch(launcher, creator, token, c);
        BilauncherLauncher(launcher).setLaunchId(id);
        emit BilauncherLauncherCreated(launcher, creator, id, token, c.salt);
    }

    function upgradeVaultImplementation(address newImplementation) external override onlyGuardian {
        UpgradeableBeacon(beacon).upgradeTo(newImplementation);
        emit FlapLauncherImplementationUpgraded(newImplementation);
    }

    function beaconImplementation() external view returns (address) {
        return UpgradeableBeacon(beacon).implementation();
    }

    function launcherDataSchema() external pure override returns (LauncherDataSchema memory schema) {
        schema.description =
            "bilauncher prediction launch: a binary market (Up/Down on an Atlas price feed, or YES/NO on a question) funds the pool. Winners are paid 1 minus the cut; at the target the raise and 50% of the supply seed the pool and losers claim the other 50%.";
        schema.isArray = false;
        FieldDescriptor[] memory f = new FieldDescriptor[](11);
        f[0] = FieldDescriptor({name: "name", fieldType: "string", description: "Token name (1-32 bytes)", decimals: 0});
        f[1] = FieldDescriptor({
            name: "symbol", fieldType: "string", description: "Token symbol (1-10 bytes)", decimals: 0
        });
        f[2] =
            FieldDescriptor({name: "imageURI", fieldType: "string", description: "Image / metadata URI", decimals: 0});
        f[3] = FieldDescriptor({
            name: "feed",
            fieldType: "address",
            description: "Atlas price feed (must be enabled); address(0) for a question launch",
            decimals: 0
        });
        f[4] = FieldDescriptor({
            name: "strike",
            fieldType: "uint256",
            description: "Price to beat: Up wins iff price >= strike; 0 for a question launch",
            decimals: 18
        });
        f[5] = FieldDescriptor({
            name: "settleTime",
            fieldType: "uint64",
            description: "Settlement unix time (5 minutes to 30 days out)",
            decimals: 0
        });
        f[6] = FieldDescriptor({
            name: "cutBps",
            fieldType: "uint16",
            description: "Cut of each winning share: 1000-3000 step 500",
            decimals: 0
        });
        f[7] = FieldDescriptor({
            name: "target",
            fieldType: "uint256",
            description: "Raise (in the quote token) needed to graduate (>= minTarget)",
            decimals: 18
        });
        f[8] = FieldDescriptor({
            name: "salt",
            fieldType: "bytes32",
            description: "CREATE2 salt; the token address must end in 0x7777",
            decimals: 0
        });
        f[9] = FieldDescriptor({
            name: "question",
            fieldType: "string",
            description: "Question launch (YES/NO): 1-280 bytes with feed 0 and strike 0; empty for a price launch",
            decimals: 0
        });
        f[10] = FieldDescriptor({
            name: "marketId",
            fieldType: "uint256",
            description: "Cournot market id of the question (offchain only; 0 = none); 0 for a price launch",
            decimals: 0
        });
        schema.fields = f;
    }
}
