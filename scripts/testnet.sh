#!/usr/bin/env bash
# PredictLaunch on the REAL BSC testnet, one script for all of it; every account from MNEMONIC in .env
# (scripts/keys.sh). The testnet counterpart of dev.sh.
#
#   scripts/testnet.sh               wallet check -> deploy (first run only): Exchange + Flap factory, our
#                                    OpenFour instance + PredictLaunch preset -> sequencer -> live seed bots
#                                    -> frontend at http://localhost:5173
#   scripts/testnet.sh --no-four     Flap only (no OpenFour deploy, no Four launches)
#   scripts/testnet.sh --no-seed     no bots
#   scripts/testnet.sh --no-frontend no Vite
#   scripts/testnet.sh --redeploy    forget the deployment and deploy a fresh Exchange (and OpenFour)
#   scripts/testnet.sh --verify      (re)try verification of the deployment, then run as usual
#
# Verification: every contract we deploy (also the constructor-created ones) is verified once after the deploy by
# scripts/verify.sh, from the broadcasts saved with the deployment: on BscScan when ETHERSCAN_API_KEY's plan
# covers BNB Chain (the free plan does not), else on Sourcify (free, no key).
#
# The deployment is TRACKED in git (public addresses only, never keys): deployments/bsc-testnet.json (summary:
# addresses, deploy block, BscScan links) and deployments/bsc-testnet/ (what later runs reuse: deploy.json,
# four.json, openfour-fork.json, start-block, broadcast-*.json, verified). Commit them after a deploy so any
# clone reuses it. Logs and local state stay in .dev/testnet/.
#
# Fund only the deployer: this script runs scripts/wallets.sh, which sends every other account what it is missing
# from the deployer (or says how much to send to the deployer) and stops while anything is short. Quote: Flap's
# faucet USDT (public mint: the bots mint what they need). The RPC URL is never printed.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/.dev/testnet"            # logs, oracle files (local, gitignored)
DEP="$ROOT/deployments/bsc-testnet"  # the deployment (tracked)
SUMMARY="$ROOT/deployments/bsc-testnet.json"
SEQ_PORT="${SEQ_PORT:-8787}"
API="http://127.0.0.1:$SEQ_PORT"
WEB_PORT="${WEB_PORT:-5173}"
FOUR=1
SEED=1
FRONTEND=1
FORCE_VERIFY=0
REDEPLOY=0
for a in "$@"; do
  case "$a" in
    --no-four) FOUR=0 ;;
    --no-seed) SEED=0 ;;
    --no-frontend) FRONTEND=0 ;;
    --redeploy) REDEPLOY=1 ;;
    --verify) FORCE_VERIFY=1 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown option $a"; exit 1 ;;
  esac
done

if [ -f "$ROOT/.env" ]; then set -a; . "$ROOT/.env"; set +a; fi
[ -n "${BSC_TESTNET_RPC_URL:-}" ] || { echo "set BSC_TESTNET_RPC_URL in .env" >&2; exit 1; }
. "$ROOT/scripts/keys.sh"
if using_anvil_mnemonic; then
  echo "MNEMONIC is not set in .env: refusing to use anvil's public keys on a real network." >&2
  exit 1
fi
RPC="$BSC_TESTNET_RPC_URL"
scrub() { perl -pe 'BEGIN { $u = $ENV{BSC_TESTNET_RPC_URL} } s/\Q$u\E/<live-rpc>/g'; }
[ "$(cast chain-id --rpc-url "$RPC")" = 97 ] || { echo "BSC_TESTNET_RPC_URL is not BSC testnet (chain 97)" >&2; exit 1; }
FLAP_USDT=0x190C989D5665a0e404B444b53CAE9AbCfb600157
mkdir -p "$OUT" "$DEP"
[ $REDEPLOY = 0 ] || rm -f "$DEP"/deploy.json "$DEP"/four.json "$DEP"/openfour-fork.json "$DEP"/start-block "$DEP"/broadcast-*.json "$DEP"/verified "$SUMMARY"
for p in "$SEQ_PORT" $([ $FRONTEND = 1 ] && echo "$WEB_PORT"); do
  if lsof -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $p is already in use"; exit 1; fi
done

# What the deployer must keep for itself: the gas of whatever is still left to deploy.
DEPLOY_MIN=0
[ -f "$DEP/deploy.json" ] || DEPLOY_MIN=0.02
[ $FOUR = 1 ] && [ ! -f "$DEP/four.json" ] && DEPLOY_MIN="$(echo "$DEPLOY_MIN + 0.04" | bc)"
KEEP="$(echo "$DEPLOY_MIN + 0.01" | bc)"

