#!/usr/bin/env bash
# PredictLaunch one-command local demo on an anvil fork of BSC testnet.
#
#   scripts/dev.sh                 fork + deploy + feed relay + sequencer + seeded bots (live) + frontend
#   scripts/dev.sh --no-seed       ... without the seeded launches and bots
#   scripts/dev.sh --no-live       ... seed once, but no live market-maker loop afterwards
#   scripts/dev.sh --no-frontend   ... without the Vite dev server (e.g. for API work or e2e)
#   BATCH_MS=3000 scripts/dev.sh   batch every 3 s (default 2 s)
#   QUOTE=bnb scripts/dev.sh       native BNB collateral (default: Flap's testnet faucet USDT)
#
# Needs BSC_TESTNET_RPC_URL in .env at the repo root (never printed). The fork is chain 97, like the
# real testnet: keep it in a SEPARATE MetaMask network (http://127.0.0.1:8545) and never mix the two.
# Accounts are anvil's PUBLIC dev keys, funded on the fork only. Ctrl-C stops everything.
set -euo pipefail
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV="$ROOT/.dev"
RPC_PORT="${RPC_PORT:-8545}"
SEQ_PORT="${SEQ_PORT:-8787}"
WEB_PORT="${WEB_PORT:-5173}"
BATCH_MS="${BATCH_MS:-2000}"
# Exchange collateral: Flap's testnet faucet USDT (on-chain "USD", public mint) or native BNB.
FLAP_USDT=0x190C989D5665a0e404B444b53CAE9AbCfb600157
case "${QUOTE:-usdt}" in
  usdt) QUOTE_TOKEN="$FLAP_USDT"; QUOTE_SYMBOL=USDT ;;
  bnb) QUOTE_TOKEN=0x0000000000000000000000000000000000000000; QUOTE_SYMBOL=BNB ;;
  *) echo "QUOTE must be usdt or bnb"; exit 1 ;;
esac
RPC="http://127.0.0.1:$RPC_PORT"
API="http://127.0.0.1:$SEQ_PORT"
SEED=1
LIVE=1
FRONTEND=1
for a in "$@"; do
  case "$a" in
    --no-seed) SEED=0 ;;
    --no-live) LIVE=0 ;;
    --no-frontend) FRONTEND=0 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown option $a"; exit 1 ;;
  esac
done

if [ -f "$ROOT/.env" ]; then set -a; . "$ROOT/.env"; set +a; fi
if [ -z "${BSC_TESTNET_RPC_URL:-}" ]; then
  echo "BSC_TESTNET_RPC_URL is not set: copy .env.example to .env and set it (your own BSC testnet RPC)." >&2
  exit 1
fi
export BSC_TESTNET_RPC_URL

# anvil #0 = deployer and owner, #9 = batch operator (PUBLIC dev keys, fork only).
DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
OWNER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
OP_KEY=0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6
OP=0xa0Ee7A142d267C1f36714E4a8F75612F20a79720

for bin in anvil forge cast cargo pnpm node jq curl; do
  command -v "$bin" >/dev/null || { echo "missing $bin"; exit 1; }
done
for p in "$RPC_PORT" "$SEQ_PORT" $([ $FRONTEND = 1 ] && echo "$WEB_PORT"); do
  if lsof -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $p is already in use"; exit 1; fi
done

mkdir -p "$DEV"
PIDS=()
cleanup() {
  trap - EXIT INT TERM
  echo; echo "stopping..."
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] || continue
    pkill -P "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
fail() { echo "FAILED: $1 (see $2)" >&2; tail -n 30 "$2" >&2 || true; exit 1; }
# Logs must never contain the RPC URL: scrub it from anything a tool might echo.
scrub() { perl -pe 'BEGIN { $u = $ENV{BSC_TESTNET_RPC_URL} } s/\Q$u\E/<live-rpc>/g'; }

step "building contracts + sequencer"
(cd "$ROOT/contracts" && { [ -d dependencies ] || forge soldeer install; } && forge build -q) 2>&1 | scrub
(cd "$ROOT" && cargo build -q -p predictlaunch-sequencer)
SEQ_BIN="$ROOT/target/debug/predictlaunch-sequencer"
(cd "$ROOT/frontend" && { [ -d node_modules ] || pnpm install --frozen-lockfile; })

step "starting anvil fork of BSC testnet on $RPC (chain 97)"
anvil --fork-url "$BSC_TESTNET_RPC_URL" --chain-id 97 --block-time 1 --port "$RPC_PORT" > >(scrub >"$DEV/anvil.log") 2>&1 &
PIDS+=($!)
for _ in $(seq 120); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.5; done
[ "$(cast chain-id --rpc-url "$RPC" 2>/dev/null)" = 97 ] || fail "anvil did not start" "$DEV/anvil.log"
START_BLOCK="$(cast block-number --rpc-url "$RPC")"

