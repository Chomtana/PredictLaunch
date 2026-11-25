// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Exchange} from "src/Exchange.sol";
import {Eip712} from "src/lib/Eip712.sol";

/// Test-only: exposes internal checks.
contract ExchangeHarness is Exchange {
    constructor(address o) Exchange(o) {}

    function checkSig(Eip712.Order calldata o, bytes calldata sig, uint64 ts) external view returns (bytes32) {
        return _checkSig(o, sig, ts);
    }

    function checkOrder(Eip712.Order calldata o, bytes calldata sig, uint64 ts) external view returns (bytes32) {
        return _checkOrder(o, sig, ts);
    }

    function setPairs(uint256 id, uint128 pairs) external {
        _launches[id].pairs = pairs;
    }

    function applyKeyAuth(KeyAuth calldata k) external {
        _applyKeyAuth(k);
    }
}
