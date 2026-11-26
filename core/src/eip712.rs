//! EIP-712 (SPEC "EIP-712"): domain `predictlaunch` / `1` / chainId / Exchange.

use alloy_primitives::{keccak256, Address, Signature, B256};
use alloy_sol_types::{Eip712Domain, SolStruct};

use crate::abi;
use crate::types::Order;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Domain {
    pub chain_id: u64,
    pub exchange: Address,
}

impl Domain {
    pub fn eip712(&self) -> Eip712Domain {
        Eip712Domain::new(
            Some("predictlaunch".into()),
            Some("1".into()),
            Some(alloy_primitives::U256::from(self.chain_id)),
            Some(self.exchange),
            None,
        )
    }
}

pub fn domain_separator(d: &Domain) -> B256 {
    d.eip712().separator()
}

/// `orderHash` = the EIP-712 digest of the Order.
pub fn order_hash(d: &Domain, o: &Order) -> B256 {
    abi::Order::from(o).eip712_signing_hash(&d.eip712())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyAuthMsg {
    pub owner: Address,
    pub key: Address,
    pub expiry: u64,
    pub nonce: u64,
}

pub fn authorize_key_hash(d: &Domain, m: &KeyAuthMsg) -> B256 {
    abi::AuthorizeKey {
        owner: m.owner,
        key: m.key,
        expiry: m.expiry,
        nonce: m.nonce,
    }
    .eip712_signing_hash(&d.eip712())
}

pub fn cancel_hash(d: &Domain, owner: Address, order_hash: B256, nonce: u64) -> B256 {
    abi::Cancel {
        owner,
        orderHash: order_hash,
        nonce,
    }
    .eip712_signing_hash(&d.eip712())
}

/// Recover the signer of a 65-byte `r ‖ s ‖ v` signature over a digest.
pub fn recover(digest: &B256, sig: &[u8]) -> anyhow::Result<Address> {
    anyhow::ensure!(sig.len() == 65, "signature must be 65 bytes");
    let s = Signature::from_raw(sig)?;
    Ok(s.recover_address_from_prehash(digest)?)
}

/// A local secp256k1 key for tests, bots and fixtures.
#[derive(Clone)]
pub struct TestKey(k256::ecdsa::SigningKey);

impl TestKey {
    /// Deterministic key from `keccak256(seed)`.
    pub fn from_seed(seed: &str) -> Self {
        Self::from_bytes(keccak256(seed.as_bytes()))
    }
    pub fn from_bytes(b: B256) -> Self {
        Self(k256::ecdsa::SigningKey::from_bytes(b.as_slice().into()).expect("valid key"))
    }
    pub fn address(&self) -> Address {
        Address::from_public_key(self.0.verifying_key())
    }
    /// 65-byte `r ‖ s ‖ v` (v = 27/28).
    pub fn sign(&self, digest: &B256) -> Vec<u8> {
        let (sig, rec) = self
            .0
            .sign_prehash_recoverable(digest.as_slice())
            .expect("signing");
        Signature::from_signature_and_parity(sig, rec.is_y_odd())
            .as_bytes()
            .to_vec()
    }
}
