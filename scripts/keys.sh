#!/usr/bin/env bash
# Every account the stack uses, derived from ONE seed phrase: MNEMONIC in .env (BIP-39, path m/44'/60'/0'/0/i).
# Source it: `. scripts/keys.sh` (after .env is loaded). Unset MNEMONIC = anvil's public test mnemonic, whose
# indices are exactly anvil's dev accounts #0..#9 (fork only: never fund those on a real network).
#
#   index  role                                                           env (key / address)
#   0      deployer + owner (Exchange, Flap factory, our OpenFour fork)   DEPLOYER_KEY / OWNER
#   9      operator: batches, keeper, question resolver, Core.signer     OP_KEY / OP
#   3      seed bots: launch creator                                      CREATOR_KEY / CREATOR
#   5      seed bots: market maker                                        MAKER_KEY / MAKER
#   6, 7   seed bots: takers                                              TAKER1_KEY / TAKER1, TAKER2_KEY / TAKER2
#
# The TypeScript bots derive the same accounts (frontend/scripts/lib.ts `roleAccount`).
ANVIL_MNEMONIC="test test test test test test test test test test test junk"
MNEMONIC="${MNEMONIC:-$ANVIL_MNEMONIC}"
export MNEMONIC
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1

# The anvil mnemonic is public: true when it is the one in use.
using_anvil_mnemonic() { [ "$MNEMONIC" = "$ANVIL_MNEMONIC" ]; }

key_at() { cast wallet private-key "$MNEMONIC" "$1"; }
addr_of() { cast wallet address --private-key "$1"; }

ROLE_NAMES=(deployer operator creator maker taker1 taker2)
ROLE_INDEX=(0 9 3 5 6 7)

DEPLOYER_KEY="$(key_at 0)"; OWNER="$(addr_of "$DEPLOYER_KEY")"
OP_KEY="$(key_at 9)"; OP="$(addr_of "$OP_KEY")"
CREATOR_KEY="$(key_at 3)"; CREATOR="$(addr_of "$CREATOR_KEY")"
MAKER_KEY="$(key_at 5)"; MAKER="$(addr_of "$MAKER_KEY")"
TAKER1_KEY="$(key_at 6)"; TAKER1="$(addr_of "$TAKER1_KEY")"
TAKER2_KEY="$(key_at 7)"; TAKER2="$(addr_of "$TAKER2_KEY")"
ROLE_ADDRS=("$OWNER" "$OP" "$CREATOR" "$MAKER" "$TAKER1" "$TAKER2")
