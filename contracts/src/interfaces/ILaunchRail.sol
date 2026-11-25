// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice A graduation rail: receives the raised BNB, launches the token, and must hand `LOSER_SUPPLY` tokens to
///         the Exchange (`receiveLoserTokens`) before returning.
interface ILaunchRail {
    function launch(uint256 launchId) external payable returns (address token, address pool);
}
