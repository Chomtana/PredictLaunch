// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {Exchange} from "src/Exchange.sol";
import {PredictLaunchLauncherFactory} from "src/flap/PredictLaunchLauncherFactory.sol";

/// Deploys Exchange + PredictLaunchLauncherFactory, enables every feed in script/feeds.json (with its Chainlink fallback,
/// if any), sets the operator (also the question-launch resolver) and the challenge window, then hands
/// ownership to OWNER, and writes ../.dev/deploy.json {exchange, factory, chainId, owner, operator}.
///
///   forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --private-key <deployer>
///   env: OWNER (default: deployer), OPERATOR (default: deployer),
///        QUOTE_TOKEN (default: address(0) = native BNB; testnet: Flap's faucet USDT
///        0x190C989D5665a0e404B444b53CAE9AbCfb600157), MIN_TARGET (wei, default: 2.15e18 native,
///        1500e18 for an ERC20 quote), CHALLENGE_WINDOW (seconds a resolver proposal waits before a question
///        launch resolves; default 120 so a dev demo settles in minutes; the contract's own default is 3600)
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

        address quote = vm.envOr("QUOTE_TOKEN", address(0));
        Exchange ex = new Exchange(deployer, quote);
        // The Portal refuses a pool quote under ~$1500 (2.15 BNB native; 1500e18 for an 18-decimal USD token), so a
        // lower target could register and then never graduate.
        uint256 minTarget = vm.envOr("MIN_TARGET", quote == address(0) ? uint256(0) : 1500 ether);
        if (minTarget != 0) ex.setMinTarget(minTarget);
        PredictLaunchLauncherFactory factory = new PredictLaunchLauncherFactory(PORTAL, GUARDIAN, address(ex));
        ex.setFactory(address(factory));
        for (uint256 i; i < feeds.length; ++i) {
            ex.setFeed(feeds[i].addr, true);
            if (feeds[i].chainlink != address(0)) ex.setFallbackFeed(feeds[i].addr, feeds[i].chainlink);
        }
        ex.setOperator(operator, true);
        ex.setResolver(operator);
        ex.setChallengeWindow(uint64(vm.envOr("CHALLENGE_WINDOW", uint256(120))));
        if (owner != deployer) ex.transferOwnership(owner);
        vm.stopBroadcast();

        console.log("exchange", address(ex));
        console.log("factory ", address(factory));
        console.log("feeds   ", feeds.length);
        console.log("quote   ", quote);

        string memory k = "deploy";
        vm.serializeAddress(k, "exchange", address(ex));
        vm.serializeAddress(k, "factory", address(factory));
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "quoteToken", quote);
        vm.serializeAddress(k, "owner", owner);
        string memory out = vm.serializeAddress(k, "operator", operator);
        string memory dir = string.concat(vm.projectRoot(), "/../.dev");
        vm.createDir(dir, true);
        vm.writeJson(out, string.concat(dir, "/deploy.json"));
    }
}