echo "==> wallets: fund only the deployer; it tops up every other account (scripts/wallets.sh)"
"$ROOT/scripts/wallets.sh" --keep "$KEEP" | tee "$OUT/wallets.txt"

need_gas() { # address, min BNB, role: stop when below what this run needs
  local have; have="$(cast balance "$1" --rpc-url "$RPC")"
  [ "$(echo "$have >= $(cast to-wei "$2")" | bc)" = 1 ] && return 0
  echo "$3 $1 has $(cast from-wei "$have") tBNB; this run needs at least $2 (recommended: scripts/wallets.sh)" >&2
  return 1
}
# Minimums for THIS run (the deployer only while something is left to deploy); the recommended amounts in
# wallets.sh last much longer.
short=0
[ "$DEPLOY_MIN" = 0 ] || need_gas "$OWNER" "$DEPLOY_MIN" deployer || short=1
need_gas "$OP" 0.01 operator || short=1
if [ $SEED = 1 ]; then
  need_gas "$CREATOR" 0.01 creator || short=1
  for a in "$MAKER" "$TAKER1" "$TAKER2"; do need_gas "$a" 0.002 bot || short=1; done
fi
[ $short = 0 ] || { echo "Send the tBNB wallets.sh asked for to the deployer $OWNER, then run this again." >&2; exit 1; }

PIDS=()
step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
cleanup() { trap - EXIT INT TERM; for p in "${PIDS[@]:-}"; do [ -n "$p" ] && { pkill -P "$p" 2>/dev/null || true; kill "$p" 2>/dev/null || true; }; done; wait 2>/dev/null || true; }
trap cleanup EXIT INT TERM

step "building contracts + sequencer"
(cd "$ROOT/contracts" && { [ -d dependencies ] || forge soldeer install; } && forge build -q) 2>&1 | scrub
(cd "$ROOT" && cargo build -q -p predictlaunch-sequencer)
(cd "$ROOT/frontend" && { [ -d node_modules ] || pnpm install --frozen-lockfile; })

if [ ! -f "$DEP/deploy.json" ]; then
  cast block-number --rpc-url "$RPC" >"$DEP/start-block"
  step "deploying Exchange + Flap factory from $OWNER (operator $OP)"
  (cd "$ROOT/contracts" && OWNER="$OWNER" OPERATOR="$OP" QUOTE_TOKEN="$FLAP_USDT" DEPLOY_JSON="$DEP/deploy.json" \
    forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --broadcast --legacy --with-gas-price 0.1gwei \
    --private-key "$DEPLOYER_KEY" 2>&1 | scrub >"$OUT/deploy.log") || { tail -30 "$OUT/deploy.log"; exit 1; }
  # Keep this broadcast: the dev fork is chain 97 too and would overwrite contracts/broadcast/.../97/.
  cp "$ROOT/contracts/broadcast/Deploy.s.sol/97/run-latest.json" "$DEP/broadcast-deploy.json"
  rm -f "$DEP/verified"
fi
EXCHANGE="$(jq -r .exchange "$DEP/deploy.json")"
FACTORY="$(jq -r .factory "$DEP/deploy.json")"
echo "exchange $EXCHANGE  factory $FACTORY"

FOUR_RAIL=0x0000000000000000000000000000000000000000
if [ $FOUR = 1 ] && [ ! -f "$DEP/four.json" ]; then
  step "deploying our OpenFour instance + PredictLaunch preset (a few minutes)"
  "$ROOT/scripts/openfour-fork.sh" "$RPC" "$DEPLOYER_KEY" "$OP" "$EXCHANGE" 2>&1 | scrub >"$OUT/openfour.log" || { tail -30 "$OUT/openfour.log"; exit 1; }
  cp "$ROOT/.dev/four.json" "$DEP/four.json"
  # public addresses only: drop the local path of the source list
  jq 'del(.forkedFrom)' "$ROOT/.dev/openfour/fork-deployment.json" >"$DEP/openfour-fork.json"
  cp "$ROOT/contracts/broadcast/DeployFour.s.sol/97/run-latest.json" "$DEP/broadcast-four.json"
  rm -f "$DEP/verified"
fi
[ $FOUR = 1 ] && [ -f "$DEP/four.json" ] && FOUR_RAIL="$(jq -r .rail "$DEP/four.json")"

