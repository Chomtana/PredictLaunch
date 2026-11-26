// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Exchange} from "src/Exchange.sol";
import {Eip712} from "src/lib/Eip712.sol";
import {ExchangeHarness} from "test/helpers/ExchangeHarness.sol";

contract KeysTest is Test {
    ExchangeHarness ex;
    address owner = makeAddr("owner");
    uint256 constant ALICE_PK = 0xA11CE;
    uint256 constant KEY_PK = 0x4E7;
    address alice = vm.addr(ALICE_PK);
    address key = vm.addr(KEY_PK);
    uint64 constant T = 1_800_000_000;

    function setUp() public {
        vm.warp(T);
        ex = new ExchangeHarness(owner);
    }

    function _order(uint64 nonce) internal view returns (Eip712.Order memory) {
        return Eip712.Order(alice, 0, 0, 0, 0, 50, 1e18, T + 1000, nonce);
    }

    function _sign(Eip712.Order memory o, uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, ex.orderHash(o));
        return abi.encodePacked(r, s, v);
    }

    function _keyAuth(address k, uint64 expiry, uint64 nonce, uint256 pk)
        internal
        view
        returns (Exchange.KeyAuth memory a)
    {
        bytes32 h = Eip712.hashAuthorizeKey(ex.DOMAIN_SEPARATOR(), alice, k, expiry, nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, h);
        a = Exchange.KeyAuth(alice, k, expiry, nonce, abi.encodePacked(r, s, v));
    }

    function _u(string memory j, string memory path) internal pure returns (uint256) {
        return vm.parseUint(vm.parseJsonString(j, path));
    }

    function _vecOrder(string memory j, uint256 i) internal pure returns (Eip712.Order memory o) {
        string memory p = string.concat(".orders[", vm.toString(i), "].order.");
        o.owner = vm.parseJsonAddress(j, string.concat(p, "owner"));
        o.launchId = _u(j, string.concat(p, "launchId"));
        o.round = uint32(_u(j, string.concat(p, "round")));
        o.outcome = uint8(_u(j, string.concat(p, "outcome")));
        o.side = uint8(_u(j, string.concat(p, "side")));
        o.price = uint8(_u(j, string.concat(p, "price")));
        o.amount = uint128(_u(j, string.concat(p, "amount")));
        o.expiry = uint64(_u(j, string.concat(p, "expiry")));
        o.nonce = uint64(_u(j, string.concat(p, "nonce")));
    }

    function test_vectorsMatch() public {
        string memory j = vm.readFile("../fixtures/eip712-vectors.json");
        address verifying = vm.parseJsonAddress(j, ".domain.verifyingContract");
        vm.chainId(97);
        deployCodeTo("ExchangeHarness.sol:ExchangeHarness", abi.encode(owner), verifying);
        ExchangeHarness v = ExchangeHarness(verifying);
        assertEq(v.DOMAIN_SEPARATOR(), vm.parseJsonBytes32(j, ".domain.separator"));
        for (uint256 i; i < 3; ++i) {
            Eip712.Order memory o = _vecOrder(j, i);
            bytes32 h = vm.parseJsonBytes32(j, string.concat(".orders[", vm.toString(i), "].hash"));
            assertEq(v.orderHash(o), h, "orderHash == vector");
        }
        // the key vector authorizes the trading key that signed order 2
        Exchange.KeyAuth memory a;
        a.owner = vm.parseJsonAddress(j, ".keys[0].auth.owner");
        a.key = vm.parseJsonAddress(j, ".keys[0].auth.key");
        a.expiry = uint64(_u(j, ".keys[0].auth.expiry"));
        a.nonce = uint64(_u(j, ".keys[0].auth.nonce"));
        a.sig = vm.parseJsonBytes(j, ".keys[0].sig");
        v.applyKeyAuth(a);
        assertEq(v.keyExpiry(a.owner, a.key), a.expiry);
        Eip712.Order memory o0 = _vecOrder(j, 0);
        assertEq(v.checkSig(o0, vm.parseJsonBytes(j, ".orders[0].sig"), T), vm.parseJsonBytes32(j, ".orders[0].hash"));
        Eip712.Order memory o2 = _vecOrder(j, 2);
        assertEq(v.checkSig(o2, vm.parseJsonBytes(j, ".orders[2].sig"), T), vm.parseJsonBytes32(j, ".orders[2].hash"));
    }

    function test_keySignsUntilExpiry() public {
        Eip712.Order memory o = _order(1);
        bytes memory sig = _sign(o, KEY_PK);
        vm.expectRevert(Exchange.BadSignature.selector);
        ex.checkSig(o, sig, T);
        vm.prank(alice);
        vm.expectEmit(address(ex));
        emit Exchange.KeyAuthorized(alice, key, T + 100);
        ex.authorizeKey(key, T + 100);
        assertEq(ex.checkSig(o, sig, T + 100), ex.orderHash(o));
        vm.expectRevert(Exchange.BadSignature.selector);
        ex.checkSig(o, sig, T + 101);
        // the owner's own signature always works
        bytes memory own = _sign(o, ALICE_PK);
        assertEq(ex.checkSig(o, own, T + 101), ex.orderHash(o));
        // garbage signature
        vm.expectRevert(Exchange.BadSignature.selector);
        ex.checkSig(o, hex"1234", T);
    }

    function test_revokedKeyRejected() public {
        Eip712.Order memory o = _order(1);
        bytes memory sig = _sign(o, KEY_PK);
        ex.applyKeyAuth(_keyAuth(key, T + 100, 1, ALICE_PK));
        assertEq(ex.checkSig(o, sig, T), ex.orderHash(o));
        vm.prank(alice);
        vm.expectEmit(address(ex));
        emit Exchange.KeyRevoked(alice, key);
        ex.revokeKey(key);
        vm.expectRevert(Exchange.BadSignature.selector);
        ex.checkSig(o, sig, T);
    }

    function test_keyAuthReplayRejected() public {
        Exchange.KeyAuth memory a = _keyAuth(key, T + 100, 7, ALICE_PK);
        ex.applyKeyAuth(a);
        vm.prank(alice);
        ex.revokeKey(key);
        // a replay is a no-op: the revoked key stays revoked
        ex.applyKeyAuth(a);
        assertEq(ex.keyExpiry(alice, key), 0);
        // signed by someone other than the owner
        Exchange.KeyAuth memory bad = _keyAuth(key, T + 100, 8, KEY_PK);
        vm.expectRevert(Exchange.BadSignature.selector);
        ex.applyKeyAuth(bad);
    }

    function test_cancelledAndBelowMinNonceRejected() public {
        Eip712.Order memory o = _order(5);
        bytes memory sig = _sign(o, ALICE_PK);
        assertEq(ex.checkOrder(o, sig, T), ex.orderHash(o));
        // cancel: owner only
        vm.expectRevert(Exchange.NotOwner.selector);
        ex.cancelOrder(o);
        bytes32 h = ex.orderHash(o);
        vm.prank(alice);
        vm.expectEmit(address(ex));
        emit Exchange.OrderCancelled(alice, h);
        ex.cancelOrder(o);
        assertEq(ex.checkOrder(o, sig, T), bytes32(0), "cancelled: dead");

        Eip712.Order memory o6 = _order(6);
        bytes memory sig6 = _sign(o6, ALICE_PK);
        assertEq(ex.checkOrder(o6, sig6, T), ex.orderHash(o6));
        vm.prank(alice);
        vm.expectEmit(address(ex));
        emit Exchange.MinNonceBumped(alice, 7);
        ex.bumpMinNonce(7);
        assertEq(ex.checkOrder(o6, sig6, T), bytes32(0), "below minNonce: dead");
        // min nonce only goes up
        vm.prank(alice);
        vm.expectRevert(Exchange.BadNonce.selector);
        ex.bumpMinNonce(7);
        // nonce == minNonce is alive
        Eip712.Order memory o7 = _order(7);
        bytes memory sig7 = _sign(o7, ALICE_PK);
        assertEq(ex.checkOrder(o7, sig7, T), ex.orderHash(o7));
        // expired
        assertEq(ex.checkOrder(o7, sig7, T + 1001), bytes32(0), "expired: dead");
    }
}
