//! Chart price stream source: Atlas's offchain API (CoinMarketCap-backed, ~10 s updates, no key).
//!
//! Every price poll makes ONE `POST {ATLAS_API}` with `{"page":1,"rows":50,"platformId":293}` (platform
//! 293 = BSC testnet). Items are matched to our feeds by `supportPlatform[].contractAddress` where
//! `platformId == 293`. A feed whose API point is missing or older than [`MAX_API_AGE_MS`] falls back
//! to the onchain `latestRoundData` (see `App::poll_prices`).

use std::collections::HashMap;
use std::time::Duration;

use alloy_primitives::{Address, U256};
use serde_json::Value;

pub const ATLAS_API: &str = "https://api.atlasoracle.io/oracle/user/v1/oracle-feed/search";
pub const PLATFORM_BSC_TESTNET: u64 = 293;
pub const API_TIMEOUT: Duration = Duration::from_secs(5);
/// An API point older than this (by its own timestamp) is not used; the onchain feed is read instead.
pub const MAX_API_AGE_MS: u64 = 30_000;

pub const SOURCE_API: &str = "atlas-api";
pub const SOURCE_ONCHAIN: &str = "onchain";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApiPrice {
    /// 18-decimal USD price.
    pub price: U256,
    /// Unix milliseconds (the API's `timestamp`).
    pub ts_ms: u64,
}

/// `"58748.52189649632"` → 58748521896496320000000 (18 decimals; extra digits are truncated).
pub fn decimal_to_wei(s: &str) -> Option<U256> {
    let s = s.trim();
    if s.is_empty() || s.starts_with('-') || s.contains(['e', 'E']) {
        return None;
    }
    let (int, frac) = s.split_once('.').unwrap_or((s, ""));
    if !int.chars().all(|c| c.is_ascii_digit()) || !frac.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let mut frac18: String = frac.chars().take(18).collect();
    while frac18.len() < 18 {
        frac18.push('0');
    }
    let digits = format!("{}{}", if int.is_empty() { "0" } else { int }, frac18);
    U256::from_str_radix(&digits, 10).ok()
}

/// The JSON number as decimal text without exponent. `f64`'s `Display` is the shortest text that
/// round-trips, which for these API numbers is the text the server sent.
fn number_text(v: &Value) -> Option<String> {
    match v {
        Value::Number(n) => {
            if let Some(u) = n.as_u64() {
                Some(u.to_string())
            } else {
                n.as_f64()
                    .filter(|f| f.is_finite() && *f >= 0.0)
                    .map(|f| format!("{f}"))
            }
        }
        Value::String(s) => Some(s.clone()),
        _ => None,
    }
}

fn as_u64(v: &Value) -> Option<u64> {
    match v {
        Value::String(s) => s.parse().ok(),
        Value::Number(n) => n.as_u64(),
        _ => None,
    }
}

/// Parse the search response: contract address (lowercase-insensitive, as `Address`) → latest point.
/// Accepts `{data:{list:[...]}}`, `{data:[...]}` or a bare array.
pub fn parse_atlas(body: &Value) -> HashMap<Address, ApiPrice> {
    let list = body
        .get("data")
        .map(|d| d.get("list").unwrap_or(d))
        .unwrap_or(body)
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut out = HashMap::new();
    for item in &list {
        let (Some(price), Some(ts_ms)) = (
            item.get("price")
                .and_then(number_text)
                .and_then(|t| decimal_to_wei(&t)),
            item.get("timestamp").and_then(as_u64),
        ) else {
            continue;
        };
        if price.is_zero() {
            continue;
        }
        let Some(plats) = item.get("supportPlatform").and_then(Value::as_array) else {
            continue;
        };
        for p in plats {
            if p.get("platformId").and_then(as_u64) != Some(PLATFORM_BSC_TESTNET) {
                continue;
            }
            let Some(addr) = p
                .get("contractAddress")
                .and_then(Value::as_str)
                .and_then(|a| a.to_lowercase().parse::<Address>().ok())
            else {
                continue;
            };
            out.insert(addr, ApiPrice { price, ts_ms });
        }
    }
    out
}

/// One request to the Atlas API (5 s timeout).
pub async fn fetch_atlas(
    client: &reqwest::Client,
    url: &str,
) -> anyhow::Result<HashMap<Address, ApiPrice>> {
    let body: Value = client
        .post(url)
        .timeout(API_TIMEOUT)
        .json(&serde_json::json!({"page": 1, "rows": 50, "platformId": PLATFORM_BSC_TESTNET}))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(parse_atlas(&body))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn decimal_to_wei_exact() {
        assert_eq!(
            decimal_to_wei("58748.52189649632"),
            Some(U256::from(58748521896496320000000u128))
        );
        assert_eq!(
            decimal_to_wei("0.000054151547864573"),
            Some(U256::from(54151547864573u128))
        );
        assert_eq!(
            decimal_to_wei("600"),
            Some(U256::from(600u128) * U256::from(10u64).pow(U256::from(18)))
        );
        assert_eq!(
            decimal_to_wei("1.1234567890123456789"),
            Some(U256::from(1123456789012345678u128))
        );
        assert_eq!(decimal_to_wei("-1"), None);
        assert_eq!(decimal_to_wei("1e5"), None);
    }

    #[test]
    fn parses_fixture() {
        let body = json!({"status": 200, "data": {"list": [
            {"symbol":"BTCB","feedName":"BTCB / USD","price":58748.52189649632,"timestamp":"1795605328075",
             "supportPlatform":[{"platformId":14,"contractAddress":"0x1111111111111111111111111111111111111111"},
                                {"platformId":293,"contractAddress":"0xe20536bc715aac6560394e33deb66ed205aeec33"}]},
            {"symbol":"OIK","price":0.000054151547864573,"timestamp":"1795605448240",
             "supportPlatform":[{"platformId":293,"contractAddress":"0xFE9A5337DA82A0FC8476C2A1EDC292D729D29F71"}]},
            {"symbol":"MAINNET-ONLY","price":1.0,"timestamp":"1795605448240",
             "supportPlatform":[{"platformId":14,"contractAddress":"0x2222222222222222222222222222222222222222"}]},
            {"symbol":"BROKEN","price":null,"timestamp":"1"}
        ]}});
        let m = parse_atlas(&body);
        assert_eq!(m.len(), 2);
        let btc: Address = "0xe20536bc715aac6560394e33deb66ed205aeec33"
            .parse()
            .unwrap();
        assert_eq!(
            m[&btc],
            ApiPrice {
                price: U256::from(58748521896496320000000u128),
                ts_ms: 1795605328075
            }
        );
        let oik: Address = "0xfe9a5337da82a0fc8476c2a1edc292d729d29f71"
            .parse()
            .unwrap();
        assert_eq!(m[&oik].price, U256::from(54151547864573u128));
    }
}
