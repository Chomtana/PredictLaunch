// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// Chainlink AggregatorV3-shaped mock with configurable decimals.
contract MockChainlink {
    uint8 public decimals;
    int256 public answer;
    uint256 public updatedAt;

    constructor(uint8 d) {
        decimals = d;
    }

    function set(int256 a, uint256 u) external {
        answer = a;
        updatedAt = u;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (7, answer, updatedAt, updatedAt, 7);
    }
}
