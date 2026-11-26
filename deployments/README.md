# Deployments

Public addresses of the live deployments (no keys). `scripts/testnet.sh` writes them after it deploys; commit
them so every clone reuses the same deployment instead of deploying a new one.

- `bsc-testnet.json`: summary (chain, deploy block, owner, operator, Exchange, Flap factory, Four rail + preset,
  our OpenFour Core / Registry, and every contract we deployed with its BscScan link).
- `bsc-testnet/`: what the scripts read back: `deploy.json`, `four.json`, `openfour-fork.json`, `start-block`,
  the forge broadcasts `broadcast-*.json` (for `scripts/verify.sh`), and `verified` (when BscScan verification
  last succeeded).

`scripts/testnet.sh --redeploy` replaces them with a fresh deployment.
