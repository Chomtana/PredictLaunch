#!/usr/bin/env bash
# Deploy a developer-owned OpenFour (Four.meme) instance and the PredictLaunch preset on it.
#
#   scripts/openfour-fork.sh <rpc> <deployer key> <signer address> <exchange>
#
# 1. openfour-docs `developer/fork-deploy` (`npm run fork`, pinned commit below): a new OpenFour proxy set owned by
#    the deployer (Registry, Core, FeeRouter, Tools, ...) over the testnet implementations, with Core.signer = the
#    signer (the sequencer's operator, which signs Four graduations). Output: .dev/openfour/fork-deployment.json.
# 2. contracts/script/DeployFour.s.sol: register the PredictLaunch preset (FairLaunch curve + migrate,
#    PredictLaunchTradeModule, PredictLaunchPresetValidator), deploy FourRail and enable it on the Exchange.
#    Output: .dev/four.json.
# Works on an anvil fork of BSC testnet and on the real BSC testnet (the deployer then needs ~0.1 tBNB, and must
# own the Exchange). Takes a few minutes on a fresh fork (cold state).
set -euo pipefail
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1

RPC="$1"
DEPLOYER_KEY="$2"
SIGNER="$3"
EXCHANGE="$4"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV="$ROOT/.dev"
DOCS="$DEV/openfour-docs"
DOCS_REPO=https://github.com/four-meme-community/openfour-docs
DOCS_COMMIT=079a45e9c3358c9f357c84f336c7d915c9f0e9fc

if [ ! -d "$DOCS/.git" ]; then
  git clone -q "$DOCS_REPO" "$DOCS"
fi
git -C "$DOCS" fetch -q origin "$DOCS_COMMIT" 2>/dev/null || true
git -C "$DOCS" checkout -q -f "$DOCS_COMMIT"  # -f: drops the gas-price patch below before switching
# Its chain-97 txOverrides hardcode 0.05 gwei, which BSC testnet validators leave pending: send at 0.1 gwei.
perl -pi -e 's/gasPrice: 50_000_000n/gasPrice: 100_000_000n/' "$DOCS/developer/fork-deploy/fork-from-chain.js"
FD="$DOCS/developer/fork-deploy"
# developer/ is an npm workspace root (no lockfile): install there, as openfour-docs' README does.
[ -d "$DOCS/developer/node_modules/ethers" ] || (cd "$DOCS/developer" && npm install --no-audit --no-fund --loglevel=error)

echo "openfour: fork-deploy (OpenFour proxy set owned by the deployer, Core.signer $SIGNER)"
(cd "$FD" && RPC_URL="$RPC" DRY_RUN=0 DEPLOYER_PRIVATE_KEY="$DEPLOYER_KEY" SIGNER_ADDRESS="$SIGNER" node fork-from-chain.js)
mkdir -p "$DEV/openfour"
cp "$FD/out/fork-deployment.json" "$DEV/openfour/fork-deployment.json"

echo "openfour: registering the PredictLaunch preset and FourRail"
(cd "$ROOT/contracts" && OPENFOUR_JSON="$DEV/openfour/fork-deployment.json" EXCHANGE="$EXCHANGE" SIGNER="$SIGNER" \
  forge script script/DeployFour.s.sol:DeployFour --rpc-url "$RPC" --broadcast --legacy --with-gas-price 0.1gwei --private-key "$DEPLOYER_KEY")
echo "openfour: ready, rail $(jq -r .rail "$DEV/four.json") preset $(jq -r .presetId "$DEV/four.json")"
