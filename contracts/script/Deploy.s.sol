// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {Exchange} from "src/Exchange.sol";
import {BilauncherLauncherFactory} from "src/flap/BilauncherLauncherFactory.sol";

/// Deploys Exchange + BilauncherLauncherFactory, enables every feed in script/feeds.json (with its Chainlink fallback,
/// if any), sets the operator, then hands
/// ownership to OWNER, and writes ../.dev/deploy.json {exchange, factory, chainId, owner, operator}.
///
///   forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --private-key <deployer>
///   env: OWNER (default: deployer), OPERATOR (default: deployer)
///
/// Not done here (cheatcodes do not broadcast); on an anvil fork run script/fork-setup.sh afterwards, which
///   1. authorizes the Exchange on every Atlas feed (feeds only serve EOAs and authorized callers), and
///   2. opens the factory on the Flap Portal (impersonating the ProxyAdmin owner).
contract Deploy is Script {
    address constant PORTAL = 0x000042108465206185A077Edc3F3fd2b49060000;
    address constant GUARDIAN = 0x00004d58290854c5E9880F4b5B1993c6Ad8b0000;

    struct FeedRow {
        address addr; // json "address"
        address chainlink; // json "chainlink": Chainlink AggregatorV3 fallback, or address(0)
        string symbol;
    }

    function run() external {
        string memory feedsJson = vm.readFile(string.concat(vm.projectRoot(), "/script/feeds.json"));
        FeedRow[] memory feeds = abi.decode(vm.parseJson(feedsJson), (FeedRow[]));

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        address owner = vm.envOr("OWNER", deployer);
        address operator = vm.envOr("OPERATOR", deployer);

        Exchange ex = new Exchange(deployer);
        BilauncherLauncherFactory factory = new BilauncherLauncherFactory(PORTAL, GUARDIAN, address(ex));
        ex.setFactory(address(factory));
        for (uint256 i; i < feeds.length; ++i) {
            ex.setFeed(feeds[i].addr, true);
            if (feeds[i].chainlink != address(0)) ex.setFallbackFeed(feeds[i].addr, feeds[i].chainlink);
        }
        ex.setOperator(operator, true);
        if (owner != deployer) ex.transferOwnership(owner);
        vm.stopBroadcast();

        console.log("exchange", address(ex));
        console.log("factory ", address(factory));
        console.log("feeds   ", feeds.length);

        string memory k = "deploy";
        vm.serializeAddress(k, "exchange", address(ex));
        vm.serializeAddress(k, "factory", address(factory));
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "owner", owner);
        string memory out = vm.serializeAddress(k, "operator", operator);
        string memory dir = string.concat(vm.projectRoot(), "/../.dev");
        vm.createDir(dir, true);
        vm.writeJson(out, string.concat(dir, "/deploy.json"));
    }
}