step "deploying Exchange + PredictLaunchLauncherFactory, enabling it on the Flap Portal (owner #0, operator #9, quote $QUOTE_SYMBOL)"
(cd "$ROOT/contracts" && ALL_FEEDS=true OWNER="$OWNER" OPERATOR="$OP" QUOTE_TOKEN="$QUOTE_TOKEN" forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$RPC" --broadcast --private-key "$DEPLOYER_KEY" 2>&1 | scrub >"$DEV/deploy.log") || fail "deploy" "$DEV/deploy.log"
EXCHANGE="$(jq -r .exchange "$DEV/deploy.json")"
FACTORY="$(jq -r .factory "$DEV/deploy.json")"
echo "exchange $EXCHANGE  factory $FACTORY  (from block $START_BLOCK)"

step "fork setup: authorize the Exchange on the Atlas feeds"
"$ROOT/contracts/script/fork-setup.sh" "$RPC" "$DEV/deploy.json" 2>&1 | scrub

step "starting the feed relay (live testnet prices -> fork, every 2 s)"
(cd "$ROOT/frontend" && exec node --experimental-strip-types --no-warnings scripts/feed-relay.ts --fork "$RPC") >"$DEV/feed-relay.log" 2>&1 &
RELAY_PID=$!
PIDS+=($RELAY_PID)
for _ in $(seq 120); do grep -q 'feed-relay: ready' "$DEV/feed-relay.log" 2>/dev/null && break; kill -0 $RELAY_PID 2>/dev/null || break; sleep 0.5; done
grep -q 'feed-relay: ready' "$DEV/feed-relay.log" || fail "feed relay" "$DEV/feed-relay.log"

step "starting sequencer on $API (batch every ${BATCH_MS} ms)"
RUST_LOG="${RUST_LOG:-info}" "$SEQ_BIN" --rpc "$RPC" --exchange "$EXCHANGE" --factory "$FACTORY" \
  --operator-key "$OP_KEY" --port "$SEQ_PORT" --batch-ms "$BATCH_MS" --dev-faucet --start-block "$START_BLOCK" \
  --quote-symbol "$QUOTE_SYMBOL" --oracle-dir "$DEV/oracle" \
  >"$DEV/sequencer.log" 2>&1 &
SEQ_PID=$!
PIDS+=($SEQ_PID)
for _ in $(seq 240); do curl -sf "$API/api/status" >/dev/null && break; kill -0 $SEQ_PID 2>/dev/null || break; sleep 0.5; done
curl -sf "$API/api/status" >/dev/null || fail "sequencer" "$DEV/sequencer.log"

if [ $SEED = 1 ]; then
  step "seeding 2 launches and 3 bots (anvil #5 maker, #6/#7 takers)"
  (cd "$ROOT/frontend" && exec node --experimental-strip-types --no-warnings scripts/seed.ts \
    --rpc "$RPC" --api "$API" --deploy "$DEV/deploy.json" $([ $LIVE = 1 ] && echo --live)) >"$DEV/seed.log" 2>&1 &
  SEED_PID=$!
  PIDS+=($SEED_PID)
  for _ in $(seq 600); do grep -q 'seed: done' "$DEV/seed.log" 2>/dev/null && break; kill -0 $SEED_PID 2>/dev/null || break; sleep 0.5; done
  grep -q 'seed: done' "$DEV/seed.log" || fail "seed" "$DEV/seed.log"
  cat "$DEV/seed.log"
fi

if [ $FRONTEND = 1 ]; then
  step "starting frontend on http://localhost:$WEB_PORT"
  (cd "$ROOT/frontend" && PREDICTLAUNCH_API="$API" exec pnpm exec vite --port "$WEB_PORT" --strictPort) >"$DEV/frontend.log" 2>&1 &
  PIDS+=($!)
  for _ in $(seq 100); do curl -sf "http://localhost:$WEB_PORT" >/dev/null && break; sleep 0.2; done
fi

cat <<EOF

  PredictLaunch local demo is up.  (logs: .dev/*.log)

$([ $FRONTEND = 1 ] && echo "    frontend    http://localhost:$WEB_PORT")
    sequencer   $API/api/status
    anvil       $RPC   chainId 97 (fork of BSC testnet)
    Exchange    $EXCHANGE
    Factory     $FACTORY

  MetaMask: add a CUSTOM network "PredictLaunch fork", RPC $RPC, chain ID 97, symbol BNB.
  It has the same chain ID as the real BSC testnet: keep them as separate networks, never mix them,
  and never send real testnet funds to the dev keys below (PUBLIC anvil keys, LOCAL ONLY):
    #0  0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
    #1  0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
  Or use the in-app dev wallet; the faucet button gives any address 1000 fork BNB (gas) and, with the
  USDT quote, 10,000 USDT.

  Ctrl-C stops everything.
EOF
if [ "${DEV_NO_WAIT:-0}" = 1 ]; then trap - EXIT INT TERM; exit 0; fi
wait
