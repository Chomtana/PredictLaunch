// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ISingleFeed} from "src/interfaces/ISingleFeed.sol";

contract MockFeed is ISingleFeed {
    int256 public answer;
    uint256 public updatedAt;

    function set(int256 a, uint256 u) external {
        answer = a;
        updatedAt = u;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}
