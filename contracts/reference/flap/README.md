Reference only (not compiled): copied from github.com/flap-sh/FlapPoolLaunchVaultExample (MIT), 2026-11-25.
- MintLauncher.sol / MintLauncherFactory.sol: the Launcher + Launcher Factory pattern we follow (beacon proxy per launch,
  salt locked in initialize, launch with distribution EXPLICIT to the launcher). They use OZ 4.x upgradeable; we use OZ 5.
- ForkBase.sol / ForkAddresses.sol: fork-test helpers (_mineSalt, _openLauncherFactory via ProxyAdmin owner prank).
- DirectLaunchProbe.t.sol.txt: our probe that proved a 1B / 500M-pool / 2.15 BNB launch with 100 bps tax works on a testnet
  fork (0 / 50 / 99 bps revert InvalidTaxBps).