if [ $FORCE_VERIFY = 1 ] || [ ! -f "$DEP/verified" ]; then
  step "verifying the contracts (scripts/verify.sh: BscScan with a paid Etherscan key, else Sourcify)"
  if "$ROOT/scripts/verify.sh" "$DEP"/broadcast-*.json 2>&1 | tee "$OUT/verify.log"; then date -u +%Y-%m-%dT%H:%M:%SZ >"$DEP/verified"
  else echo "verification incomplete (see .dev/testnet/verify.log); retry: scripts/verify.sh"; fi
fi
echo "four rail $FOUR_RAIL"

# The tracked summary: every address we deployed or own, with BscScan links (public data only).
write_summary() {
  local four=null openfour=null created=() a
  [ -f "$DEP/four.json" ] && four="$(cat "$DEP/four.json")"
  [ -f "$DEP/openfour-fork.json" ] && openfour="$(jq '{registry: .addresses.registry, core: .addresses.core, feeRouter: .addresses.feeRouter, tools: .addresses.tools, createDeployer: .addresses.createDeployer}' "$DEP/openfour-fork.json")"
  jq -n --argjson deploy "$(cat "$DEP/deploy.json")" --argjson four "$four" --argjson openfour "$openfour" \
    --arg startBlock "$(cat "$DEP/start-block")" --arg verified "$(cat "$DEP/verified" 2>/dev/null || true)" \
    --argjson contracts "$(jq -s '[.[] | .transactions[] | select(.transactionType == "CREATE") | {name: .contractName, address: .contractAddress}, (.additionalContracts[]? | {name: .contractName, address: .address})]' "$DEP"/broadcast-*.json)" '
    def link: "https://testnet.bscscan.com/address/\(.)";
    {
      network: "bsc-testnet", chainId: 97, startBlock: ($startBlock | tonumber),
      verifiedAt: (if $verified == "" then null else $verified end),
      quoteToken: $deploy.quoteToken, owner: $deploy.owner, operator: $deploy.operator,
      exchange: $deploy.exchange, flapFactory: $deploy.factory,
      four: (if $four == null then null else {rail: $four.rail, presetId: $four.presetId, validator: $four.validator, signer: $four.signer, quoteAsset: $four.quoteAsset} end),
      openfour: $openfour,
      contracts: ($contracts | map(. + {bscscan: (.address | link), sourcify: "https://repo.sourcify.dev/97/\(.address)"}))
    }' >"$SUMMARY"
}
write_summary
echo "deployment: deployments/bsc-testnet.json (tracked: commit it so other clones reuse this deployment)"

step "starting sequencer on $API (operator $OP)"
RUST_LOG="${RUST_LOG:-info}" "$ROOT/target/debug/predictlaunch-sequencer" --rpc "$RPC" --exchange "$EXCHANGE" \
  --factory "$FACTORY" --four-rail "$FOUR_RAIL" --operator-key "$OP_KEY" --port "$SEQ_PORT" \
  --start-block "$(cat "$DEP/start-block")" --quote-symbol USDT --oracle-dir "$OUT/oracle" 2>&1 | scrub >"$OUT/sequencer.log" &
PIDS+=($!)
for _ in $(seq 240); do curl -sf "$API/api/status" >/dev/null && break; sleep 0.5; done
curl -sf "$API/api/status" >/dev/null || { tail -30 "$OUT/sequencer.log"; exit 1; }

if [ $SEED = 1 ]; then
  step "starting live seed bots (creator $CREATOR, maker $MAKER, takers $TAKER1 $TAKER2)"
  (cd "$ROOT/frontend" && exec node --experimental-strip-types --no-warnings scripts/seed.ts \
    --rpc "$RPC" --api "$API" --deploy "$DEP/deploy.json" --live) 2>&1 | scrub >"$OUT/seed.log" &
  PIDS+=($!)
fi
if [ $FRONTEND = 1 ]; then
  step "starting frontend on http://localhost:$WEB_PORT"
  (cd "$ROOT/frontend" && PREDICTLAUNCH_API="$API" exec pnpm exec vite --port "$WEB_PORT" --strictPort) >"$OUT/frontend.log" 2>&1 &
  PIDS+=($!)
fi
cat <<EOF

  PredictLaunch on BSC testnet is up.  (logs: .dev/testnet/*.log)
$([ $FRONTEND = 1 ] && echo "    frontend    http://localhost:$WEB_PORT   (MetaMask: BSC Testnet, chain 97)")
    sequencer   $API/api/status
    Exchange    $EXCHANGE
    Factory     $FACTORY  (Flap)
    Four rail   $FOUR_RAIL  (OpenFour; 0x0 = --no-four)
    operator    $OP

  Ctrl-C stops everything (the deployment stays; the next run reuses it).
EOF
wait
