//! The shared EIP-712 vectors (`fixtures/eip712-vectors.json`, verified against viem and Solidity).

use alloy_primitives::{Address, Bytes, B256, U256};
use bilauncher_core::eip712::{authorize_key_hash, cancel_hash, domain_separator, KeyAuthMsg};
use bilauncher_core::{order_hash, recover, Domain, Order, Outcome, Side};
use serde_json::Value;

fn fixture() -> Value {
    let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/eip712-vectors.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_else(|| panic!("missing {k}"))
}

fn n<T: std::str::FromStr>(v: &Value, k: &str) -> T
where
    T::Err: std::fmt::Debug,
{
    s(v, k).parse().unwrap()
}

#[test]
fn matches_fixture() {
    let f = fixture();
    let d = &f["domain"];
    assert_eq!(s(d, "name"), "bilauncher");
    assert_eq!(s(d, "version"), "1");
    let domain = Domain {
        chain_id: n(d, "chainId"),
        exchange: n(d, "verifyingContract"),
    };
    assert_eq!(domain_separator(&domain), n::<B256>(d, "separator"));

    let orders = f["orders"].as_array().unwrap();
    assert!(!orders.is_empty());
    for v in orders {
        let o = &v["order"];
        let order = Order {
            owner: n(o, "owner"),
            launch_id: n::<U256>(o, "launchId"),
            round: n(o, "round"),
            outcome: Outcome::from_u8(n(o, "outcome")).unwrap(),
            side: Side::from_u8(n(o, "side")).unwrap(),
            price: n(o, "price"),
            amount: n(o, "amount"),
            expiry: n(o, "expiry"),
            nonce: n(o, "nonce"),
        };
        let h = order_hash(&domain, &order);
        assert_eq!(h, n::<B256>(v, "hash"));
        let sig: Bytes = n(v, "sig");
        assert_eq!(recover(&h, &sig).unwrap(), n::<Address>(v, "signer"));
    }

    for v in f["keys"].as_array().unwrap() {
        let a = &v["auth"];
        let m = KeyAuthMsg {
            owner: n(a, "owner"),
            key: n(a, "key"),
            expiry: n(a, "expiry"),
            nonce: n(a, "nonce"),
        };
        let h = authorize_key_hash(&domain, &m);
        assert_eq!(h, n::<B256>(v, "hash"));
        let sig: Bytes = n(v, "sig");
        assert_eq!(recover(&h, &sig).unwrap(), n::<Address>(v, "signer"));
    }

    for v in f["cancels"].as_array().unwrap() {
        let c = &v["cancel"];
        let h = cancel_hash(&domain, n(c, "owner"), n(c, "orderHash"), n(c, "nonce"));
        assert_eq!(h, n::<B256>(v, "hash"));
        let sig: Bytes = n(v, "sig");
        assert_eq!(recover(&h, &sig).unwrap(), n::<Address>(v, "signer"));
    }
}

#[test]
fn local_signing_roundtrip() {
    let domain = Domain {
        chain_id: 97,
        exchange: Address::repeat_byte(7),
    };
    let key = bilauncher_core::eip712::TestKey::from_seed("alice");
    let order = Order {
        owner: key.address(),
        launch_id: U256::from(1),
        round: 0,
        outcome: Outcome::Down,
        side: Side::Buy,
        price: 40,
        amount: 10u128.pow(18),
        expiry: u64::MAX,
        nonce: 1,
    };
    let h = order_hash(&domain, &order);
    let sig = key.sign(&h);
    assert_eq!(recover(&h, &sig).unwrap(), key.address());
}
