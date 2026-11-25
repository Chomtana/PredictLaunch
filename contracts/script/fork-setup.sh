#!/usr/bin/env bash
# Fork-only setup after `forge script script/Deploy.s.sol` (needs anvil cheat RPCs, so it cannot live in the script):
#   1. authorize the Exchange on every Atlas feed in script/feeds.json. The feeds revert
#      OnlyAuthorizedCallerAllowed() unless msg.sender == tx.origin or msg.sender is an authorized caller; the
#      authorized-caller mapping is storage slot 1, so we set keccak256(abi.encode(exchange, 1)) = 1.
#   2. open the factory on the Flap Portal: impersonate the ProxyAdmin owner and call
#      setLauncherFactoryMultiplier(factory, 10000, true). (The testnet Portal does not currently require it, see
#      SPEC-NOTES.md, but it is what Flap does for a real factory.)
# Usage: contracts/script/fork-setup.sh [RPC_URL=http://127.0.0.1:8545] [DEPLOY_JSON=.dev/deploy.json]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
RPC="${1:-http://127.0.0.1:8545}"
DEPLOY="${2:-$here/../../.dev/deploy.json}"
PORTAL=0x000042108465206185A077Edc3F3fd2b49060000
PROXY_ADMIN=0x0000Ed588dfc01749C20bA69b5f8c77d706E0000

exchange=$(jq -r .exchange "$DEPLOY")
factory=$(jq -r .factory "$DEPLOY")

for feed in $(jq -r '.[].address' "$here/feeds.json"); do
  slot=$(cast keccak "$(cast abi-encode 'f(address,uint256)' "$exchange" 1)")
  cast rpc --rpc-url "$RPC" anvil_setStorageAt "$feed" "$slot" \
    0x0000000000000000000000000000000000000000000000000000000000000001 >/dev/null
done
echo "authorized exchange $exchange on $(jq length "$here/feeds.json") feeds"

admin=$(cast call --rpc-url "$RPC" "$PROXY_ADMIN" 'owner()(address)')
cast rpc --rpc-url "$RPC" anvil_setBalance "$admin" 0x56BC75E2D63100000 >/dev/null
cast rpc --rpc-url "$RPC" anvil_impersonateAccount "$admin" >/dev/null
cast send --rpc-url "$RPC" --unlocked --from "$admin" "$PORTAL" \
  'setLauncherFactoryMultiplier(address,uint16,bool)' "$factory" 10000 true >/dev/null
cast rpc --rpc-url "$RPC" anvil_stopImpersonatingAccount "$admin" >/dev/null
echo "opened factory $factory on the Portal"
