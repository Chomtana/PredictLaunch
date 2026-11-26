#!/usr/bin/env bash
# Every account of the stack (derived from MNEMONIC in .env, see scripts/keys.sh): what each should hold, what it
# holds, and topping them up from ONE wallet. You only fund the deployer; this script sends every other account
# what it is missing, from the deployer, once the deployer holds enough for itself and all of them.
#
#   scripts/wallets.sh               BSC testnet (BSC_TESTNET_RPC_URL from .env, never printed): list, then
#                                    distribute from the deployer if it can cover everyone, else say how much
#                                    to send to the deployer
#   scripts/wallets.sh --check       list only, send nothing
#   scripts/wallets.sh --keep <tBNB> what the deployer keeps for itself (default 0.1: enough to deploy Flap +
#                                    OpenFour; testnet.sh passes less once deployed)
#   scripts/wallets.sh --rpc <url>   another RPC (e.g. http://127.0.0.1:8545, the dev fork)
#   scripts/wallets.sh --keys        also print the private keys (careful: they control the funds)
#
# Recommended tBNB is budgeted at 1 gwei (testnet usually charges far less) from measured gas: the Flap deploy
# is ~10.3M gas, our OpenFour fork-deploy ~30M (31 txs) plus ~8.8M to register the preset, a Flap launch ~1.5M
# gas plus the Portal's 0.005 BNB salt-lock fee. USDT (Flap's faucet token) needs no funding: its mint is
# public and the bots mint their own.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$ROOT/.env" ]; then set -a; . "$ROOT/.env"; set +a; fi
. "$ROOT/scripts/keys.sh"

RPC="${BSC_TESTNET_RPC_URL:-}"
LABEL="BSC testnet (.env BSC_TESTNET_RPC_URL)"
SHOW_KEYS=0
DISTRIBUTE=1
# Recommended tBNB per role (same order as ROLE_NAMES in keys.sh: deployer operator creator maker taker1 taker2).
NEED=(0.1 0.1 0.1 0.02 0.02 0.02)
KEEP="${NEED[0]}"
while [ $# -gt 0 ]; do
  case "$1" in
    --rpc) RPC="$2"; LABEL="$2"; shift 2 ;;
    --keys) SHOW_KEYS=1; shift ;;
    --check) DISTRIBUTE=0; shift ;;
    --keep) KEEP="$2"; shift 2 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "unknown option $1"; exit 1 ;;
  esac
done
[ -n "$RPC" ] || { echo "no RPC: set BSC_TESTNET_RPC_URL in .env or pass --rpc" >&2; exit 1; }

USDT=0x190C989D5665a0e404B444b53CAE9AbCfb600157
WHAT=(
  "deploy Exchange + Flap factory, our OpenFour fork + preset; owns them; funds the others"
  "submit batches, keeper (snapshot/resolve/redeem/graduate), Core.signer"
  "seed bots: create launches (0.005 salt-lock fee each on Flap)"
  "seed bots: market maker (approve, mint USDT)"
  "seed bots: taker"
  "seed bots: taker"
)
# Gas for the distribution transfers themselves (21k gas each, budgeted at 1 gwei).
XFER_GAS=0.0002

chain="$(cast chain-id --rpc-url "$RPC" 2>/dev/null || echo '?')"
local_rpc=0
case "$RPC" in http://127.0.0.1*|http://localhost*) local_rpc=1 ;; esac
fmt() { cast from-wei "$1" | awk '{printf "%.4f", $1}'; }

declare -a BAL SHORT
read_balances() {
  for i in "${!ROLE_NAMES[@]}"; do
    BAL[$i]="$(cast balance "${ROLE_ADDRS[$i]}" --rpc-url "$RPC" 2>/dev/null || echo 0)"
    local need_wei; need_wei="$(cast to-wei "${NEED[$i]}")"
    SHORT[$i]="$(echo "if ($need_wei > ${BAL[$i]}) $need_wei - ${BAL[$i]} else 0" | bc)"
  done
}

