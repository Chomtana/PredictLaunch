// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IOpenFourPresetValidator} from "../interfaces/IOpenFourPresetValidator.sol";
import {OpenFourTypes} from "../libraries/OpenFourTypes.sol";

/// @title PredictLaunchPresetValidator
/// @notice Create-time checks of the PredictLaunch preset (standard token + vault, FairLaunch fixed-price curve,
///         PredictLaunchTradeModule, FairLaunch PCS V2 migrate). They pin the PredictLaunch shape: 1B supply, the
///         losers' 500M sold to the rail at `raise / 500M`, sells off, and at sell-out the other 500M plus the whole
///         raise seed an empty PancakeSwap V2 pair (LP burned).
contract PredictLaunchPresetValidator is IOpenFourPresetValidator {
    uint256 public constant MAX_SUPPLY = 1_000_000_000e18;
    uint256 public constant SALE_AMOUNT = 500_000_000e18;

    /// @dev Must match `FairLaunchCurveModule.Params`.
    struct CurveParams {
        uint256 fixedPrice;
        uint16 sellPenaltyBps;
        bool enableSell;
        uint256 minPurchase;
        uint256 maxPurchase;
    }

    /// @dev Must match `PredictLaunchTradeModule.TradeConfig`.
    struct TradeConfig {
        address buyer;
    }

    /// @dev Must match `FairLaunchMigrateModule.InputParams`.
    struct MigrateInputParams {
        uint256 softCap;
        uint256 duration;
        uint256 tokenLiquidityAmount;
        uint256 maxQuoteToUse;
    }

    /// @notice Non-zero: creation must use this preset id.
    uint256 public immutable expectedPresetId;
    /// @notice The rail: the only allowed trade-module buyer.
    address public immutable rail;

    constructor(uint256 expectedPresetId_, address rail_) {
        require(rail_ != address(0), "PLValidator: zero rail");
        expectedPresetId = expectedPresetId_;
        rail = rail_;
    }

    function validate(uint256 presetId, OpenFourTypes.TokenInitParams calldata p) external view override {
        if (expectedPresetId != 0) require(presetId == expectedPresetId, "PLValidator: wrong preset");
        require(bytes(p.name).length > 0 && bytes(p.symbol).length > 0, "PLValidator: empty name");
        require(p.maxSupply == MAX_SUPPLY && p.saleAmount == SALE_AMOUNT, "PLValidator: bad supply");
        require(p.quoteAsset != address(0), "PLValidator: zero quoteAsset");
        require(
            p.tokenParams.length == 0 && p.vaultParams.length == 0 && p.customDataParams.length == 0,
            "PLValidator: unexpected params"
        );

        CurveParams memory c = abi.decode(p.curveParams, (CurveParams));
        require(c.fixedPrice > 0, "PLValidator: zero price");
        require(!c.enableSell && c.sellPenaltyBps == 0, "PLValidator: sells must be off");
        require(c.minPurchase > 0 && c.minPurchase <= SALE_AMOUNT, "PLValidator: bad minPurchase");
        require(c.maxPurchase == SALE_AMOUNT, "PLValidator: maxPurchase must be the sale");
        require(p.raiseAmount == Math.mulDiv(SALE_AMOUNT, c.fixedPrice, 1e18), "PLValidator: raise mismatch");

        TradeConfig memory t = abi.decode(p.tradeParams, (TradeConfig));
        require(t.buyer == rail, "PLValidator: buyer must be the rail");

        MigrateInputParams memory m = abi.decode(p.migrateParams, (MigrateInputParams));
        require(m.softCap == 0 && m.maxQuoteToUse == 0, "PLValidator: whole raise to the pool");
        require(m.duration > 0, "PLValidator: zero duration");
        require(
            m.tokenLiquidityAmount == 0 || m.tokenLiquidityAmount == MAX_SUPPLY - SALE_AMOUNT,
            "PLValidator: pool gets the other 500M"
        );
    }
}
