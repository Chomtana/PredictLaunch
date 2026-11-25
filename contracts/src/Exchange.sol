// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {Eip712} from "src/lib/Eip712.sol";
import {ISingleFeed} from "src/interfaces/ISingleFeed.sol";
import {ILaunchRail} from "src/interfaces/ILaunchRail.sol";

/// @title bilauncher Exchange
/// @notice Native-BNB custody, binary Up/Down markets (one per launch), batched settlement of signed orders, and
///         graduation of each launch's memecoin through its rail (a Flap Launcher). See SPEC.md.
contract Exchange is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------------------------------------------

    uint256 public constant FORCE_DELAY = 600;
    uint256 public constant MAX_LAG = 15;
    /// @dev Gas forwarded on a push payout; a receiver that needs more gets `pendingPayout` instead.
    uint256 internal constant PUSH_GAS = 10_000;
    uint256 public constant SHARE_UNIT = 1e16;
    uint256 public constant SNAP_TOLERANCE = 5;
    uint256 public constant GRACE = 60;
    uint256 public constant MIN_DURATION = 300;
    uint256 public constant MAX_DURATION = 30 days;
    uint256 public constant LOSER_SUPPLY = 500_000_000e18;

    uint8 public constant ACTIVE = 0;
    uint8 public constant GRADUATING = 1;
    uint8 public constant GRADUATED = 2;
    uint8 public constant FAILED = 3;
    uint8 internal constant UP = 0;
    uint8 internal constant DOWN = 1;
    uint8 internal constant VOID = 2;
    uint8 internal constant BUY = 0;
    uint8 internal constant SELL = 1;

    /// @notice EIP-712 domain: ("bilauncher", "1", chainid, this).
    bytes32 public immutable DOMAIN_SEPARATOR;

    // ---------------------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------------------

    /// @notice The creator's launch payload (`abi.encode(LaunchConfig)` is the Flap `newLauncher` data).
    struct LaunchConfig {
        string name;
        string symbol;
        string imageURI;
        address feed;
        uint256 strike;
        uint64 settleTime;
        uint16 cutBps;
        uint256 target;
        bytes32 salt;
    }

    /// @notice A launch and its single binary market. Also the storage layout.
    struct LaunchView {
        address creator;
        address rail;
        address feed;
        uint256 strike;
        uint64 settleTime;
        uint64 createdAt;
        uint16 cutBps;
        uint256 target;
        uint256 pairs;
        uint256 raised;
        uint8 status; // 0 Active, 1 Graduating, 2 Graduated, 3 Failed
        uint8 outcome; // 0 Up, 1 Down, 2 Void (valid once resolved)
        uint256 settlePrice;
        uint64 settleUpdatedAt;
        bool snapped;
        bool resolved;
        address token;
        uint256 totalLoserShares;
        string name;
        string symbol;
        string imageURI;
    }

    struct SignedOrder {
        Eip712.Order order;
        bytes sig;
    }

    struct KeyAuth {
        address owner;
        address key;
        uint64 expiry;
        uint64 nonce;
        bytes sig;
    }

    /// kind 0 Transfer, 1 Mint, 2 Merge; taker/maker index into `Batch.orders`.
    struct Fill {
        uint16 taker;
        uint16 maker;
        uint8 kind;
        uint128 amount;
    }

    struct Batch {
        uint64 ts;
        KeyAuth[] keys;
        SignedOrder[] orders;
        Fill[] fills;
        uint64 withdrawTo;
    }

    struct Position {
        uint128 up;
        uint128 down;
    }

    struct WithdrawRequest {
        address user;
        uint128 amount;
        uint64 requestedAt;
        bool done;
    }

    // ---------------------------------------------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------------------------------------------

    address public factory;
    mapping(address => bool) public operators;
    mapping(address => bool) public feedEnabled;
    uint256 public minTarget;

    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public pendingPayout;

    WithdrawRequest[] internal _withdraws;
    uint64 public withdrawProcessed;

    uint64 public lastBatchTs;
    uint64 public batchCount;

    mapping(address owner => mapping(address key => uint64)) public keyExpiry;
    mapping(address owner => mapping(uint64 nonce => bool)) public usedKeyNonce;
    mapping(bytes32 orderHash => bool) public cancelled;
    mapping(address owner => uint64) public minNonce;
    mapping(bytes32 orderHash => uint128) public filled;

    LaunchView[] internal _launches;
    mapping(uint256 id => mapping(address user => Position)) internal _positions;
    /// @notice Losing shares a user held at resolution (counted on redeem); claimable as memecoin after graduation.
    mapping(uint256 id => mapping(address user => uint256)) public loserShares;
    mapping(uint256 id => mapping(address user => uint256)) public claimedShares;
    /// @notice Set once the rail handed over LOSER_SUPPLY during `graduate`.
    mapping(uint256 id => bool) public loserTokensIn;

    // ---------------------------------------------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------------------------------------------

    event FactorySet(address factory);
    event OperatorSet(address op, bool on);
    event FeedSet(address feed, bool enabled);
    event MinTargetSet(uint256 minTarget);
    event Deposited(address user, uint256 amount);
    event WithdrawRequested(uint64 idx, address user, uint256 amount);
    event WithdrawPaid(uint64 idx, address user, uint256 requested, uint256 paid);
    event PayoutPending(address user, uint256 amount);
    event PayoutClaimed(address user, uint256 amount);
    event KeyAuthorized(address owner, address key, uint64 expiry);
    event KeyRevoked(address owner, address key);
    event OrderCancelled(address owner, bytes32 orderHash);
    event MinNonceBumped(address owner, uint64 minNonce);
    event LaunchCreated(
        uint256 launchId,
        address creator,
        address rail,
        address token,
        address feed,
        uint256 strike,
        uint64 settleTime,
        uint16 cutBps,
        uint256 target,
        string name,
        string symbol,
        string imageURI
    );
    event Snapshot(uint256 launchId, uint256 price, uint64 updatedAt);
    event Resolved(uint256 launchId, uint8 outcome, uint256 pairs, uint256 raised);
    event Graduating(uint256 launchId);
    event LaunchFailed(uint256 launchId);
    event Graduated(uint256 launchId, address token, uint256 raised);
    event Redeemed(uint256 launchId, address user, uint256 credit, uint256 loserShares);
    event TokensClaimed(uint256 launchId, address user, uint256 amount);
    event Trade(
        uint256 launchId, bytes32 takerHash, bytes32 makerHash, uint8 kind, uint8 makerPrice, uint128 amount
    );
    event BatchSubmitted(uint64 batchId, uint64 ts, uint256 fills);

    // ---------------------------------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------------------------------

    error NotOperator();
    error ZeroAmount();
    error BadIndex();
    error NotRequester();
    error AlreadyProcessed();
    error TooEarly();
    error NothingToClaim();
    error TransferFailed();
    error BadBatchTs();
    error BadSignature();
    error KeyNonceUsed();
    error NotOwner();
    error BadNonce();
    error OrderDead();
    error Expired();
    error BadOrder();
    error NotFactory();
    error FeedNotEnabled();
    error BadConfig();
    error BadDuration();
    error BadCut();
    error TargetTooLow();
    error UnknownLaunch();
    error NotActive();
    error NotInWindow();
    error StaleOrFuturePrice();
    error BadPrice();
    error AlreadySnapped();
    error AlreadyResolved();
    error BadFill();
    error BadAmount();
    error NotTradable();
    error BadCross();
    error Overfill();
    error InsufficientBalance();
    error InsufficientShares();
    error NotResolved();
    error NotGraduating();
    error NotGraduated();
    error NotRail();
    error LoserTokensMissing();
    error LoserTokensAlreadyIn();
    error BadToken();

    modifier onlyOperator() {
        if (!operators[msg.sender]) revert NotOperator();
        _;
    }

    constructor(address owner_) Ownable(owner_) {
        minTarget = 2.15 ether;
        DOMAIN_SEPARATOR = Eip712.domainSeparator(block.chainid, address(this));
    }

    // ---------------------------------------------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------------------------------------------

    function setFactory(address f) external onlyOwner {
        factory = f;
        emit FactorySet(f);
    }

    function setOperator(address op, bool on) external onlyOwner {
        operators[op] = on;
        emit OperatorSet(op, on);
    }

    function setFeed(address feed, bool enabled) external onlyOwner {
        feedEnabled[feed] = enabled;
        emit FeedSet(feed, enabled);
    }

    function setMinTarget(uint256 bnb) external onlyOwner {
        minTarget = bnb;
        emit MinTargetSet(bnb);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Funds
    // ---------------------------------------------------------------------------------------------------------

    function deposit() external payable {
        if (msg.value == 0) revert ZeroAmount();
        balanceOf[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    /// @notice Queue a withdrawal. Nothing is locked: the next batch pays `min(amount, balance)` at that time.
    function requestWithdraw(uint256 amount) external returns (uint64 idx) {
        if (amount == 0) revert ZeroAmount();
        idx = uint64(_withdraws.length);
        _withdraws.push(WithdrawRequest(msg.sender, uint128(amount), uint64(block.timestamp), false));
        emit WithdrawRequested(idx, msg.sender, amount);
    }

    /// @notice Escape hatch: a request left unprocessed for FORCE_DELAY can be paid by its requester.
    function forceWithdraw(uint64 idx) external nonReentrant {
        if (idx >= _withdraws.length) revert BadIndex();
        WithdrawRequest storage w = _withdraws[idx];
        if (w.user != msg.sender) revert NotRequester();
        if (w.done) revert AlreadyProcessed();
        if (block.timestamp < w.requestedAt + FORCE_DELAY) revert TooEarly();
        _processWithdraw(idx, w);
    }

    function claimPayout() external nonReentrant {
        uint256 amt = pendingPayout[msg.sender];
        if (amt == 0) revert NothingToClaim();
        pendingPayout[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amt}("");
        if (!ok) revert TransferFailed();
        emit PayoutClaimed(msg.sender, amt);
    }

    function withdrawQueueLength() external view returns (uint64) {
        return uint64(_withdraws.length);
    }

    function withdrawRequest(uint64 idx) external view returns (WithdrawRequest memory) {
        return _withdraws[idx];
    }

    function _processWithdraw(uint64 idx, WithdrawRequest storage w) internal {
        w.done = true;
        uint256 bal = balanceOf[w.user];
        uint256 paid = w.amount < bal ? w.amount : bal;
        balanceOf[w.user] = bal - paid;
        emit WithdrawPaid(idx, w.user, w.amount, paid);
        if (paid > 0) _payOut(w.user, paid);
    }

    /// @dev Push with a 10k-gas call; on failure the amount waits in `pendingPayout` for `claimPayout`.
    function _payOut(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount, gas: PUSH_GAS}("");
        if (!ok) {
            pendingPayout[to] += amount;
            emit PayoutPending(to, amount);
        }
    }

    // ---------------------------------------------------------------------------------------------------------
    // Keys, cancels, signatures
    // ---------------------------------------------------------------------------------------------------------

    function authorizeKey(address key, uint64 expiry) external {
        keyExpiry[msg.sender][key] = expiry;
        emit KeyAuthorized(msg.sender, key, expiry);
    }

    function revokeKey(address key) external {
        keyExpiry[msg.sender][key] = 0;
        emit KeyRevoked(msg.sender, key);
    }

    function cancelOrder(Eip712.Order calldata o) external {
        if (msg.sender != o.owner) revert NotOwner();
        bytes32 h = orderHash(o);
        cancelled[h] = true;
        emit OrderCancelled(msg.sender, h);
    }

    function bumpMinNonce(uint64 newMin) external {
        if (newMin <= minNonce[msg.sender]) revert BadNonce();
        minNonce[msg.sender] = newMin;
        emit MinNonceBumped(msg.sender, newMin);
    }

    function orderHash(Eip712.Order calldata o) public view returns (bytes32) {
        return Eip712.hashOrder(DOMAIN_SEPARATOR, o);
    }

    /// @dev Valid iff signed by the owner, or by a key of the owner whose expiry is >= ts.
    function _checkSig(Eip712.Order calldata o, bytes calldata sig, uint64 ts) internal view returns (bytes32 h) {
        h = orderHash(o);
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(h, sig);
        if (err != ECDSA.RecoverError.NoError || signer == address(0)) revert BadSignature();
        if (signer != o.owner) {
            uint64 exp = keyExpiry[o.owner][signer];
            if (exp == 0 || exp < ts) revert BadSignature();
        }
    }

    /// @dev Signature plus every per-order rule that does not depend on the launch.
    function _checkOrder(Eip712.Order calldata o, bytes calldata sig, uint64 ts) internal view returns (bytes32 h) {
        if (
            o.round != 0 || o.outcome > 1 || o.side > 1 || o.price == 0 || o.price > 99 || o.amount == 0
                || o.amount % SHARE_UNIT != 0
        ) revert BadOrder();
        if (o.expiry < ts) revert Expired();
        h = _checkSig(o, sig, ts);
        if (cancelled[h] || o.nonce < minNonce[o.owner]) revert OrderDead();
    }

    /// @dev An owner-signed AuthorizeKey carried in a batch; each (owner, nonce) is usable once.
    function _applyKeyAuth(KeyAuth calldata k) internal {
        if (usedKeyNonce[k.owner][k.nonce]) revert KeyNonceUsed();
        bytes32 h = Eip712.hashAuthorizeKey(DOMAIN_SEPARATOR, k.owner, k.key, k.expiry, k.nonce);
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(h, k.sig);
        if (err != ECDSA.RecoverError.NoError || signer != k.owner || signer == address(0)) revert BadSignature();
        usedKeyNonce[k.owner][k.nonce] = true;
        keyExpiry[k.owner][k.key] = k.expiry;
        emit KeyAuthorized(k.owner, k.key, k.expiry);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Launches: registration, settlement snapshot, resolution
    // ---------------------------------------------------------------------------------------------------------

    /// @notice Called by the factory inside `Portal.newLauncher`. `rail` is the launch's Flap Launcher and `token` the
    ///         memecoin address its salt predicts.
    function registerLaunch(address rail, address creator, address token, LaunchConfig calldata c)
        external
        returns (uint256 launchId)
    {
        if (msg.sender != factory) revert NotFactory();
        if (!feedEnabled[c.feed]) revert FeedNotEnabled();
        uint256 nameLen = bytes(c.name).length;
        uint256 symLen = bytes(c.symbol).length;
        if (
            c.strike == 0 || nameLen == 0 || nameLen > 32 || symLen == 0 || symLen > 10 || rail == address(0)
                || creator == address(0)
        ) revert BadConfig();
        if (c.settleTime < block.timestamp + MIN_DURATION || c.settleTime > block.timestamp + MAX_DURATION) {
            revert BadDuration();
        }
        uint16 cut = c.cutBps;
        if (cut < 1000 || cut > 3000 || cut % 500 != 0) revert BadCut();
        if (c.target < minTarget) revert TargetTooLow();

        launchId = _launches.length;
        LaunchView storage l = _launches.push();
        l.creator = creator;
        l.rail = rail;
        l.feed = c.feed;
        l.strike = c.strike;
        l.settleTime = c.settleTime;
        l.createdAt = uint64(block.timestamp);
        l.cutBps = cut;
        l.target = c.target;
        l.token = token;
        l.name = c.name;
        l.symbol = c.symbol;
        l.imageURI = c.imageURI;
        emit LaunchCreated(
            launchId, creator, rail, token, c.feed, c.strike, c.settleTime, cut, c.target, c.name, c.symbol, c.imageURI
        );
    }

    /// @notice Record the settlement price. Window `[settleTime, settleTime + GRACE]`; the feed must not have updated
    ///         more than SNAP_TOLERANCE after settleTime. First accepted call wins.
    function snapshot(uint256 id) external {
        LaunchView storage l = _launch(id);
        if (l.status != ACTIVE || l.resolved) revert NotActive();
        if (l.snapped) revert AlreadySnapped();
        uint256 st = l.settleTime;
        if (block.timestamp < st || block.timestamp > st + GRACE) revert NotInWindow();
        (, int256 answer,, uint256 updatedAt,) = ISingleFeed(l.feed).latestRoundData();
        if (updatedAt > st + SNAP_TOLERANCE) revert StaleOrFuturePrice();
        if (answer <= 0) revert BadPrice();
        l.snapped = true;
        l.settlePrice = uint256(answer);
        l.settleUpdatedAt = uint64(updatedAt);
        emit Snapshot(id, uint256(answer), uint64(updatedAt));
    }

    /// @notice Settle the market: after settleTime + MAX_LAG (every batch stamped before settleTime has landed), and
    ///         once snapped or the snapshot window has closed.
    function resolve(uint256 id) external {
        LaunchView storage l = _launch(id);
        if (l.resolved) revert AlreadyResolved();
        uint256 st = l.settleTime;
        if (block.timestamp < st + MAX_LAG || (!l.snapped && block.timestamp <= st + GRACE)) revert TooEarly();
        l.resolved = true;
        uint256 pairs = l.pairs;
        uint8 outcome;
        if (!l.snapped) {
            outcome = VOID;
            l.status = FAILED;
        } else {
            outcome = l.settlePrice >= l.strike ? UP : DOWN;
            l.totalLoserShares = pairs;
            uint256 raised = uint256(pairs) * l.cutBps / 10_000;
            if (raised >= l.target) {
                l.raised = raised;
                l.status = GRADUATING;
                emit Graduating(id);
            } else {
                l.status = FAILED;
            }
        }
        l.outcome = outcome;
        if (l.status == FAILED) emit LaunchFailed(id);
        emit Resolved(id, outcome, pairs, l.raised);
    }

    /// @notice Settle positions after resolution. Void: every share 0.50. Graduating/Graduated: winners get
    ///         `1 - cut` per share, losers' shares are counted for the memecoin. Failed (non-void): winners get 1.00.
    function redeem(uint256 id, address[] calldata users) external {
        LaunchView storage l = _launch(id);
        if (!l.resolved) revert NotResolved();
        uint8 outcome = l.outcome;
        bool failed = l.status == FAILED;
        uint256 cut = l.cutBps;
        for (uint256 i; i < users.length; ++i) {
            address u = users[i];
            Position storage p = _positions[id][u];
            uint256 up = p.up;
            uint256 down = p.down;
            if (up == 0 && down == 0) continue;
            delete _positions[id][u];
            uint256 credit;
            uint256 lose;
            if (outcome == VOID) {
                credit = (up + down) / 2;
            } else {
                (uint256 win, uint256 los) = outcome == UP ? (up, down) : (down, up);
                if (failed) {
                    credit = win;
                } else {
                    credit = win * (10_000 - cut) / 10_000;
                    lose = los;
                    if (lose > 0) loserShares[id][u] += lose;
                }
            }
            if (credit > 0) balanceOf[u] += credit;
            emit Redeemed(id, u, credit, lose);
        }
    }

    /// @notice Graduating -> Graduated: hand `raised` to the rail, which launches the memecoin and must give the
    ///         Exchange exactly LOSER_SUPPLY (via `receiveLoserTokens`) before returning. Permissionless.
    function graduate(uint256 id) external nonReentrant {
        LaunchView storage l = _launch(id);
        if (l.status != GRADUATING) revert NotGraduating();
        l.status = GRADUATED;
        uint256 raised = l.raised;
        (address token,) = ILaunchRail(l.rail).launch{value: raised}(id);
        if (!loserTokensIn[id]) revert LoserTokensMissing();
        if (token != l.token) revert BadToken();
        emit Graduated(id, token, raised);
    }

    /// @notice Rail only, during `graduate`: pulls the losers' LOSER_SUPPLY of the launch's memecoin.
    function receiveLoserTokens(uint256 id, address token, uint256 amount) external {
        LaunchView storage l = _launch(id);
        if (msg.sender != l.rail) revert NotRail();
        if (l.status != GRADUATED) revert NotGraduated();
        if (loserTokensIn[id]) revert LoserTokensAlreadyIn();
        if (token != l.token || amount != LOSER_SUPPLY) revert BadToken();
        loserTokensIn[id] = true;
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        if (IERC20(token).balanceOf(address(this)) - before != amount) revert BadToken();
    }

    /// @notice Pays `(loserShares - claimedShares) * LOSER_SUPPLY / totalLoserShares`; callable again as more of
    ///         the caller's losing shares get redeemed.
    function claimTokens(uint256 id) external nonReentrant {
        LaunchView storage l = _launch(id);
        if (l.status != GRADUATED) revert NotGraduated();
        uint256 owed = claimableTokens(id, msg.sender);
        if (owed == 0) revert NothingToClaim();
        claimedShares[id][msg.sender] = loserShares[id][msg.sender];
        IERC20(l.token).safeTransfer(msg.sender, owed);
        emit TokensClaimed(id, msg.sender, owed);
    }

    function claimableTokens(uint256 id, address u) public view returns (uint256) {
        LaunchView storage l = _launch(id);
        uint256 total = l.totalLoserShares;
        if (l.status != GRADUATED || total == 0) return 0;
        return (loserShares[id][u] - claimedShares[id][u]) * LOSER_SUPPLY / total;
    }

    function launchCount() external view returns (uint256) {
        return _launches.length;
    }

    function getLaunch(uint256 id) external view returns (LaunchView memory) {
        return _launches[id];
    }

    function isTradable(uint256 id, uint64 ts) public view returns (bool) {
        if (id >= _launches.length) return false;
        LaunchView storage l = _launches[id];
        return l.status == ACTIVE && !l.resolved && ts < l.settleTime;
    }

    /// @notice `pairs x cut / 10000` while unresolved (what resolution would raise now); the final `raised` after.
    function projectedRaised(uint256 id) external view returns (uint256) {
        LaunchView storage l = _launch(id);
        if (l.resolved) return l.raised;
        return uint256(l.pairs) * l.cutBps / 10_000;
    }

    function _launch(uint256 id) internal view returns (LaunchView storage) {
        if (id >= _launches.length) revert UnknownLaunch();
        return _launches[id];
    }

    // ---------------------------------------------------------------------------------------------------------
    // Batches
    // ---------------------------------------------------------------------------------------------------------

    function submitBatch(Batch calldata b) external onlyOperator nonReentrant {
        if (b.ts < lastBatchTs || b.ts > block.timestamp || block.timestamp - b.ts > MAX_LAG) revert BadBatchTs();
        lastBatchTs = b.ts;
        uint64 id = ++batchCount;

        for (uint256 i; i < b.keys.length; ++i) {
            _applyKeyAuth(b.keys[i]);
        }
        // every order is verified once per batch; fills then reference them by index
        uint256 n = b.orders.length;
        bytes32[] memory hashes = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            hashes[i] = _checkOrder(b.orders[i].order, b.orders[i].sig, b.ts);
        }
        for (uint256 i; i < b.fills.length; ++i) {
            Fill calldata f = b.fills[i];
            if (f.taker == f.maker || f.taker >= n || f.maker >= n) revert BadFill();
            _applyFill(b.orders[f.taker].order, b.orders[f.maker].order, hashes[f.taker], hashes[f.maker], f, b.ts);
        }

        uint64 to = b.withdrawTo;
        if (to > _withdraws.length) revert BadIndex();
        for (uint64 i = withdrawProcessed; i < to; ++i) {
            WithdrawRequest storage w = _withdraws[i];
            if (!w.done) _processWithdraw(i, w);
        }
        if (to > withdrawProcessed) withdrawProcessed = to;
        emit BatchSubmitted(id, b.ts, b.fills.length);
    }

    /// @dev One fill at the maker's price. Transfer: shares one way, BNB the other. Mint: both buy opposite outcomes,
    ///      a new pair backed by exactly 1 BNB. Merge: both sell opposite outcomes, a pair is burned and its 1 BNB paid.
    function _applyFill(
        Eip712.Order calldata t,
        Eip712.Order calldata m,
        bytes32 th,
        bytes32 mh,
        Fill calldata f,
        uint64 ts
    ) internal {
        uint128 amt = f.amount;
        if (amt == 0 || amt % SHARE_UNIT != 0) revert BadAmount();
        if (t.launchId != m.launchId) revert BadFill();
        uint256 id = t.launchId;
        if (!isTradable(id, ts)) revert NotTradable();
        _addFilled(th, t.amount, amt);
        _addFilled(mh, m.amount, amt);

        uint8 pm = m.price;
        // exact: amt is a multiple of 1e16
        uint256 makerValue = uint256(amt) * pm / 100;
        uint256 takerValue = uint256(amt) - makerValue;
        uint8 kind = f.kind;
        if (kind == 0) {
            if (t.outcome != m.outcome || t.side == m.side) revert BadCross();
            if (t.side == BUY) {
                if (pm > t.price) revert BadCross();
                _transfer(id, t.outcome, m.owner, t.owner, amt, makerValue);
            } else {
                if (pm < t.price) revert BadCross();
                _transfer(id, t.outcome, t.owner, m.owner, amt, makerValue);
            }
        } else if (kind == 1) {
            if (t.side != BUY || m.side != BUY || t.outcome == m.outcome || uint256(t.price) + pm < 100) {
                revert BadCross();
            }
            _debit(m.owner, makerValue);
            _debit(t.owner, takerValue);
            _addShares(id, m.owner, m.outcome, amt);
            _addShares(id, t.owner, t.outcome, amt);
            _launches[id].pairs += amt;
        } else if (kind == 2) {
            if (t.side != SELL || m.side != SELL || t.outcome == m.outcome || uint256(t.price) + pm > 100) {
                revert BadCross();
            }
            _subShares(id, m.owner, m.outcome, amt);
            _subShares(id, t.owner, t.outcome, amt);
            balanceOf[m.owner] += makerValue;
            balanceOf[t.owner] += takerValue;
            _launches[id].pairs -= amt;
        } else {
            revert BadFill();
        }
        emit Trade(id, th, mh, kind, pm, amt);
    }

    function _transfer(uint256 id, uint8 outcome, address seller, address buyer, uint128 amt, uint256 cost)
        internal
    {
        _debit(buyer, cost);
        balanceOf[seller] += cost;
        _subShares(id, seller, outcome, amt);
        _addShares(id, buyer, outcome, amt);
    }

    function _addFilled(bytes32 h, uint128 orderAmount, uint128 amt) internal {
        uint128 nf = filled[h] + amt;
        if (nf > orderAmount) revert Overfill();
        filled[h] = nf;
    }

    function _debit(address u, uint256 amt) internal {
        uint256 bal = balanceOf[u];
        if (bal < amt) revert InsufficientBalance();
        balanceOf[u] = bal - amt;
    }

    function _addShares(uint256 id, address u, uint8 outcome, uint128 amt) internal {
        Position storage p = _positions[id][u];
        if (outcome == UP) p.up += amt;
        else p.down += amt;
    }

    function _subShares(uint256 id, address u, uint8 outcome, uint128 amt) internal {
        Position storage p = _positions[id][u];
        if (outcome == UP) {
            if (p.up < amt) revert InsufficientShares();
            p.up -= amt;
        } else {
            if (p.down < amt) revert InsufficientShares();
            p.down -= amt;
        }
    }

    function position(uint256 id, address u) external view returns (uint128 up, uint128 down) {
        Position storage p = _positions[id][u];
        return (p.up, p.down);
    }
}
