// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {Exchange} from "src/Exchange.sol";
import {PredictLaunchLauncherFactory} from "src/flap/PredictLaunchLauncherFactory.sol";
import {IPortal} from "src/flap/IPortal.sol";
import {ITestnetFactoryWhitelist, TESTNET_FACTORY_WHITELIST} from "src/flap/ITestnetFactoryWhitelist.sol";

/// Deploys Exchange + PredictLaunchLauncherFactory, enables the factory on the Flap Portal through Flap's testnet
/// whitelist helper (a plain transaction, no cheats; read back and checked), enables the feeds from
/// script/feeds.json (with their Chainlink fallbacks), sets the operator (also the question-launch resolver) and the
/// challenge window, then hands ownership to OWNER, and writes ../.dev/deploy.json
/// {exchange, factory, chainId, quoteToken, owner, operator}. Works the same on real BSC testnet and on an anvil fork.
///
///   forge script script/Deploy.s.sol --rpc-url <rpc> --broadcast --private-key <deployer>
///   (real BSC testnet: also --legacy --with-gas-price 1gwei; the deployer needs testnet BNB)
///   env: OWNER (default: deployer), OPERATOR (default: deployer),
///        QUOTE_TOKEN (default: address(0) = native BNB; testnet: Flap's faucet USDT
///        0x190C989D5665a0e404B444b53CAE9AbCfb600157), MIN_TARGET (wei, default: 2.15e18 native,
///        1500e18 for an ERC20 quote), CHALLENGE_WINDOW (seconds a resolver proposal waits before a question
///        launch resolves; default 120 so a dev demo settles in minutes; the contract's own default is 3600),
///        FACTORY_MULTIPLIER_BPS (default 10000 = 1x), ALL_FEEDS (default false, see below),
///        DEPLOY_JSON (output path, default ../.dev/deploy.json)
///
/// Feeds: Atlas feeds only serve EOAs and callers their admin authorized, so on real testnet the Exchange can only
/// settle a feed that has a Chainlink fallback (BTCB, BNB, BTC, ETH, CAKE, USDT) until Atlas authorizes it. BNB, BTC
/// and ETH are open-read Atlas feeds, read directly; their fallback is only a backstop. By default only
/// those feeds are enabled, so no launch can be created on a feed that cannot settle. ALL_FEEDS=true enables every
/// feed; use it on an anvil fork together with script/fork-setup.sh (which writes the Atlas authorization with a
/// cheat RPC), or on testnet once Atlas has authorized the Exchange.
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
        _enableFactory(address(factory));
        bool allFeeds = vm.envOr("ALL_FEEDS", false);
        uint256 enabled;
        for (uint256 i; i < feeds.length; ++i) {
            if (!allFeeds && feeds[i].chainlink == address(0)) continue;
            ex.setFeed(feeds[i].addr, true);
            if (feeds[i].chainlink != address(0)) ex.setFallbackFeed(feeds[i].addr, feeds[i].chainlink);
            ++enabled;
        }
        ex.setOperator(operator, true);
        ex.setResolver(operator);
        ex.setChallengeWindow(uint64(vm.envOr("CHALLENGE_WINDOW", uint256(120))));
        if (owner != deployer) ex.transferOwnership(owner);
        vm.stopBroadcast();

        console.log("exchange", address(ex));
        console.log("factory ", address(factory));
        console.log("feeds   ", enabled, allFeeds ? "(all)" : "(with a Chainlink fallback)");
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
        vm.writeJson(out, vm.envOr("DEPLOY_JSON", string.concat(dir, "/deploy.json")));
    }

    /// Enable the factory on the Portal with Flap's testnet whitelist helper (anyone may call it), then read the
    /// Portal back: the helper can be called by anyone for any factory, so the multiplier is checked, not assumed.
    function _enableFactory(address factory) internal {
        require(TESTNET_FACTORY_WHITELIST.code.length != 0, "no Flap whitelist helper on this chain (BSC testnet only)");
        uint16 bps = uint16(vm.envOr("FACTORY_MULTIPLIER_BPS", uint256(10_000)));
        require(bps <= 10_000, "FACTORY_MULTIPLIER_BPS > 10000");
        if (bps == 10_000) ITestnetFactoryWhitelist(TESTNET_FACTORY_WHITELIST).whitelist(factory);
        else ITestnetFactoryWhitelist(TESTNET_FACTORY_WHITELIST).whitelist(factory, bps);
        (bool on, uint16 got) = IPortal(PORTAL).launcherFactoryMultiplier(factory);
        require(on && got == bps, "Portal did not enable the factory at FACTORY_MULTIPLIER_BPS");
        console.log("factory enabled on the Portal, multiplier bps", got);
    }
}
