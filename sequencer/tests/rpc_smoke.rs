//! Optional smoke test of `RpcChain` against a live node. Skipped unless
//! `BILAUNCHER_SMOKE_RPC` and `BILAUNCHER_SMOKE_EXCHANGE` are set. The exchange must be a contract
//! that accepts any batch (a mock emitting the SPEC events), with anvil keys #0 and #1 having
//! deposited 10 BNB each and launch 0 open. It checks log decoding, batch submission and the
//! `BatchSubmitted` calldata round trip.

use alloy_primitives::{Address, B256, U256};
use bilauncher_core::eip712::TestKey;
use bilauncher_core::state::Msg;
use bilauncher_core::{Domain, Outcome, Side, PORTAL};
use bilauncher_sequencer::app::{App, Settings};
use bilauncher_sequencer::chain::RpcChain;
use bilauncher_sequencer::testutil::{signed_order, E18};

const ALICE: &str = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const BOB: &str = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

#[tokio::test]
async fn rpc_chain_round_trip() {
    let (Ok(rpc), Ok(ex)) = (
        std::env::var("BILAUNCHER_SMOKE_RPC"),
        std::env::var("BILAUNCHER_SMOKE_EXCHANGE"),
    ) else {
        eprintln!("skipped: set BILAUNCHER_SMOKE_RPC and BILAUNCHER_SMOKE_EXCHANGE");
        return;
    };
    let exchange: Address = ex.parse().unwrap();
    let chain = RpcChain::new(&rpc, exchange, PORTAL, ALICE).unwrap();
    let start = chain.deploy_block().await.unwrap();
    let domain = Domain {
        chain_id: 97,
        exchange,
    };
    let app = App::new(
        chain,
        Settings {
            domain,
            public_rpc: rpc.clone(),
            factory: Address::ZERO,
            portal: PORTAL,
            batch_ms: 0,
            poll_ms: 1000,
            dev_faucet: true,
            start_block: start,
            price_api: None,
        },
    )
    .await
    .unwrap();
    let alice = TestKey::from_bytes(ALICE.parse::<B256>().unwrap());
    let bob = TestKey::from_bytes(BOB.parse::<B256>().unwrap());
    let before = {
        let s = app.state.lock().unwrap();
        assert!(s.launches.contains_key(&0), "launch 0 decoded");
        assert!(s.confirmed.balance(alice.address()) >= U256::from(E18)); // earlier runs replay as foreign batches
        (s.last_batch_id, s.confirmed.balance(alice.address()))
    };
    let (o1, s1) = signed_order(&domain, &alice, 0, Outcome::Up, Side::Buy, 60, E18);
    let (o2, s2) = signed_order(&domain, &bob, 0, Outcome::Down, Side::Buy, 40, E18);
    app.submit_group(vec![
        Msg::Place { order: o1, sig: s1 },
        Msg::Place { order: o2, sig: s2 },
    ])
    .unwrap();
    let tx = app.run_batch().await.unwrap();
    assert!(tx.is_some());
    let s = app.state.lock().unwrap();
    assert_eq!(s.last_batch_id, before.0 + 1);
    assert_eq!(s.pending_fills(), 0, "our batch was matched from calldata");
    assert_eq!(
        s.confirmed.balance(alice.address()),
        before.1 - U256::from(6 * E18 / 10)
    );
}
