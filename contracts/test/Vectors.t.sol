// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Eip712} from "src/lib/Eip712.sol";

/// Writes ../fixtures/eip712-vectors.json: the shared EIP-712 test vectors for the contracts, the Rust sequencer
/// (core/tests/vectors.rs) and the frontend (frontend/src/lib/eip712.test.ts). All numbers are decimal strings.
contract VectorsTest is Test {
    uint256 constant CHAIN_ID = 97;
    address constant VERIFYING = 0x00000000000000000000000000000000000e8C4A;
    // anvil #0 (Alice) and #1 (Bob): public dev keys.
    uint256 constant ALICE_PK = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 constant BOB_PK = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;

    bytes32 domain;

    function _sig(uint256 pk, bytes32 h) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, h);
        return abi.encodePacked(r, s, v);
    }

    function _orderJson(string memory key, Eip712.Order memory o, uint256 pk) internal returns (string memory) {
        bytes32 h = Eip712.hashOrder(domain, o);
        bytes memory sig = _sig(pk, h);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, h);
        assertEq(ecrecover(h, v, r, s), vm.addr(pk), "order sig recovers");
        string memory oj = string.concat(key, ".order");
        vm.serializeAddress(oj, "owner", o.owner);
        vm.serializeString(oj, "launchId", vm.toString(o.launchId));
        vm.serializeString(oj, "round", vm.toString(uint256(o.round)));
        vm.serializeString(oj, "outcome", vm.toString(uint256(o.outcome)));
        vm.serializeString(oj, "side", vm.toString(uint256(o.side)));
        vm.serializeString(oj, "price", vm.toString(uint256(o.price)));
        vm.serializeString(oj, "amount", vm.toString(uint256(o.amount)));
        vm.serializeString(oj, "expiry", vm.toString(uint256(o.expiry)));
        string memory orderOut = vm.serializeString(oj, "nonce", vm.toString(uint256(o.nonce)));
        vm.serializeString(key, "order", orderOut);
        vm.serializeBytes32(key, "hash", h);
        vm.serializeAddress(key, "signer", vm.addr(pk));
        return vm.serializeBytes(key, "sig", sig);
    }

    function test_writeVectors() public {
        domain = Eip712.domainSeparator(CHAIN_ID, VERIFYING);
        address alice = vm.addr(ALICE_PK);
        address bob = vm.addr(BOB_PK);
        uint256 keyPk = uint256(keccak256("predictlaunch-key"));
        address key = vm.addr(keyPk);

        Eip712.Order[3] memory os = [
            Eip712.Order(alice, 0, 0, 0, 0, 50, 2.5e18, 1_900_000_000, 1),
            Eip712.Order(bob, 0, 7, 1, 1, 37, 2.5e18, 1_900_000_000, 2),
            Eip712.Order(alice, 3, 12, 1, 0, 99, 1e16, 1_900_000_000, 18446744073709551615)
        ];
        string[] memory orders = new string[](3);
        orders[0] = _orderJson("o0", os[0], ALICE_PK);
        orders[1] = _orderJson("o1", os[1], BOB_PK);
        // order signed by Alice's trading key (owner stays Alice)
        orders[2] = _orderJson("o2", os[2], keyPk);

        // AuthorizeKey: Alice authorizes `key`
        bytes32 kh = Eip712.hashAuthorizeKey(domain, alice, key, 1_900_000_000, 42);
        vm.serializeAddress("k0.auth", "owner", alice);
        vm.serializeAddress("k0.auth", "key", key);
        vm.serializeString("k0.auth", "expiry", "1900000000");
        string memory authOut = vm.serializeString("k0.auth", "nonce", "42");
        vm.serializeString("k0", "auth", authOut);
        vm.serializeBytes32("k0", "hash", kh);
        vm.serializeAddress("k0", "signer", alice);
        string[] memory keys = new string[](1);
        keys[0] = vm.serializeBytes("k0", "sig", _sig(ALICE_PK, kh));

        // Cancel of order 0, signed by Alice
        bytes32 oh = Eip712.hashOrder(domain, os[0]);
        bytes32 ch = Eip712.hashCancel(domain, alice, oh, 7);
        vm.serializeAddress("c0.cancel", "owner", alice);
        vm.serializeBytes32("c0.cancel", "orderHash", oh);
        string memory cancelOut = vm.serializeString("c0.cancel", "nonce", "7");
        vm.serializeString("c0", "cancel", cancelOut);
        vm.serializeBytes32("c0", "hash", ch);
        vm.serializeAddress("c0", "signer", alice);
        string[] memory cancels = new string[](1);
        cancels[0] = vm.serializeBytes("c0", "sig", _sig(ALICE_PK, ch));

        vm.serializeString("domain", "name", "predictlaunch");
        vm.serializeString("domain", "version", "1");
        vm.serializeString("domain", "chainId", vm.toString(CHAIN_ID));
        vm.serializeBytes32("domain", "separator", domain);
        string memory domainOut = vm.serializeAddress("domain", "verifyingContract", VERIFYING);

        vm.serializeString("root", "domain", domainOut);
        vm.serializeAddress("root", "tradingKey", key);
        vm.serializeString("root", "orders", _arr(orders));
        vm.serializeString("root", "keys", _arr(keys));
        string memory out = vm.serializeString("root", "cancels", _arr(cancels));
        // serializeString of an array-literal string would be quoted; patch arrays in as raw JSON.
        out = _unquoteArrays(out);
        vm.writeFile("../fixtures/eip712-vectors.json", out);

        // round-trip: the written file parses and the first hash survives
        string memory back = vm.readFile("../fixtures/eip712-vectors.json");
        assertEq(vm.parseJsonBytes32(back, ".orders[0].hash"), Eip712.hashOrder(domain, os[0]));
        assertEq(vm.parseJsonAddress(back, ".orders[2].signer"), key);
    }

    function _arr(string[] memory items) internal pure returns (string memory s) {
        s = "[";
        for (uint256 i; i < items.length; ++i) {
            s = string.concat(s, i == 0 ? "" : ",", items[i]);
        }
        s = string.concat(s, "]");
    }

    /// vm.serializeString escapes the array text as a JSON string; turn `"[...]"` back into a raw array.
    function _unquoteArrays(string memory s) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        bytes memory out = new bytes(b.length);
        uint256 n;
        for (uint256 i; i < b.length; ++i) {
            if (b[i] == '"' && i + 1 < b.length && b[i + 1] == "[") continue;
            if (b[i] == '"' && i > 0 && b[i - 1] == "]") continue;
            if (b[i] == "\\" && i + 1 < b.length && b[i + 1] == '"') continue;
            out[n++] = b[i];
        }
        assembly {
            mstore(out, n)
        }
        return string(out);
    }
}
