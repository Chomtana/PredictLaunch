// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPortalTypes, IPortal} from "src/flap/IPortal.sol";
import {LauncherBase} from "src/flap/LauncherBase.sol";
import {Distribution, DistributionTarget} from "src/flap/Distribution.sol";
import {IStrategy} from "src/flap/IStrategy.sol";
import {LaunchExtensionHelper} from "src/flap/LaunchExtensionHelper.sol";
import {LauncherDescription} from "src/flap/LauncherHelper.sol";
import {ILaunchRail} from "src/interfaces/ILaunchRail.sol";
import {Exchange} from "src/Exchange.sol";

string constant BL_TITLE_ZH = unicode"预测市场发射";
string constant BL_TITLE_EN = "predictlaunch prediction launch";
string constant BL_SUMMARY_ZH =
    unicode"创作者设定一个价格预测市场。赢家获得每份 1 减去抽成，抽成用于注入流动性池。达到目标后，募集的报价代币与 50% 的代币供应注入池子，另外 50% 由输家按输掉的份额领取。";
string constant BL_SUMMARY_EN =
    "A binary Up/Down price market funds the pool: winners are paid 1 minus the creator's cut, and the cut is the raise. At the target, the raise and 50% of the supply seed the pool; the other 50% is claimed by the losers in proportion to their losing shares.";

