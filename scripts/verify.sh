#!/usr/bin/env bash
# Verify on BscScan (Etherscan V2 API, chain 97) every contract a deployment created: each CREATE of a forge
# broadcast plus the contracts their constructors created (e.g. the Flap factory's beacon and Launcher impl).
#
#   scripts/verify.sh <broadcast.json> [...]      default: deployments/bsc-testnet/broadcast-*.json (saved by testnet.sh)
#
# Needs ETHERSCAN_API_KEY (an etherscan.io key; V2 covers BscScan testnet) and BSC_TESTNET_RPC_URL in .env.
# Safe to re-run: already-verified contracts are skipped. Constructor arguments are recovered from the chain.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$ROOT/.env" ]; then set -a; . "$ROOT/.env"; set +a; fi
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
[ -n "${ETHERSCAN_API_KEY:-}" ] || { echo "verify: set ETHERSCAN_API_KEY in .env (an etherscan.io API key)" >&2; exit 1; }
[ -n "${BSC_TESTNET_RPC_URL:-}" ] || { echo "verify: set BSC_TESTNET_RPC_URL in .env" >&2; exit 1; }
scrub() { perl -pe 'BEGIN { $u = $ENV{BSC_TESTNET_RPC_URL}; $k = $ENV{ETHERSCAN_API_KEY} } s/\Q$u\E/<live-rpc>/g; s/\Q$k\E/<api-key>/g'; }

files=("$@")
if [ ${#files[@]} = 0 ]; then
  shopt -s nullglob
  files=("$ROOT"/deployments/bsc-testnet/broadcast-*.json)
fi
[ ${#files[@]} -gt 0 ] || { echo "verify: no broadcast files (deploy with scripts/testnet.sh first)" >&2; exit 1; }

failed=0
cd "$ROOT/contracts"
for f in "${files[@]}"; do
  [ "$(jq -r '.chain' "$f")" = 97 ] || { echo "verify: $f is not a chain-97 broadcast, skipped"; continue; }
  # name address, for direct creates and their nested (constructor) creates
  while read -r name addr; do
    [ -n "$name" ] && [ "$name" != null ] || continue
    printf 'verify: %-30s %s ... ' "$name" "$addr"
    out="$(forge verify-contract "$addr" "$name" --chain 97 --etherscan-api-key "$ETHERSCAN_API_KEY" \
      --rpc-url "$BSC_TESTNET_RPC_URL" --guess-constructor-args --watch --retries 10 --delay 10 2>&1 | scrub || true)"
    if grep -qiE 'already verified' <<<"$out"; then echo "already verified"
    elif grep -qiE 'Pass - Verified|successfully verified|Contract successfully verified' <<<"$out"; then echo "verified"
    else echo "FAILED"; echo "$out" | tail -5 | sed 's/^/    /'; failed=1
    fi
  done < <(jq -r '.transactions[] | select(.transactionType == "CREATE") | "\(.contractName) \(.contractAddress)",
                  (.additionalContracts[]? | "\(.contractName) \(.address)")' "$f")
done
[ $failed = 0 ] && echo "verify: done, see https://testnet.bscscan.com" || { echo "verify: some contracts failed; re-run scripts/verify.sh (BscScan can lag behind a fresh deploy)"; exit 1; }
