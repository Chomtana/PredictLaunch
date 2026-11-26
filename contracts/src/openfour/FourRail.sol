// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ILaunchRail} from "src/interfaces/ILaunchRail.sol";
import {Exchange} from "src/Exchange.sol";
import {IOpenFourCore} from "src/openfour/interfaces/IOpenFourCore.sol";
import {OpenFourTypes} from "src/openfour/libraries/OpenFourTypes.sol";

interface IWrappedNativeLike {
    function deposit() external payable;
}

interface IPancakeV2RouterLike {
    function factory() external view returns (address);
}

interface IPancakeV2FactoryLike {
    function getPair(address a, address b) external view returns (address);
}

/// @title FourRail
/// @notice The OpenFour (Four.meme) graduation rail of predictlaunch, and the factory of its launches. One contract
///         serves every Four launch.
///
///         Create: `createLaunch(cfg)` registers the market on the Exchange with this rail (no salt, no fee; the
///         token does not exist yet).
///
///         Graduate: the keeper signs the launch's `createDigest` with the key OpenFour Core trusts (`Core.signer`)
///         and calls `graduate(id, validTimestamp, sig)`, which runs `Exchange.graduate(id)`. The Exchange sends the
///         raise here and calls `launch`, which in one transaction:
///           1. `Core.createToken` on the PredictLaunch preset (1B supply, 500M sale at `raise / 500M`, only this
///              rail may buy, sells off; see PredictLaunchPresetValidator),
///           2. `Core.buy` of the whole 500M with the raise: the vault sells out and Core migrates in the same
///              call, so the raise and the other 500M seed an empty PancakeSwap V2 pair (LP burned),
///           3. hands the 500M to the Exchange for the losers (`receiveLoserTokens`).
///         Same economics as the Flap rail: losers get 50% of the supply, the pool gets the raise and the other 50%.
contract FourRail is ILaunchRail {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_SUPPLY = 1_000_000_000e18;
    uint256 public constant SALE_AMOUNT = 500_000_000e18;
    uint256 public constant MIGRATE_DURATION = 30 days;
    address public constant BSC_TESTNET_V2_ROUTER = 0xD99D1c33F9fC3444f8101754aBC46c52416550D1;
    address public constant BSC_V2_ROUTER = 0x10ED43C718714eb63d5aA57B78B54704E256024E;

    Exchange public immutable exchange;
    IOpenFourCore public immutable core;
    uint256 public immutable presetId;

    /// @dev The signature and deadline for the launch being graduated (set and cleared inside `graduate`).
    uint256 internal _pendingId;
    uint256 internal _pendingValidTimestamp;
    bytes internal _pendingSig;

    event FourLaunchCreated(uint256 indexed launchId, address indexed creator);
    event FourLaunched(uint256 indexed launchId, address indexed token, address indexed pair, uint256 raise, uint256 dust);

    error NotExchange();
    error NoSignature();
    error BadQuote();
    error BuyOutIncomplete();

    constructor(Exchange exchange_, IOpenFourCore core_, uint256 presetId_) {
        exchange = exchange_;
        core = core_;
        presetId = presetId_;
    }

    receive() external payable {}

    // ---------------------------------------------------------------------------------------------------------
    // Create
    // ---------------------------------------------------------------------------------------------------------

    /// @notice Create a Four launch: same `LaunchConfig` as Flap; `salt` is ignored. The caller is the creator.
    function createLaunch(Exchange.LaunchConfig calldata c) external returns (uint256 launchId) {
        launchId = exchange.registerLaunch(address(this), msg.sender, address(0), c);
        emit FourLaunchCreated(launchId, msg.sender);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Graduate
    // ---------------------------------------------------------------------------------------------------------

    /// @notice Graduate a Four launch. `sig` is `Core.signer`'s EIP-191 signature of `createDigest(id, validTimestamp)`.
    ///         Permissionless: Core checks the signature, so a bad one just reverts.
    function graduate(uint256 id, uint256 validTimestamp, bytes calldata sig) external {
        _pendingId = id + 1;
        _pendingValidTimestamp = validTimestamp;
        _pendingSig = sig;
        exchange.graduate(id);
        delete _pendingId;
        delete _pendingValidTimestamp;
        delete _pendingSig;
    }

    /// @inheritdoc ILaunchRail
    function launch(uint256 id, uint256 quoteAmount) external payable returns (address token, address pair) {
        if (msg.sender != address(exchange)) revert NotExchange();
        if (_pendingId != id + 1) revert NoSignature();
        address quote = quoteAsset();
        if (exchange.quoteToken() == address(0)) {
            if (msg.value != quoteAmount) revert BadQuote();
            IWrappedNativeLike(quote).deposit{value: quoteAmount}();
        } else if (msg.value != 0) {
            revert BadQuote();
        }

        bytes memory args = createArgs(id, quoteAmount, _pendingValidTimestamp);
        token = core.createToken(args, _pendingSig);

        uint256 cost = _saleCost(quoteAmount);
        IERC20(quote).forceApprove(address(core), cost);
        core.buy(token, SALE_AMOUNT, cost, 0, "");
        IERC20(quote).forceApprove(address(core), 0);
        if (IERC20(token).balanceOf(address(this)) != SALE_AMOUNT) revert BuyOutIncomplete();

        pair = IPancakeV2FactoryLike(IPancakeV2RouterLike(_router()).factory()).getPair(token, quote);
        if (pair == address(0) || IERC20(token).balanceOf(pair) == 0) revert BuyOutIncomplete();

        // Rounding dust of `raise / 500M` (under 5e8 wei) goes to the creator.
        uint256 dust = IERC20(quote).balanceOf(address(this));
        Exchange.LaunchView memory l = exchange.getLaunch(id);
        if (dust > 0) IERC20(quote).safeTransfer(l.creator, dust);
        emit FourLaunched(id, token, pair, quoteAmount, dust);

        IERC20(token).forceApprove(address(exchange), SALE_AMOUNT);
        exchange.receiveLoserTokens(id, token, SALE_AMOUNT);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Views (the keeper signs `createDigest`)
    // ---------------------------------------------------------------------------------------------------------

    /// @notice OpenFour quote asset: the Exchange's ERC20 quote, or WBNB for native BNB.
    function quoteAsset() public view returns (address) {
        address q = exchange.quoteToken();
        return q == address(0) ? core.wrappedNative() : q;
    }

    /// @notice The digest OpenFour Core recovers its signer from (`createOpenFourToken`, chain id, caller = this
    ///         rail, keccak of the encoded args); sign it as an EIP-191 personal message. Uses the launch's resolved
    ///         raise, so it is only meaningful once the launch is Graduating.
    function createDigest(uint256 id, uint256 validTimestamp) external view returns (bytes32) {
        bytes memory args = createArgs(id, exchange.getLaunch(id).raised, validTimestamp);
        return keccak256(abi.encodePacked("createOpenFourToken", block.chainid, address(this), keccak256(args)));
    }

    /// @notice The encoded `CreateTokenArgs` of launch `id` for a raise of `raise`.
    function createArgs(uint256 id, uint256 raise, uint256 validTimestamp) public view returns (bytes memory) {
        Exchange.LaunchView memory l = exchange.getLaunch(id);
        uint256 price = raise * 1e18 / SALE_AMOUNT;
        OpenFourTypes.TokenInitParams memory p = OpenFourTypes.TokenInitParams({
            name: l.name,
            symbol: l.symbol,
            tokenUri: l.imageURI,
            maxSupply: MAX_SUPPLY,
            saleAmount: SALE_AMOUNT,
            raiseAmount: Math.mulDiv(SALE_AMOUNT, price, 1e18),
            quoteAsset: quoteAsset(),
            tokenSalt: bytes32(0),
            tokenParams: "",
            vaultParams: "",
            // FairLaunchCurveModule.Params: fixedPrice, sellPenaltyBps, enableSell, minPurchase, maxPurchase
            curveParams: abi.encode(price, uint16(0), false, uint256(1e18), SALE_AMOUNT),
            // PredictLaunchTradeModule.TradeConfig: buyer
            tradeParams: abi.encode(address(this)),
            // FairLaunchMigrateModule.InputParams: softCap, duration, tokenLiquidityAmount (0 = the rest), maxQuote
            migrateParams: abi.encode(uint256(0), MIGRATE_DURATION, uint256(0), uint256(0)),
            customDataParams: ""
        });
        OpenFourTypes.CreateTokenArgs memory a = OpenFourTypes.CreateTokenArgs({
            requestId: uint256(keccak256(abi.encode(block.chainid, address(this), id))),
            presetId: presetId,
            validTimestamp: validTimestamp,
            createFee: 0,
            presaleQuote: 0,
            antiSniperEnabled: false,
            partner: address(0),
            initParams: p
        });
        return abi.encode(a);
    }

    function _saleCost(uint256 raise) internal pure returns (uint256) {
        return Math.mulDiv(SALE_AMOUNT, raise * 1e18 / SALE_AMOUNT, 1e18);
    }

    function _router() internal view returns (address) {
        return block.chainid == 56 ? BSC_V2_ROUTER : BSC_TESTNET_V2_ROUTER;
    }
}
