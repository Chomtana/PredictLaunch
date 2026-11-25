#!/usr/bin/env bash
# bilauncher end-to-end smoke on a fresh anvil fork of BSC testnet (real time, ~13 min):
# dev.sh --no-frontend --no-seed, then frontend/scripts/e2e.ts creates a BTCB launch settling 10 min
# out, two bots mint 25 BNB of pairs, and the run waits for graduation through the real Flap Portal.
# Prints "E2E OK" and exits 0 on success. Needs BSC_TESTNET_RPC_URL in .env.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV="$ROOT/.dev"
mkdir -p "$DEV"
API="http://127.0.0.1:${SEQ_PORT:-8787}"
RPC="http://127.0.0.1:${RPC_PORT:-8545}"

"$ROOT/scripts/dev.sh" --no-frontend --no-seed >"$DEV/e2e-dev.log" 2>&1 &
DEV_PID=$!
cleanup() { trap - EXIT INT TERM; kill -TERM "$DEV_PID" 2>/dev/null || true; wait "$DEV_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

for _ in $(seq 900); do
  grep -q 'demo is up' "$DEV/e2e-dev.log" 2>/dev/null && break
  kill -0 "$DEV_PID" 2>/dev/null || { cat "$DEV/e2e-dev.log"; echo "dev.sh exited early"; exit 1; }
  sleep 1
done
grep -q 'demo is up' "$DEV/e2e-dev.log" || { tail -30 "$DEV/e2e-dev.log"; echo "dev.sh did not come up"; exit 1; }
echo "stack is up (log: .dev/e2e-dev.log); running the e2e driver"

cd "$ROOT/frontend"
node --experimental-strip-types --no-warnings scripts/e2e.ts --api "$API" --rpc "$RPC" --deploy "$DEV/deploy.json" "$@" 2>&1 | tee "$DEV/e2e.log"
status=${PIPESTATUS[0]}
exit "$status"
