// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// Behaves like a live Atlas feed for an unauthorized contract caller.
contract RevertingFeed {
    error OnlyAuthorizedCallerAllowed();

    function latestRoundData() external pure returns (uint80, int256, uint256, uint256, uint80) {
        revert OnlyAuthorizedCallerAllowed();
    }
}
