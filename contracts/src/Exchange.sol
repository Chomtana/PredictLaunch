// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {Eip712} from "src/lib/Eip712.sol";

/// @title bilauncher Exchange
/// @notice Native-BNB custody, binary Up/Down markets (one per launch), batched settlement of signed orders, and
///         graduation of each launch's memecoin through its rail (a Flap Launcher). See SPEC.md.
contract Exchange is Ownable, ReentrancyGuard {
    // ---------------------------------------------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------------------------------------------

    uint256 public constant FORCE_DELAY = 600;
    uint256 public constant MAX_LAG = 15;
    /// @dev Gas forwarded on a push payout; a receiver that needs more gets `pendingPayout` instead.
    uint256 internal constant PUSH_GAS = 10_000;
    uint256 public constant SHARE_UNIT = 1e16;

    /// @notice EIP-712 domain: ("bilauncher", "1", chainid, this).
    bytes32 public immutable DOMAIN_SEPARATOR;

    // ---------------------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------------------

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

    // ---------------------------------------------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------------------------------------------

    event FactorySet(address factory);
    event OperatorSet(address indexed op, bool on);
    event FeedSet(address indexed feed, bool enabled);
    event MinTargetSet(uint256 minTarget);
    event Deposited(address indexed user, uint256 amount);
    event WithdrawRequested(uint64 indexed idx, address indexed user, uint256 amount);
    event WithdrawPaid(uint64 indexed idx, address indexed user, uint256 requested, uint256 paid);
    event PayoutPending(address indexed user, uint256 amount);
    event PayoutClaimed(address indexed user, uint256 amount);
    event KeyAuthorized(address indexed owner, address indexed key, uint64 expiry);
    event KeyRevoked(address indexed owner, address indexed key);
    event OrderCancelled(address indexed owner, bytes32 indexed orderHash);
    event MinNonceBumped(address indexed owner, uint64 minNonce);
    event BatchSubmitted(uint64 indexed batchId, uint64 ts, uint256 fills);

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
    // Batches
    // ---------------------------------------------------------------------------------------------------------

    function submitBatch(Batch calldata b) external onlyOperator nonReentrant {
        if (b.ts < lastBatchTs || b.ts > block.timestamp || block.timestamp - b.ts > MAX_LAG) revert BadBatchTs();
        lastBatchTs = b.ts;
        uint64 id = ++batchCount;

        uint64 to = b.withdrawTo;
        if (to > _withdraws.length) revert BadIndex();
        for (uint64 i = withdrawProcessed; i < to; ++i) {
            WithdrawRequest storage w = _withdraws[i];
            if (!w.done) _processWithdraw(i, w);
        }
        if (to > withdrawProcessed) withdrawProcessed = to;
        emit BatchSubmitted(id, b.ts, b.fills.length);
    }
}
