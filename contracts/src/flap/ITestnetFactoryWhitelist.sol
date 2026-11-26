// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Flap's BSC-testnet-only helper that enables a LauncherFactory on the Portal. Anyone may call it, for any
///         factory; it only enables (never disables), and a later call can overwrite the multiplier, so read
///         `IPortal.launcherFactoryMultiplier(factory)` back before relying on it. It reverts for an address without
///         code. It does not exist on mainnet, where Flap enables a factory only after an audit.
interface ITestnetFactoryWhitelist {
    /// @notice Enable `factory` at the standard 1x multiplier (10000 bps).
    function whitelist(address factory) external;

    /// @notice Enable `factory` with a custom multiplier, 0..10000 bps (10000 = 1x).
    function whitelist(address factory, uint16 multiplierBps) external;
}

/// @dev Address of the helper on BSC testnet (chain 97).
address constant TESTNET_FACTORY_WHITELIST = 0x77779969a11eff7582f3bCf48135A846A3457777;
