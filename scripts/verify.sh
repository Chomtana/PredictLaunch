#!/usr/bin/env bash
# Verify every contract a deployment created (chain 97): each CREATE of a forge broadcast plus the contracts their
# constructors created (e.g. the Flap factory's beacon and Launcher impl).
#
#   scripts/verify.sh <broadcast.json> [...]      default: deployments/bsc-testnet/broadcast-*.json (saved by testnet.sh)
#   VERIFIER=sourcify|etherscan scripts/verify.sh force one verifier
#
# Verifier: BscScan through Etherscan V2 when ETHERSCAN_API_KEY is set and its plan covers BNB Chain (Etherscan's
# FREE plan does not: "Free API access is not supported for this chain"), else Sourcify (free, no key; source at
# https://repo.sourcify.dev/97/<address>). On that Etherscan refusal it switches to Sourcify for the rest.
# Needs BSC_TESTNET_RPC_URL in .env. Safe to re-run: already-verified contracts are skipped. Constructor
# arguments are recovered from the chain.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$ROOT/.env" ]; then set -a; . "$ROOT/.env"; set +a; fi
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
[ -n "${BSC_TESTNET_RPC_URL:-}" ] || { echo "verify: set BSC_TESTNET_RPC_URL in .env" >&2; exit 1; }
KEY="${ETHERSCAN_API_KEY:-}"
scrub() { perl -pe 'BEGIN { $u = $ENV{BSC_TESTNET_RPC_URL}; $k = $ENV{ETHERSCAN_API_KEY} // "" } s/\Q$u\E/<live-rpc>/g; s/\Q$k\E/<api-key>/g if length $k'; }

VERIFIER="${VERIFIER:-$([ -n "$KEY" ] && echo etherscan || echo sourcify)}"
case "$VERIFIER" in
  etherscan) [ -n "$KEY" ] || { echo "verify: VERIFIER=etherscan needs ETHERSCAN_API_KEY in .env" >&2; exit 1; } ;;
  sourcify) ;;
  *) echo "verify: VERIFIER must be sourcify or etherscan" >&2; exit 1 ;;
esac

files=("$@")
if [ ${#files[@]} = 0 ]; then
  shopt -s nullglob
  files=("$ROOT"/deployments/bsc-testnet/broadcast-*.json)
fi
[ ${#files[@]} -gt 0 ] || { echo "verify: no broadcast files (deploy with scripts/testnet.sh first)" >&2; exit 1; }

# One contract with the current verifier; prints forge's output.
verify_one() { # address name
  if [ "$VERIFIER" = etherscan ]; then
    forge verify-contract "$1" "$2" --chain 97 --etherscan-api-key "$KEY" --rpc-url "$BSC_TESTNET_RPC_URL" \
      --guess-constructor-args --watch --retries 10 --delay 10 2>&1 | scrub || true
  else
    # Without the key in the environment: forge would otherwise route even Sourcify's constructor guess to Etherscan.
    env -u ETHERSCAN_API_KEY forge verify-contract "$1" "$2" --chain 97 --verifier sourcify --rpc-url "$BSC_TESTNET_RPC_URL" \
      --guess-constructor-args --watch --retries 10 --delay 10 2>&1 | scrub || true
  fi
}

echo "verify: using $VERIFIER"
failed=0
cd "$ROOT/contracts"
for f in "${files[@]}"; do
  [ "$(jq -r '.chain' "$f")" = 97 ] || { echo "verify: $f is not a chain-97 broadcast, skipped"; continue; }
  # name address, for direct creates and their nested (constructor) creates
  while read -r name addr; do
    [ -n "$name" ] && [ "$name" != null ] || continue
    printf 'verify: %-30s %s ... ' "$name" "$addr"
    out="$(verify_one "$addr" "$name")"
    if [ "$VERIFIER" = etherscan ] && grep -qi 'Free API access is not supported' <<<"$out"; then
      VERIFIER=sourcify
      printf '(Etherscan free plan does not cover BNB Chain: Sourcify) ... '
      out="$(verify_one "$addr" "$name")"
    fi
    if grep -qiE 'already verified|already (partially|fully) verified|exact_match.*already' <<<"$out"; then echo "already verified"
    elif grep -qiE 'Pass - Verified|successfully verified|exact_match|match' <<<"$out" && ! grep -qiE 'error|fail' <<<"$out"; then
      echo "verified ($VERIFIER)"
    else echo "FAILED"; echo "$out" | tail -5 | sed 's/^/    /'; failed=1
    fi
  done < <(jq -r '.transactions[] | select(.transactionType == "CREATE") | "\(.contractName) \(.contractAddress)",
                  (.additionalContracts[]? | "\(.contractName) \(.address)")' "$f")
done
where="$([ "$VERIFIER" = sourcify ] && echo "https://repo.sourcify.dev/97/<address> (and testnet.bscscan.com shows the bytecode)" || echo "https://testnet.bscscan.com")"
[ $failed = 0 ] && echo "verify: done, see $where" || { echo "verify: some contracts failed; re-run scripts/verify.sh (verifiers can lag behind a fresh deploy)"; exit 1; }
