// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ILaunchRail} from "src/interfaces/ILaunchRail.sol";
import {Exchange} from "src/Exchange.sol";

contract MockToken is ERC20 {
    constructor(address to) ERC20("Mock", "MOCK") {
        _mint(to, 1_000_000_000e18);
    }
}

/// An ILaunchRail that keeps the BNB, holds a pre-minted 1B token and hands 500M to the Exchange.
contract MockRail is ILaunchRail {
    Exchange public immutable ex;
    MockToken public immutable token;
    bool public skipReceive;
    uint256 public received;

    constructor(Exchange e) {
        ex = e;
        token = new MockToken(address(this));
    }

    function setSkipReceive(bool s) external {
        skipReceive = s;
    }

    function launch(uint256 launchId) external payable returns (address, address) {
        received += msg.value;
        if (!skipReceive) {
            token.approve(address(ex), 500_000_000e18);
            ex.receiveLoserTokens(launchId, address(token), 500_000_000e18);
        }
        return (address(token), address(0xB001));
    }

    /// For tests: try to push loser tokens outside a graduation.
    function push(uint256 launchId, uint256 amount) external {
        token.approve(address(ex), amount);
        ex.receiveLoserTokens(launchId, address(token), amount);
    }
}
