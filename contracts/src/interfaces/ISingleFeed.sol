// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Atlas Oracle push-mode SingleFeed (Chainlink AggregatorV3 compatible, 18 decimals).
interface ISingleFeed {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