/// @title PredictLaunchLauncher
/// @notice The Flap Launcher (and graduation rail) of one predictlaunch launch. Deployed per launch by
///         `PredictLaunchLauncherFactory` as a beacon proxy inside `Portal.newLauncher`. It locks the launch salt at
///         creation, and when the Exchange's market graduates it receives the raise, calls `launchTaxTokenV2`
///         (1B supply, 500M + raise in the pool, 1% buy/sell tax fully burned, the other 500M distributed EXPLICIT
///         to this contract) and forwards the 500M to the Exchange for the losers.
contract PredictLaunchLauncher is LauncherBase, Initializable, IStrategy, ILaunchRail {
    using SafeERC20 for IERC20;

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint256 public constant POOL_TOKEN = 500_000_000e18;
    uint256 public constant LOSER_SUPPLY = TOTAL_SUPPLY - POOL_TOKEN;
    uint16 public constant TAX_BPS = 100;

    address public hub;
    address public factory;
    address public exchange;
    address public creator;
    bytes32 public launchSalt;
    uint256 public target;
    string public name;
    string public symbol;
    string public meta;

    uint256 public launchId;
    bool public launchIdSet;
    bool public launched;
    bool internal launching;
    bool internal distributionInitialized;
    address public token;
    address public pool;
    /// @notice The Exchange's quote token, the pool's quote side: address(0) = native BNB.
    address public quoteToken;

    event Launched(address indexed token, address indexed pool, uint256 poolQuote, uint256 poolToken);

    error InvalidConfig();
    error NotFactory();
    error NotExchange();
    error AlreadyLaunched();
    error UnauthorizedDistribution();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Called once by the factory. `msg.value` must be exactly the Portal's SALT_LOCK_FEE: this Launcher
    ///         locks the salt itself, so the Portal records it as the locker that may launch.
    function initialize(address hub_, address creator_, address exchange_, Exchange.LaunchConfig calldata c)
        external
        payable
        initializer
    {
        if (hub_ == address(0) || creator_ == address(0) || exchange_ == address(0) || c.salt == bytes32(0)) {
            revert InvalidConfig();
        }
        hub = hub_;
        factory = msg.sender;
        exchange = exchange_;
        creator = creator_;
        launchSalt = c.salt;
        target = c.target;
        name = c.name;
        symbol = c.symbol;
        meta = c.imageURI;
        quoteToken = Exchange(exchange_).quoteToken();

        uint256 fee = IPortal(hub_).SALT_LOCK_FEE();
        if (msg.value != fee) revert InvalidConfig();
        IPortal(hub_).lockSalt{value: fee}(c.salt, uint8(IPortalTypes.LaunchKind.DIRECT_V2_POOL_TAX));
    }

    /// @notice The factory sets the Exchange launch id right after `registerLaunch`.
    function setLaunchId(uint256 id) external {
        if (msg.sender != factory) revert NotFactory();
        if (launchIdSet) revert InvalidConfig();
        launchIdSet = true;
        launchId = id;
    }

    /// @inheritdoc ILaunchRail
    /// @dev Native: `quoteAmount` arrives as value and is forwarded. ERC20: the Exchange transferred it here first;
    ///      the Portal is approved for exactly `quoteAmount` and pulls it inside `launchTaxTokenV2`.
    function launch(uint256 id, uint256 quoteAmount) external payable returns (address token_, address pool_) {
        if (msg.sender != exchange) revert NotExchange();
        if (launched) revert AlreadyLaunched();
        if (!launchIdSet || id != launchId) revert InvalidConfig();
        launched = true;

        address q = quoteToken;
        uint256 value;
        if (q == address(0)) {
            if (msg.value != quoteAmount) revert InvalidConfig();
            value = quoteAmount;
        } else {
            if (msg.value != 0) revert InvalidConfig();
            IERC20(q).forceApprove(hub, quoteAmount);
        }

        IPortalTypes.CreateTaxTokenParams memory p = _buildParams(quoteAmount);
        Distribution memory dist = Distribution({
            target: DistributionTarget.EXPLICIT,
            strategy: address(this),
            amount: uint128(LOSER_SUPPLY),
            configData: ""
        });
        IPortalTypes.CreatorBuyParams memory creatorBuy;

        launching = true;
        (token_, pool_) = IPortal(hub).launchTaxTokenV2{value: value}(p, dist, creatorBuy);
        launching = false;
        if (q != address(0)) IERC20(q).forceApprove(hub, 0);
        token = token_;
        pool = pool_;
        emit Launched(token_, pool_, quoteAmount, POOL_TOKEN);

        IERC20(token_).forceApprove(exchange, LOSER_SUPPLY);
        Exchange(exchange).receiveLoserTokens(id, token_, LOSER_SUPPLY);
    }

    /// @inheritdoc IStrategy
    /// @dev Portal callback inside `launch`: pull the whole approved 500M.
    function initializeDistribution(address token_, uint256 amount, bytes calldata, bytes32)
        external
        override
        onlyHub
    {
        if (!launching || distributionInitialized) revert UnauthorizedDistribution();
        if (token_ == address(0) || amount != LOSER_SUPPLY) revert InvalidConfig();
        distributionInitialized = true;
        IERC20(token_).safeTransferFrom(msg.sender, address(this), amount);
        emit FlapDistributionInitialized(token_, amount);
    }

    function _getHub() internal view override returns (address) {
        return hub;
    }

    function _description() internal view override returns (LauncherDescription memory d) {
        d.name = name;
        d.symbol = symbol;
        d.quoteToken = quoteToken;
        d.targetRaise = target;
        d.poolTokenRatio = (POOL_TOKEN * 1e18) / TOTAL_SUPPLY;
        d.titleZh = BL_TITLE_ZH;
        d.titleEn = BL_TITLE_EN;
        d.summaryZh = BL_SUMMARY_ZH;
        d.summaryEn = BL_SUMMARY_EN;
    }

    function _buildParams(uint256 poolQuote) internal view returns (IPortalTypes.CreateTaxTokenParams memory p) {
        p.name = name;
        p.symbol = symbol;
        p.meta = meta;
        p.totalSupply = TOTAL_SUPPLY;
        p.salt = launchSalt;
        p.quoteToken = quoteToken;
        p.dexId = 0;
        p.poolQuote = poolQuote;
        p.poolToken = POOL_TOKEN;
        p.buyTaxRate = TAX_BPS;
        p.sellTaxRate = TAX_BPS;
        p.taxDuration = 30 days;
        p.antiFarmerDuration = 1 days;
        p.feeConfigs = new IPortalTypes.FeeConfig[](1);
        p.feeConfigs[0] = IPortalTypes.FeeConfig({feeType: IPortalTypes.FeeSlotType.DEFLATION, bps: 10_000, configData: ""});
        p.exemptAddrs = new address[](0);
        (p.extensionID, p.extensionData) = LaunchExtensionHelper.encodeCreator(creator);
    }
}