print_table() {
  printf '%-9s %-5s %-42s %10s %10s %12s  %s\n' role index address need_tBNB tBNB USDT status
  for i in "${!ROLE_NAMES[@]}"; do
    local a="${ROLE_ADDRS[$i]}" usdt_wei usdt st
    usdt_wei="$(cast call "$USDT" 'balanceOf(address)(uint256)' "$a" --rpc-url "$RPC" 2>/dev/null | awk '{print $1}' || echo 0)"
    usdt="$(cast from-wei "${usdt_wei:-0}" | awk '{printf "%.0f", $1}')"
    if [ "${SHORT[$i]}" = 0 ]; then st=ok; else st="short $(fmt "${SHORT[$i]}")"; fi
    printf '%-9s %-5s %-42s %10s %10s %12s  %s\n' "${ROLE_NAMES[$i]}" "${ROLE_INDEX[$i]}" "$a" "${NEED[$i]}" "$(fmt "${BAL[$i]}")" "$usdt" "$st"
  done
}

echo "Accounts from $(using_anvil_mnemonic && echo "anvil's PUBLIC test mnemonic (MNEMONIC unset: fork only)" || echo "MNEMONIC in .env")"
echo "Balances on $LABEL, chain $chain"
public_on_real=0
if using_anvil_mnemonic && [ $local_rpc = 0 ]; then
  public_on_real=1
  echo "WARNING: these are anvil's public keys. Anyone can drain them: set MNEMONIC in .env before funding." >&2
fi
echo
read_balances
print_table
echo
for i in "${!ROLE_NAMES[@]}"; do printf '  %-9s %s\n' "${ROLE_NAMES[$i]}" "${WHAT[$i]}"; done
if [ $SHOW_KEYS = 1 ]; then
  echo
  echo "Private keys (keep secret):"
  for n in DEPLOYER_KEY OP_KEY CREATOR_KEY MAKER_KEY TAKER1_KEY TAKER2_KEY; do printf '  %-12s %s\n' "$n" "${!n}"; done
fi

# What the others are missing, and what the deployer needs to cover them plus its own KEEP.
others=0
n_xfer=0
for i in "${!ROLE_NAMES[@]}"; do
  [ "$i" = 0 ] && continue
  others="$(echo "$others + ${SHORT[$i]}" | bc)"
  [ "${SHORT[$i]}" = 0 ] || n_xfer=$((n_xfer + 1))
done
echo
if [ "$others" = 0 ]; then
  if [ "$(echo "${BAL[0]} >= $(cast to-wei "$KEEP")" | bc)" = 1 ]; then
    echo "All accounts are funded."
  else
    echo "The other accounts are funded. Send $(fmt "$(echo "$(cast to-wei "$KEEP") - ${BAL[0]}" | bc)") tBNB to the deployer $OWNER for its own gas (keeps $KEEP)."
  fi
  exit 0
fi
total="$(echo "$(cast to-wei "$KEEP") + $others + $n_xfer * $(cast to-wei "$XFER_GAS")" | bc)"
if [ "$(echo "${BAL[0]} >= $total" | bc)" != 1 ]; then
  echo "Send $(fmt "$(echo "$total - ${BAL[0]}" | bc)") tBNB to the deployer $OWNER"
  echo "(it keeps $KEEP for itself and hands $(fmt "$others") to the $n_xfer short account(s)), then run this again."
  exit 0
fi
if [ $DISTRIBUTE = 0 ]; then
  echo "The deployer can cover everyone: run without --check to send $(fmt "$others") tBNB to the $n_xfer short account(s)."
  exit 0
fi
if [ $public_on_real = 1 ]; then
  echo "Not distributing: anvil's public keys on a real network would be drained. Set MNEMONIC in .env." >&2
  exit 1
fi
echo "Distributing $(fmt "$others") tBNB from the deployer $OWNER:"
for i in "${!ROLE_NAMES[@]}"; do
  [ "$i" = 0 ] && continue
  [ "${SHORT[$i]}" = 0 ] && continue
  printf '  %-9s %s  +%s tBNB ... ' "${ROLE_NAMES[$i]}" "${ROLE_ADDRS[$i]}" "$(fmt "${SHORT[$i]}")"
  tx="$(cast send --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" "${ROLE_ADDRS[$i]}" --value "${SHORT[$i]}" --json 2>&1 | jq -r '.transactionHash // empty' 2>/dev/null || true)"
  if [ -n "$tx" ]; then echo "$tx"; else echo "FAILED"; exit 1; fi
done
echo
read_balances
print_table
echo
echo "Done: every account holds its recommended tBNB."
