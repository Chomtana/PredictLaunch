# bilauncher

A memecoin launchpad where each launch's liquidity is raised by a Polymarket-style "Up or Down" price
game on Atlas Oracle feeds. Winners are paid 1 − cut, the cut fills the launch pool, losers claim the
memecoin, and graduation launches the token through Flap's Pool Launch (our Launcher Factory) on BNB
Chain testnet.

- Interfaces: [SPEC.md](SPEC.md)
- Design: [docs/superpowers/specs/2026-11-25-bilauncher-design.md](docs/superpowers/specs/2026-11-25-bilauncher-design.md)
- Plan: [docs/superpowers/plans/2026-11-25-bilauncher.md](docs/superpowers/plans/2026-11-25-bilauncher.md)

## Setup

```bash
cp .env.example .env   # set BSC_TESTNET_RPC_URL (your own node or a provider key)
cd contracts && forge soldeer install && forge test
```

Fork tests and the demo run on `anvil --fork-url $BSC_TESTNET_RPC_URL --chain-id 97`.
