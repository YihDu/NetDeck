use clap::{Parser, Subcommand};
use netdeck_core::{CancellationToken, discovery, probe, storage};
#[derive(Parser)]
#[command(name = "netdeck", about = "NetDeck · 只读网络诊断", version)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}
#[derive(Subcommand)]
enum Commands {
    Status {
        #[arg(long)]
        json: bool,
    },
    Doctor,
    Diagnose {
        profile_id: String,
    },
}
#[tokio::main]
async fn main() {
    if let Err(e) = execute().await {
        eprintln!("NetDeck: {e}");
        std::process::exit(1);
    }
}
async fn execute() -> Result<(), String> {
    let cli = Cli::parse();
    let cancel = CancellationToken::new();
    let c = cancel.clone();
    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        c.cancel();
    });
    match cli.command {
        Commands::Status { json } => {
            let s = discovery::snapshot(&cancel).await;
            if json {
                println!("{}", serde_json::to_string_pretty(&s).unwrap());
            } else {
                println!(
                    "NetDeck · {}\nmacOS {} / {}\n{} 个监听端口 · {} 个 SSH 别名",
                    s.captured_at,
                    s.os_version,
                    s.arch,
                    s.listeners.len(),
                    s.ssh_aliases.len()
                );
                for e in s.evidence {
                    println!("[{:?}] {}: {}", e.status, e.check, e.summary);
                }
            }
        }
        Commands::Doctor => {
            let s = discovery::snapshot(&cancel).await;
            println!("{}", storage::report(Some(&s), &[]));
        }
        Commands::Diagnose { profile_id } => {
            let config = storage::load()?;
            let p = config
                .profiles
                .iter()
                .find(|p| p.id == profile_id)
                .ok_or("Profile 不存在；请先在桌面端添加")?;
            let r = probe::diagnose(p, &cancel).await;
            println!("{}", storage::report(None, &[r]));
        }
    }
    Ok(())
}
