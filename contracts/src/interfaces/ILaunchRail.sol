// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice A graduation rail: receives the raised `quoteAmount` of the Exchange's quote token (native: as
///         `msg.value`; ERC20: already transferred to the rail before the call), launches the token, and must hand
///         `LOSER_SUPPLY` tokens to the Exchange (`receiveLoserTokens`) before returning.
interface ILaunchRail {
    function launch(uint256 launchId, uint256 quoteAmount) external payable returns (address token, address pool);
}
