use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Health {
    Healthy,
    Degraded,
    Down,
    Unknown,
    Checking,
    NotConfigured,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Observed,
    Configured,
    Historical,
    Mock,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub check: String,
    pub status: Health,
    pub source: Source,
    pub summary: String,
    pub detail: String,
    pub checked_at: String,
    pub latency_ms: u64,
    pub error_code: Option<String>,
}
impl Evidence {
    pub fn new(
        check: &str,
        status: Health,
        summary: impl Into<String>,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            check: check.into(),
            status,
            source: Source::Observed,
            summary: summary.into(),
            detail: detail.into(),
            checked_at: now(),
            latency_ms: 0,
            error_code: None,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ProfileKind {
    Tcp,
    Https,
    HttpProxy,
    Socks5Proxy,
    Ssh,
    Tailscale,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    pub id: String,
    pub label: String,
    pub kind: ProfileKind,
    pub enabled: bool,
    pub source: Source,
    pub host: String,
    pub port: u16,
    pub ssh_alias: String,
    pub test_url: String,
    pub expected_cidr: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preferences {
    pub theme: String,
    pub refresh_seconds: u64,
    pub auto_diagnose: bool,
    pub diagnose_seconds: u64,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            theme: "dark".into(),
            refresh_seconds: 15,
            auto_diagnose: false,
            diagnose_seconds: 60,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub version: u32,
    pub profiles: Vec<Profile>,
    pub preferences: Preferences,
    #[serde(default)]
    pub controls: Controls,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            version: 2,
            profiles: vec![],
            preferences: Preferences::default(),
            controls: Controls::default(),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub profile_id: String,
    #[serde(default)]
    pub profile_signature: String,
    pub label: String,
    pub status: Health,
    pub started_at: String,
    pub finished_at: String,
    pub cancelled: bool,
    pub steps: Vec<Evidence>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyEndpoint {
    pub protocol: String,
    pub host: String,
    pub port: u16,
    pub enabled: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProxySettings {
    pub endpoints: Vec<ProxyEndpoint>,
    pub pac_enabled: bool,
    pub pac_url: Option<String>,
    pub bypass: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Listener {
    pub process: String,
    pub pid: u32,
    pub address: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub name: String,
    pub ips: Vec<String>,
    pub online: bool,
    pub os: String,
    pub routes: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tailscale {
    pub state: String,
    pub self_ips: Vec<String>,
    pub peers: Vec<Peer>,
    pub accept_routes: Option<bool>,
    pub exit_node: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub captured_at: String,
    pub os_version: String,
    pub arch: String,
    pub default_route: BTreeMap<String, String>,
    pub system_proxy: ProxySettings,
    pub shell_proxy: BTreeMap<String, String>,
    pub listeners: Vec<Listener>,
    pub tailscale: Option<Tailscale>,
    pub ssh_aliases: Vec<String>,
    pub evidence: Vec<Evidence>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    pub alias: String,
    pub hostname: String,
    pub port: u16,
    pub proxy_jump: Option<String>,
    pub proxy_command: bool,
    pub local_forwards: Vec<String>,
    pub remote_forwards: Vec<String>,
    pub identity_count: usize,
    pub duplicate_ports: Vec<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Controls {
    #[serde(default)]
    pub tunnels: Vec<TunnelDefinition>,
    #[serde(default)]
    pub workflows: Vec<Workflow>,
    #[serde(default)]
    pub gateway_profile_id: String,
    #[serde(default = "default_gateway_port")]
    pub gateway_port: u16,
}
fn default_gateway_port() -> u16 {
    18080
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TunnelDefinition {
    pub id: String,
    pub label: String,
    pub alias: String,
    pub direction: String,
    pub listen_port: u16,
    pub target_host: String,
    pub target_port: u16,
    pub reuse_config: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Workflow {
    pub id: String,
    pub label: String,
    pub profile_ids: Vec<String>,
}

impl Default for Controls {
    fn default() -> Self {
        Self {
            tunnels: vec![],
            workflows: vec![],
            gateway_profile_id: String::new(),
            gateway_port: 18080,
        }
    }
}

pub fn profile_signature(p: &Profile) -> String {
    serde_json::json!([
        p.id,
        p.label,
        p.kind,
        p.enabled,
        p.source,
        p.host,
        p.port,
        p.ssh_alias,
        p.test_url,
        p.expected_cidr
    ])
    .to_string()
}
