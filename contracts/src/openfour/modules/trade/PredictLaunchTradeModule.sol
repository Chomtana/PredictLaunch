// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {IOpenFourTradeModule} from "../../interfaces/IOpenFourTradeModule.sol";
import {IOpenFourModuleSchema} from "../../interfaces/IOpenFourModuleSchema.sol";
import {OpenFourTypes, ParamDescriptor, ModuleEncodeSchema} from "../../libraries/OpenFourTypes.sol";

/// @title PredictLaunchTradeModule
/// @notice Trade policy of the PredictLaunch preset: the inner market belongs to one buyer, the PredictLaunch rail.
/// @dev A PredictLaunch token is created at graduation of its prediction market. In that same transaction the rail
///      buys the whole sale with the market's raise, which sells the token out and migrates it to PancakeSwap. Nobody
///      else may buy (no sniping between create and buy-out) and nobody may sell into the inner market.
contract PredictLaunchTradeModule is Initializable, IOpenFourTradeModule, IOpenFourModuleSchema {
    error PredictLaunchOnlyRail(address trader, address rail);
    error PredictLaunchNoSell();

    /// @param buyer The only address allowed to buy (the PredictLaunch rail that creates the token).
    struct TradeConfig {
        address buyer;
    }

    address public boundToken;
    address public fourCore;
    TradeConfig public config;
    bytes private _initParams;
    string private _moduleVersion;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function init(address token, address fourCore_, bytes calldata rawParams, string calldata moduleVersion_)
        external
        override
        initializer
    {
        require(fourCore_ != address(0), "PLTrade: zero fourCore");
        TradeConfig memory c = abi.decode(rawParams, (TradeConfig));
        require(c.buyer != address(0), "PLTrade: zero buyer");
        boundToken = token;
        fourCore = fourCore_;
        config = c;
        _initParams = rawParams;
        _moduleVersion = moduleVersion_;
    }

    function descriptor() external view override returns (bytes8 tagId, string memory tag, string memory version) {
        tag = "module.trade.predict_launch";
        return (bytes8(keccak256(bytes(tag))), tag, _moduleVersion);
    }

    /// @dev View-only; rejections return `allowed=false` plus revertData (never revert for a business rule).
    function evaluate(OpenFourTypes.TradeContext calldata ctx)
        external
        view
        override
        returns (OpenFourTypes.TradeResult memory r)
    {
        require(fourCore != address(0), "PLTrade: not initialized");
        require(ctx.token == boundToken, "PLTrade: wrong token");
        r.fees = new OpenFourTypes.FeeTier[](0);
        if (!ctx.isBuy) {
            r.revertData = abi.encodeWithSelector(PredictLaunchNoSell.selector);
            return r;
        }
        if (ctx.trader != config.buyer) {
            r.revertData = abi.encodeWithSelector(PredictLaunchOnlyRail.selector, ctx.trader, config.buyer);
            return r;
        }
        r.allowed = true;
        r.maxAmount = type(uint256).max;
    }

    function moduleEncodeSchema() external pure override returns (ModuleEncodeSchema memory) {
        ParamDescriptor[] memory p = new ParamDescriptor[](1);
        p[0] = ParamDescriptor({
            name: "buyer",
            abiType: "address",
            decimals: 0,
            optional: false,
            title: "Buyer (PredictLaunch rail)",
            defaultValue: "",
            hint: "The only address allowed to buy; it buys the whole sale at graduation.",
            minValue: "",
            maxValue: ""
        });
        return ModuleEncodeSchema("trade", 1, p);
    }

    function getInitParams() external view returns (bytes memory) {
        return _initParams;
    }
}
