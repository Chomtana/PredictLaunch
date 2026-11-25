//! `cargo run -p bilauncher-sequencer -- --help`

use alloy_primitives::Address;
use anyhow::Context;
use bilauncher_core::{Domain, PORTAL};
use bilauncher_sequencer::{api, app, chain::RpcChain};
use clap::Parser;

#[derive(Parser)]
#[command(about = "bilauncher sequencer: soft-confirmed matching, batches, keeper, HTTP/WS API")]
struct Args {
    /// JSON-RPC of the chain the Exchange lives on (the anvil fork in the demo).
    #[arg(long, env = "BILAUNCHER_RPC", default_value = "http://127.0.0.1:8545")]
    rpc: String,
    /// RPC URL handed to the frontend in /api/config (defaults to --rpc).
    #[arg(long, env = "BILAUNCHER_PUBLIC_RPC")]
    public_rpc: Option<String>,
    /// Exchange address (EIP-712 verifyingContract).
    #[arg(long, env = "BILAUNCHER_EXCHANGE")]
    exchange: Address,
    /// BilauncherLauncherFactory address (returned in /api/config for Portal.newLauncher).
    #[arg(long, env = "BILAUNCHER_FACTORY", default_value_t = Address::ZERO)]
    factory: Address,
    /// Flap Portal address.
    #[arg(long, env = "BILAUNCHER_PORTAL", default_value_t = PORTAL)]
    portal: Address,
    /// Operator private key (must be enabled with Exchange.setOperator; pays keeper gas too).
    #[arg(long, env = "BILAUNCHER_OPERATOR_KEY")]
    operator_key: String,
    #[arg(long, env = "BILAUNCHER_PORT", default_value_t = 8787)]
    port: u16,
    #[arg(long, env = "BILAUNCHER_HOST", default_value = "127.0.0.1")]
    host: String,
    /// Batch interval in milliseconds (capped at 8000 so batches stay within MAX_LAG).
    #[arg(long, env = "BILAUNCHER_BATCH_MS", default_value_t = 2000)]
    batch_ms: u64,
    /// Chain poll + keeper interval in milliseconds.
    #[arg(long, env = "BILAUNCHER_POLL_MS", default_value_t = 1000)]
    poll_ms: u64,
    /// Enable POST /api/faucet (anvil_setBalance 1000 BNB, plus a 10,000 mint of an ERC20 quote token). Fork/dev
    /// only.
    #[arg(long, env = "BILAUNCHER_DEV_FAUCET")]
    dev_faucet: bool,
    /// First block to read Exchange logs from (default: found by binary search on its code).
    #[arg(long, env = "BILAUNCHER_START_BLOCK")]
    start_block: Option<u64>,
    /// Atlas offchain price API for the chart stream ("off" = onchain feeds only).
    #[arg(long, env = "BILAUNCHER_PRICE_API", default_value = bilauncher_sequencer::prices::ATLAS_API)]
    price_api: String,
    /// Display name for the quote token (default: its on-chain symbol; "BNB" for native).
    #[arg(long, env = "BILAUNCHER_QUOTE_SYMBOL")]
    quote_symbol: Option<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let args = Args::parse();
    let chain = RpcChain::new(&args.rpc, args.exchange, args.portal, &args.operator_key)?;
    let operator = chain.operator;
    let start_block = match args.start_block {
        Some(b) => b,
        None => chain
            .deploy_block()
            .await
            .context("finding the Exchange deployment block")?,
    };
    let info = bilauncher_sequencer::chain::Chain::info(&chain)
        .await
        .context("connecting to the RPC")?;
    let settings = app::Settings {
        domain: Domain {
            chain_id: info.chain_id,
            exchange: args.exchange,
        },
        public_rpc: args.public_rpc.unwrap_or(args.rpc.clone()),
        factory: args.factory,
        portal: args.portal,
        batch_ms: args.batch_ms,
        poll_ms: args.poll_ms,
        dev_faucet: args.dev_faucet,
        start_block,
        price_api: (!args.price_api.is_empty() && args.price_api != "off")
            .then_some(args.price_api.clone()),
        quote_symbol: args.quote_symbol.clone(),
    };
    let app = app::App::new(chain, settings).await?;
    app.spawn_background();
    let addr = format!("{}:{}", args.host, args.port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .with_context(|| format!("binding {addr}"))?;
    tracing::info!(
        "bilauncher sequencer on http://{addr} (Exchange {}, chain {}, operator {operator}, from block {start_block}, batch every {} ms{})",
        args.exchange,
        info.chain_id,
        args.batch_ms,
        if args.dev_faucet { ", dev faucet ON" } else { "" }
    );
    axum::serve(listener, api::router(app))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
