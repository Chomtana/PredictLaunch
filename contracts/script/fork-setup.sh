#!/usr/bin/env bash
# Fork-only setup after `ALL_FEEDS=true forge script script/Deploy.s.sol` (needs an anvil cheat RPC, so it cannot
# live in the script): authorize the Exchange on every Atlas feed in script/feeds.json. The feeds revert
# OnlyAuthorizedCallerAllowed() unless msg.sender == tx.origin or msg.sender is an authorized caller; the
# authorized-caller mapping is storage slot 1, so we set keccak256(abi.encode(exchange, 1)) = 1.
# On real BSC testnet this step does not exist: Deploy enables only the feeds with a Chainlink fallback instead.
# (The factory is enabled on the Flap Portal by Deploy itself, through Flap's testnet whitelist helper, on the fork
# and on real testnet alike.)
# Usage: contracts/script/fork-setup.sh [RPC_URL=http://127.0.0.1:8545] [DEPLOY_JSON=.dev/deploy.json]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
RPC="${1:-http://127.0.0.1:8545}"
DEPLOY="${2:-$here/../../.dev/deploy.json}"

exchange=$(jq -r .exchange "$DEPLOY")

for feed in $(jq -r '.[].address' "$here/feeds.json"); do
  slot=$(cast keccak "$(cast abi-encode 'f(address,uint256)' "$exchange" 1)")
  cast rpc --rpc-url "$RPC" anvil_setStorageAt "$feed" "$slot" \
    0x0000000000000000000000000000000000000000000000000000000000000001 >/dev/null
done
echo "authorized exchange $exchange on $(jq length "$here/feeds.json") feeds"

