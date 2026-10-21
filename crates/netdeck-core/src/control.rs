//! Typed operations. Preview tokens are single use, expire, and preserve the exact request.
use crate::{CancellationToken, command, discovery, gateway, model::*, safety, ssh, storage};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    net::TcpListener,
    process::Child,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    TunnelStart {
        id: String,
        alias: String,
        direction: String,
        listen_port: u16,
        target_host: String,
        target_port: u16,
        reuse_config: bool,
    },
    TunnelStop {
        id: String,
    },
    SshAuth {
        alias: String,
    },
    RemoteCheck {
        alias: String,
        port: u16,
        url: String,
    },
    GatewayStart {
        profile_id: String,
        port: u16,
    },
    GatewayStop,
    Tailscale {
        setting: String,
        value: String,
    },
    SystemProxy {
        service: String,
        protocol: String,
        host: String,
        port: u16,
        enabled: bool,
    },
    Rollback {
        id: String,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub id: String,
    pub title: String,
    pub commands: Vec<String>,
    pub warnings: Vec<String>,
    pub rollback: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeItem {
    pub id: String,
    pub label: String,
    pub status: String,
    pub detail: String,
    pub started_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub id: String,
    pub at: String,
    pub title: String,
    pub success: bool,
    pub detail: String,
    pub reversible: bool,
}
#[derive(Clone, Serialize, Deserialize)]
struct Change {
    exe: String,
    read: Vec<String>,
    before: String,
    after: Vec<String>,
    undo: Vec<String>,
    expected: Option<String>,
}
struct Pending {
    at: Instant,
    plan: Plan,
    request: Request,
    file: Option<tempfile::NamedTempFile>,
    changes: Vec<Change>,
    upstream: Option<Profile>,
    generation: Option<String>,
}
struct Tunnel {
    child: Child,
    group: Option<i32>,
    _file: tempfile::NamedTempFile,
    view: RuntimeItem,
    log: Arc<Mutex<String>>,
    authenticated: Arc<std::sync::atomic::AtomicBool>,
    reader: tokio::task::JoinHandle<()>,
}
impl Drop for Tunnel {
    fn drop(&mut self) {
        self.stop_group();
        let _ = self.child.start_kill();
        self.reader.abort();
    }
}
impl Tunnel {
    fn stop_group(&mut self) {
        if let Some(group) = self.group.take() {
            // Each owned SSH process starts a fresh process group. This also cleans up
            // ProxyCommand/ProxyJump descendants, without targeting external sessions.
            unsafe {
                libc::kill(-group, libc::SIGKILL);
            }
        }
    }
}
struct Gateway {
    cancel: CancellationToken,
    task: tokio::task::JoinHandle<()>,
    view: RuntimeItem,
    port: u16,
    monitor: tokio::task::JoinHandle<()>,
    health: Arc<Mutex<Diagnostic>>,
    upstream: Arc<std::sync::RwLock<Profile>>,
}
impl Drop for Gateway {
    fn drop(&mut self) {
        self.cancel.cancel();
        self.monitor.abort();
    }
}
#[derive(Default)]
pub struct Controller {
    pending: BTreeMap<String, Pending>,
    tunnels: BTreeMap<String, Tunnel>,
    gateway: Option<Gateway>,
    receipts: Vec<Receipt>,
    undos: BTreeMap<String, Vec<Change>>,
    sequence: u64,
}
fn id(seq: u64) -> String {
    format!(
        "{}-{seq}",
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    )
}
async fn run(exe: &str, args: &[String]) -> Result<String, String> {
    let refs: Vec<_> = args.iter().map(String::as_str).collect();
    let r = command::run(exe, &refs, 15, &CancellationToken::new())
        .await
        .map_err(|e| e.message)?;
    if r.code != 0 {
        Err(format!(
            "命令失败（{}）：{}",
            r.code,
            safety::redact(&r.stderr)
        ))
    } else {
        Ok(r.stdout.trim().to_string())
    }
}
fn args(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|s| s.to_string()).collect()
}
fn ssh_args(path: &std::path::Path, alias: &str) -> Vec<String> {
    args(&[
        "-F",
        &path.to_string_lossy(),
        "-T",
        "-n",
        "-v",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "UpdateHostKeys=no",
        "-o",
        "PermitLocalCommand=no",
        "-o",
        "ForwardAgent=no",
        "-o",
        "ControlMaster=no",
        "-o",
        "ControlPath=none",
        "-o",
        "ConnectTimeout=8",
        "-o",
        "ConnectionAttempts=1",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "ExitOnForwardFailure=yes",
        alias,
    ])
}
async fn effective_file(file: &tempfile::NamedTempFile, alias: &str) -> Result<SshConfig, String> {
    let output = run(
        "/usr/bin/ssh",
        &args(&["-G", "-F", &file.path().to_string_lossy(), alias]),
    )
    .await?;
    ssh::parse_effective(alias, &output).map_err(|e| e.message)
}
fn validate_forward(text: &str) -> bool {
    let Some((listen, target)) = text.split_once(' ') else {
        return false;
    };
    let loopback = listen.parse::<u16>().is_ok()
        || listen.starts_with("127.0.0.1:")
        || listen.starts_with("[::1]:")
        || listen.starts_with("localhost:");
    loopback && !target.contains('/') && ssh::forward_port(text).is_some_and(|p| p > 0)
}
fn proxy_restore(protocol: &str, service: &str, text: &str) -> Result<Vec<String>, String> {
    let fields: BTreeMap<_, _> = text.lines().filter_map(|l| l.split_once(": ")).collect();
    if fields
        .get("Authenticated Proxy Enabled")
        .is_some_and(|v| *v == "1" || *v == "Yes")
    {
        return Err("含认证的系统代理无法安全保存凭据，未执行".into());
    }
    let host = fields.get("Server").copied().unwrap_or("");
    let port = fields.get("Port").copied().unwrap_or("0");
    if !host.is_empty() && port != "0" {
        Ok(args(&[&format!("-set{protocol}"), service, host, port]))
    } else {
        Ok(vec![])
    }
}
impl Controller {
    pub fn runtime(&mut self) -> Vec<RuntimeItem> {
        let mut rows = vec![];
        for tunnel in self.tunnels.values_mut() {
            if let Ok(Some(status)) = tunnel.child.try_wait() {
                tunnel.view.status = "down".into();
                tunnel.view.detail = format!(
                    "SSH 已退出（{status}）。{}",
                    tunnel.log.lock().map(|s| s.clone()).unwrap_or_default()
                );
            }
            if tunnel.view.status == "down" {
                tunnel.stop_group();
            }
            rows.push(tunnel.view.clone());
        }
        if let Some(g) = &self.gateway {
            let mut row = g.view.clone();
            if let Ok(d) = g.health.lock() {
                row.status = match d.status {
                    Health::Healthy => "healthy",
                    Health::Down => "down",
                    Health::Degraded => "degraded",
                    _ => "unknown",
                }
                .into();
                row.detail = format!(
                    "上游 {} · 最近检查 {} · 每 60 秒复查 HTTPS 出口",
                    d.label, d.finished_at
                );
            }
            if g.task.is_finished() {
                row.status = "down".into();
                row.detail = "网关任务已退出".into();
            }
            rows.push(row);
        }
        rows
    }
    pub fn receipts(&self) -> Vec<Receipt> {
        self.receipts.iter().rev().take(100).cloned().collect()
    }
    pub async fn services() -> Result<Vec<String>, String> {
        Ok(run(
            "/usr/sbin/networksetup",
            &args(&["-listallnetworkservices"]),
        )
        .await?
        .lines()
        .skip(1)
        .filter(|l| !l.starts_with('*'))
        .map(str::to_string)
        .collect())
    }
    fn generation(&self, request: &Request) -> Option<String> {
        match request {
            Request::TunnelStart { id, .. } | Request::TunnelStop { id } => {
                self.tunnels.get(id).map(|t| t.view.started_at.clone())
            }
            Request::GatewayStart { .. } | Request::GatewayStop => {
                self.gateway.as_ref().map(|g| g.view.started_at.clone())
            }
            _ => None,
        }
    }
    pub fn discard(&mut self, ids: &[String]) {
        for id in ids {
            self.pending.remove(id);
        }
    }
    pub async fn preview(&mut self, request: Request) -> Result<Plan, String> {
        self.pending
            .retain(|_, p| p.at.elapsed() < Duration::from_secs(300));
        if self.pending.len() >= 128 {
            return Err("待确认操作过多，请稍后重试".into());
        }
        self.sequence += 1;
        let mut p = Plan {
            id: id(self.sequence),
            title: String::new(),
            commands: vec![],
            warnings: vec![],
            rollback: "使用主面板的停止按钮，释放 NetDeck 自己创建的连接。".into(),
        };
        let mut file = None;
        let mut changes = vec![];
        let mut upstream = None;
        match &request {
            Request::TunnelStart {
                id,
                alias,
                direction,
                listen_port,
                target_host,
                target_port,
                reuse_config,
            } => {
                if self.tunnels.len() >= 32 && !self.tunnels.contains_key(id) {
                    return Err("最多同时管理 32 个隧道".into());
                }
                if !safety::valid_alias(id)
                    || !["local", "remote"].contains(&direction.as_str())
                    || *listen_port == 0
                    || *target_port == 0
                    || !safety::valid_host(target_host)
                {
                    return Err("转发参数无效".into());
                }
                if self
                    .tunnels
                    .get_mut(id)
                    .is_some_and(|t| t.child.try_wait().ok().flatten().is_none())
                {
                    return Err("此隧道正在运行，请先停止".into());
                }
                let (f, skipped) = ssh::session_config(alias, *reuse_config)?;
                let c = effective_file(&f, alias).await?;
                if *reuse_config && (c.local_forwards.is_empty() && c.remote_forwards.is_empty()) {
                    return Err("该别名没有可沿用的转发规则".into());
                }
                if *reuse_config
                    && (c
                        .local_forwards
                        .iter()
                        .chain(&c.remote_forwards)
                        .any(|s| !validate_forward(s))
                        || !c.duplicate_ports.is_empty())
                {
                    return Err(
                        "Config 中转发非 loopback、格式不支持或远端端口重复，请选择明确覆盖".into(),
                    );
                }
                if skipped {
                    p.warnings.push("已跳过 Match exec 动态条件；本次使用冻结后的静态配置，可能与终端行为不同。".into());
                }
                if c.proxy_command || c.proxy_jump.is_some() {
                    p.warnings.push("此别名包含 ProxyCommand / ProxyJump。确认后将调用你已有配置中的连接程序及跳板；请确保信任该配置。".into());
                }
                p.title = format!(
                    "建立 {alias} 的 {}",
                    if *reuse_config {
                        "Config 转发"
                    } else if direction == "remote" {
                        "反向转发"
                    } else {
                        "本地转发"
                    }
                );
                p.commands.push(if *reuse_config {format!("ssh -N -F <冻结配置> {alias}\nLocalForward: {:?}\nRemoteForward: {:?}",c.local_forwards,c.remote_forwards)}else{format!("ssh -N -{} 127.0.0.1:{listen_port}:{target_host}:{target_port} -F <移除原转发的配置> {alias}",if direction=="remote"{"R"}else{"L"})});
                file = Some(f);
            }
            Request::SshAuth { alias } | Request::RemoteCheck { alias, .. } => {
                let (f, skipped) = ssh::session_config(alias, false)?;
                let c = effective_file(&f, alias).await?;
                if skipped {
                    p.warnings.push("Match exec 条件已跳过。".into());
                }
                if c.proxy_command || c.proxy_jump.is_some() {
                    p.warnings
                        .push("将使用已有 ProxyCommand / ProxyJump，请确认信任原配置。".into());
                }
                p.title = format!("验证 {alias} 的 SSH 认证");
                p.commands.push(format!(
                    "ssh -N -o ClearAllForwardings=yes -F <冻结配置> {alias}"
                ));
                p.rollback = "检查结束自动关闭认证会话，不运行远端交互 Shell。".into();
                if let Request::RemoteCheck { port, url, .. } = &request {
                    if *port == 0 {
                        return Err("远端端口无效".into());
                    }
                    safety::validate_url(url)?;
                    p.title = format!("验证 {alias} 的远端代理出口");
                    p.commands = vec![format!(
                        "ssh {alias} curl --proxy http://127.0.0.1:{port} --noproxy '' --max-time 8 --head {url}"
                    )];
                    p.warnings.push("将在远端执行固定 curl 检查，要求远端已安装 curl；只检查 HTTP 响应，不读取内容。".into());
                }
                file = Some(f);
            }
            Request::TunnelStop { id } => {
                if !self.tunnels.contains_key(id) {
                    return Err("此隧道不属于 NetDeck".into());
                }
                p.title = "停止所选隧道".into();
                p.commands.push(format!("终止 NetDeck 持有的子进程：{id}"));
                p.rollback = "需要恢复时重新预览并启动此隧道。".into();
            }
            Request::GatewayStart { profile_id, port } => {
                if *port < 1024 {
                    return Err("网关端口须为 1024–65535".into());
                }
                let profile = storage::load()?
                    .profiles
                    .into_iter()
                    .find(|v| v.id == *profile_id && v.enabled)
                    .ok_or("请先配置并启用上游代理")?;
                if !matches!(
                    profile.kind,
                    ProfileKind::HttpProxy | ProfileKind::Socks5Proxy
                ) {
                    return Err("需要 HTTP 或 SOCKS5 上游".into());
                }
                if ["127.0.0.1", "localhost", "::1"].contains(&profile.host.as_str())
                    && profile.port == *port
                {
                    return Err("上游不能指向网关自身".into());
                }
                upstream = Some(profile.clone());
                p.title = "启动 / 切换稳定代理入口".into();
                p.commands.push(format!(
                    "127.0.0.1:{port} → {:?} {}:{}",
                    profile.kind, profile.host, profile.port
                ));
                p.warnings.push(
                    "执行前会验证上游 HTTPS 出口。同端口切换仅影响新连接；上游失败不会直连。"
                        .into(),
                );
            }
            Request::GatewayStop => {
                p.title = "停止稳定代理入口".into();
                p.commands.push("关闭本应用网关及其所有连接".into());
            }
            Request::Tailscale { setting, value } => {
                let exe = discovery::tailscale_executable().ok_or("未发现 Tailscale CLI")?;
                let before = run(&exe, &args(&["debug", "prefs"])).await?;
                let prefs: serde_json::Value =
                    serde_json::from_str(&before).map_err(|_| "Tailscale 设置无法解析")?;
                let (key, old) = match setting.as_str() {
                    "accept-routes" => (
                        "RouteAll",
                        prefs["RouteAll"]
                            .as_bool()
                            .ok_or("无法读取接受路由设置")?
                            .to_string(),
                    ),
                    "exit-node" => (
                        "ExitNodeIP",
                        prefs["ExitNodeIP"].as_str().unwrap_or("").to_string(),
                    ),
                    "connected" => (
                        "WantRunning",
                        prefs["WantRunning"]
                            .as_bool()
                            .ok_or("无法读取连接设置")?
                            .to_string(),
                    ),
                    _ => return Err("不支持的 Tailscale 操作".into()),
                };
                if setting == "exit-node" {
                    if !value.is_empty() && value.parse::<std::net::IpAddr>().is_err() {
                        return Err("Exit Node 请输入已授权节点的 IP，留空关闭".into());
                    }
                    if !prefs["ExitNodeID"].as_str().unwrap_or("").is_empty() && old.is_empty() {
                        return Err(
                            "当前 Exit Node 仅有节点 ID，无法准确恢复，请先在 Tailscale 客户端管理"
                                .into(),
                        );
                    }
                } else if !["true", "false"].contains(&value.as_str()) {
                    return Err("设置值无效".into());
                }
                let command = |v: &str| {
                    if setting == "connected" {
                        if v == "true" {
                            args(&["up", "--timeout=8s"])
                        } else {
                            args(&["down"])
                        }
                    } else {
                        vec!["set".into(), format!("--{setting}={v}")]
                    }
                };
                changes.push(Change {
                    exe,
                    read: args(&["debug", "prefs"]),
                    before: format!("{key}={old}"),
                    after: command(value),
                    undo: command(&old),
                    expected: Some(format!("{key}={value}")),
                });
                p.title = format!("Tailscale：{setting} = {value}");
                p.rollback =
                    "可撤销至操作前设置；如果外部程序已改变此设置，撤销会拒绝覆盖。".into();
                p.warnings.push(
                    "会影响正在使用 Tailscale 的连接。登录未完成时请在官方客户端完成登录。".into(),
                );
            }
            Request::SystemProxy {
                service,
                protocol,
                host,
                port,
                enabled,
            } => {
                if !Self::services().await?.contains(service)
                    || !["webproxy", "securewebproxy", "socksfirewallproxy"]
                        .contains(&protocol.as_str())
                    || (*enabled && (!safety::valid_host(host) || *port == 0))
                {
                    return Err("网络服务或代理参数无效".into());
                }
                let read = vec![format!("-get{protocol}"), service.clone()];
                let before = run("/usr/sbin/networksetup", &read).await?;
                let restore = proxy_restore(protocol, service, &before)?;
                let old_on = before.lines().any(|l| l == "Enabled: Yes");
                if *enabled && restore.is_empty() {
                    return Err("该网络服务原代理地址为空，无法完整回滚。请先在系统设置中配置一次代理地址。".into());
                }
                let mut undo = restore;
                undo.push("\nSTATE\n".into());
                undo.extend([
                    format!("-set{protocol}state"),
                    service.clone(),
                    if old_on { "on" } else { "off" }.into(),
                ]);
                let mut after = if *enabled {
                    vec![
                        format!("-set{protocol}"),
                        service.clone(),
                        host.clone(),
                        port.to_string(),
                    ]
                } else {
                    vec![]
                };
                after.push("\nSTATE\n".into());
                after.extend([
                    format!("-set{protocol}state"),
                    service.clone(),
                    if *enabled { "on" } else { "off" }.into(),
                ]);
                let expected = before
                    .lines()
                    .map(|line| {
                        if line.starts_with("Enabled: ") {
                            format!("Enabled: {}", if *enabled { "Yes" } else { "No" })
                        } else if *enabled && line.starts_with("Server: ") {
                            format!("Server: {host}")
                        } else if *enabled && line.starts_with("Port: ") {
                            format!("Port: {port}")
                        } else {
                            line.to_string()
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                changes.push(Change {
                    exe: "/usr/sbin/networksetup".into(),
                    read,
                    before,
                    after,
                    undo,
                    expected: Some(expected),
                });
                p.title = format!(
                    "{} {service} 的 {protocol}",
                    if *enabled { "设置" } else { "关闭" }
                );
                p.rollback = "恢复此网络服务原代理地址与开关；不改变 PAC 或绕过列表。".into();
                p.warnings.push("仅影响所选系统代理类型。PAC、HTTPS 和 Shell 代理独立配置；权限不足时不会提权。".into());
            }
            Request::Rollback { id } => {
                let saved = self.undos.get(id).ok_or("此操作没有可用恢复快照")?;
                for c in saved {
                    validate_change(c)?;
                    let current = read_change(c).await?;
                    if c.expected.as_ref() != Some(&current) {
                        return Err("设置已被外部修改，拒绝覆盖，请重新检查".into());
                    }
                    let mut reverse = c.clone();
                    reverse.before = current;
                    reverse.after = c.undo.clone();
                    reverse.undo = c.after.clone();
                    reverse.expected = Some(c.before.clone());
                    changes.push(reverse);
                }
                p.title = "恢复操作前设置".into();
            }
        }
        for c in &changes {
            p.commands.push(format!("{} {}", c.exe, c.after.join(" ")));
        }
        self.pending.insert(
            p.id.clone(),
            Pending {
                at: Instant::now(),
                plan: p.clone(),
                generation: self.generation(&request),
                request,
                file,
                changes,
                upstream,
            },
        );
        Ok(p)
    }
    pub async fn execute(&mut self, plan_id: &str) -> Result<Receipt, String> {
        let mut pending = self
            .pending
            .remove(plan_id)
            .ok_or("预览不存在或已使用，请重新预览")?;
        if pending.at.elapsed() > Duration::from_secs(300) {
            return Err("预览已过期，请重新预览".into());
        }
        let result = self.perform(&mut pending).await;
        let receipt = Receipt {
            id: plan_id.into(),
            at: now(),
            title: pending.plan.title,
            success: result.is_ok(),
            detail: result.unwrap_or_else(|e| e),
            reversible: self.undos.contains_key(plan_id),
        };
        if let Some(previous) = self.receipts.iter_mut().find(|r| r.id == receipt.id) {
            *previous = receipt.clone();
        } else {
            self.receipts.push(receipt.clone());
        }
        if self.receipts.len() > 100 {
            self.receipts.remove(0);
        }
        // Audit failures never turn an already executed operation into a retryable IPC error.
        #[cfg(not(test))]
        if self.persist().is_err() {
            let mut receipt = receipt;
            receipt.detail.push_str(
                " 注意：操作记录未能保存到磁盘，重启后可能无法撤销；请保留当前状态信息。",
            );
            if let Some(last) = self.receipts.last_mut() {
                *last = receipt.clone();
            }
            return Ok(receipt);
        }
        Ok(receipt)
    }
    #[cfg(not(test))]
    fn persist(&self) -> Result<(), String> {
        use std::io::Write;
        let dir = storage::data_dir()?;
        std::fs::create_dir_all(&dir).map_err(|_| "无法创建记录目录")?;
        let mut f = tempfile::NamedTempFile::new_in(&dir).map_err(|_| "无法保存记录")?;
        serde_json::to_writer_pretty(
            &mut f,
            &serde_json::json!({"receipts":self.receipts,"undos":self.undos}),
        )
        .map_err(|_| "无法序列化记录")?;
        f.flush().map_err(|_| "无法写入记录")?;
        f.persist(dir.join("operations.json"))
            .map_err(|_| "无法保存记录")?;
        Ok(())
    }
    pub fn load() -> Self {
        let mut c = Self::default();
        if let Ok(dir) = storage::data_dir() {
            let path = dir.join("operations.json");
            if std::fs::metadata(&path).is_ok_and(|m| m.len() < 1024 * 1024)
                && let Ok(text) = std::fs::read_to_string(path)
                && let Ok(v) = serde_json::from_str::<serde_json::Value>(&text)
            {
                c.receipts = serde_json::from_value(v["receipts"].clone()).unwrap_or_default();
                c.undos = serde_json::from_value(v["undos"].clone()).unwrap_or_default();
            }
        }
        c
    }
    async fn perform(&mut self, p: &mut Pending) -> Result<String, String> {
        if self.generation(&p.request) != p.generation {
            return Err("连接状态自预览后发生变化，请重新预览".into());
        }
        if !p.changes.is_empty() {
            for c in &p.changes {
                if read_change(c).await? != c.before {
                    return Err("设置自预览后发生变化，请重新预览".into());
                }
            }
            self.undos.insert(p.plan.id.clone(), p.changes.clone());
            self.receipts.push(Receipt {
                id: p.plan.id.clone(),
                at: now(),
                title: p.plan.title.clone(),
                success: false,
                detail: "已保存操作前快照。若应用意外退出，请先刷新核对当前设置，再预览撤销。"
                    .into(),
                reversible: true,
            });
            #[cfg(not(test))]
            if let Err(error) = self.persist() {
                self.undos.remove(&p.plan.id);
                return Err(format!("未执行：无法先保存恢复快照：{error}"));
            }
            for c in &mut p.changes {
                if let Err(error) = apply(c, &c.after).await {
                    return Err(self.recover(&p.plan.id, c, &error).await);
                }
                let actual = match read_change(c).await {
                    Ok(value) => value,
                    Err(error) => {
                        return Err(self
                            .recover(&p.plan.id, c, &format!("执行后读取失败：{error}"))
                            .await);
                    }
                };
                if c.expected.as_ref() != Some(&actual) {
                    return Err(self.recover(&p.plan.id, c, "执行后状态与预期不一致").await);
                }
                c.expected = Some(actual);
            }
            self.undos.insert(p.plan.id.clone(), p.changes.clone());
            while self.undos.len() > 100 {
                if let Some(key) = self.undos.keys().next().cloned() {
                    self.undos.remove(&key);
                }
            }
            return Ok("已执行并重新读取验证；可从操作记录撤销。".into());
        }
        match &p.request {
            Request::GatewayStart { profile_id, port } => {
                let profile = p.upstream.clone().ok_or("上游预览不可用")?;
                let current = storage::load()?
                    .profiles
                    .into_iter()
                    .find(|v| v.id == *profile_id && v.enabled)
                    .ok_or("上游已停用，请重新预览")?;
                if serde_json::to_value(&current).ok() != serde_json::to_value(&profile).ok() {
                    return Err("上游自预览后发生变化，请重新预览".into());
                }
                let diagnostic = crate::probe::diagnose(&profile, &CancellationToken::new()).await;
                if diagnostic.status != Health::Healthy {
                    return Err(
                        "上游检测未全部通过，保留现有网关。请先检查代理握手和 HTTPS 出口。".into(),
                    );
                }
                if let Some(g) = &mut self.gateway
                    && g.port == *port
                    && !g.task.is_finished()
                {
                    *g.upstream.write().map_err(|_| "上游状态锁不可用")? = profile.clone();
                    g.view.detail = format!("新连接使用 {}；已有连接保持原上游", profile.label);
                    g.view.started_at = now();
                    *g.health.lock().map_err(|_| "健康状态锁不可用")? = diagnostic;
                    return Ok("新上游已验证并切换；已有连接不受影响。".into());
                }
                let listener = TcpListener::bind(("127.0.0.1", *port))
                    .await
                    .map_err(|_| "本地端口被占用，保留现有网关")?;
                if let Some(mut old) = self.gateway.take() {
                    old.cancel.cancel();
                    let _ = (&mut old.task).await;
                }
                let cancel = CancellationToken::new();
                let upstream = Arc::new(std::sync::RwLock::new(profile.clone()));
                let task = tokio::spawn(gateway::serve_managed(
                    listener,
                    upstream.clone(),
                    cancel.clone(),
                ));
                let health = Arc::new(Mutex::new(diagnostic));
                let health_ref = health.clone();
                let upstream_ref = upstream.clone();
                let monitor_cancel = cancel.clone();
                let monitor = tokio::spawn(async move {
                    loop {
                        tokio::select! {_=monitor_cancel.cancelled()=>break,_=tokio::time::sleep(Duration::from_secs(60))=>{}}
                        let Ok(profile) = upstream_ref.read().map(|p| p.clone()) else {
                            break;
                        };
                        let result = crate::probe::diagnose(&profile, &monitor_cancel).await;
                        // Do not overwrite a newer upstream's health with an old in-flight probe.
                        let same = upstream_ref.read().is_ok_and(|p| {
                            serde_json::to_value(&*p).ok() == serde_json::to_value(&profile).ok()
                        });
                        if same && let Ok(mut h) = health_ref.lock() {
                            *h = result;
                        }
                    }
                });
                self.gateway = Some(Gateway {
                    monitor,
                    health,
                    cancel,
                    task,
                    port: *port,
                    upstream,
                    view: RuntimeItem {
                        id: "gateway".into(),
                        label: format!("稳定入口 127.0.0.1:{port}"),
                        status: "healthy".into(),
                        detail: format!(
                            "上游 {} 已通过启动检查；运行中可使用 Profile 再次检测",
                            profile.label
                        ),
                        started_at: now(),
                    },
                });
                Ok("网关已监听 loopback，上游已通过 HTTPS 检查。".into())
            }
            Request::GatewayStop => {
                if let Some(mut g) = self.gateway.take() {
                    g.cancel.cancel();
                    let _ = (&mut g.task).await;
                }
                Ok("已请求关闭网关和所有转发连接。".into())
            }
            Request::TunnelStop { id } => {
                if let Some(mut t) = self.tunnels.remove(id) {
                    t.stop_group();
                    let _ = t.child.kill().await;
                    let _ = t.child.wait().await;
                }
                Ok("本应用持有的 SSH 子进程已停止。".into())
            }
            Request::TunnelStart {
                id,
                alias,
                direction,
                listen_port,
                target_host,
                target_port,
                reuse_config,
            } => {
                if self
                    .tunnels
                    .get_mut(id)
                    .is_some_and(|t| t.child.try_wait().ok().flatten().is_none())
                {
                    return Err("此隧道已经启动，请先停止".into());
                }
                if self.tunnels.len() >= 32 && !self.tunnels.contains_key(id) {
                    return Err("隧道数量已达上限".into());
                }
                if !*reuse_config && direction == "local" {
                    let listener = TcpListener::bind(("127.0.0.1", *listen_port))
                        .await
                        .map_err(|_| "本地监听端口已被占用")?;
                    drop(listener);
                }
                let file = p.file.take().ok_or("预览配置不可用")?;
                if !*reuse_config && direction == "remote" {
                    tokio::time::timeout(
                        Duration::from_secs(3),
                        tokio::net::TcpStream::connect((target_host.as_str(), *target_port)),
                    )
                    .await
                    .map_err(|_| "本地转发目标连接超时")?
                    .map_err(|_| "本地转发目标不可达，请先启动本地代理或服务")?;
                }
                let mut argv = ssh_args(file.path(), alias);
                argv.pop();
                argv.push("-N".into());
                if !*reuse_config {
                    argv.push(if direction == "remote" { "-R" } else { "-L" }.into());
                    let host = if target_host.contains(':') {
                        format!("[{target_host}]")
                    } else {
                        target_host.clone()
                    };
                    argv.push(format!("127.0.0.1:{listen_port}:{host}:{target_port}"));
                }
                argv.push(alias.clone());
                let mut tunnel = spawn_ssh(file, &argv, id, &p.plan.title)?;
                let ready = wait_ready(&mut tunnel, true).await;
                if let Err(e) = ready {
                    tunnel.stop_group();
                    let _ = tunnel.child.kill().await;
                    return Err(e);
                }
                tunnel.view.status = "healthy".into();
                tunnel.view.detail =
                    "SSH 已认证，转发初始化完成。远端应用出口仍需单独验证。".into();
                self.tunnels.insert(id.clone(), tunnel);
                Ok("隧道已建立；下一步验证远端代理出口。".into())
            }
            Request::SshAuth { alias } => {
                let file = p.file.take().ok_or("预览配置不可用")?;
                let mut argv = ssh_args(file.path(), alias);
                argv.pop();
                argv.extend(args(&["-N", "-o", "ClearAllForwardings=yes", alias]));
                let mut tunnel = spawn_ssh(file, &argv, "auth", "SSH 认证")?;
                let result = wait_ready(&mut tunnel, false).await;
                tunnel.stop_group();
                let _ = tunnel.child.kill().await;
                let _ = tunnel.child.wait().await;
                result?;
                Ok("SSH 认证成功；检查会话已关闭。".into())
            }
            Request::RemoteCheck { alias, port, url } => {
                let file = p.file.take().ok_or("预览配置不可用")?;
                let mut argv = ssh_args(file.path(), alias);
                argv.pop();
                argv.extend(args(&["-o", "ClearAllForwardings=yes", alias]));
                let quoted = format!("'{}'", url.replace('\'', "'\\''"));
                argv.push(format!("curl --silent --show-error --fail --head --connect-timeout 4 --max-time 8 --noproxy '' --proxy http://127.0.0.1:{port} -- {quoted}"));
                let out = run("/usr/bin/ssh", &argv).await?;
                Ok(format!(
                    "远端代理出口验证通过：{}",
                    safety::redact(out.lines().next().unwrap_or("curl 成功"))
                ))
            }
            _ => Err("操作缺少执行计划".into()),
        }
    }
    async fn recover(&mut self, id: &str, c: &mut Change, error: &str) -> String {
        let _ = apply(c, &c.undo).await;
        match read_change(c).await {
            Ok(current) if current == c.before => {
                self.undos.remove(id);
                format!("{error}；已恢复并验证操作前设置。")
            }
            Ok(current) => {
                c.expected = Some(current);
                self.undos.insert(id.into(), vec![c.clone()]);
                format!("{error}；自动恢复未完成，当前状态已保存，可在操作记录中重新预览撤销。")
            }
            Err(_) => format!(
                "{error}；无法验证恢复结果，请在系统 / Tailscale 客户端核对，操作前快照仍保留。"
            ),
        }
    }
    pub async fn shutdown(&mut self) {
        if let Some(mut g) = self.gateway.take() {
            g.cancel.cancel();
            let _ = (&mut g.task).await;
        }
        for (_, mut tunnel) in std::mem::take(&mut self.tunnels) {
            tunnel.stop_group();
            let _ = tunnel.child.kill().await;
            let _ = tunnel.child.wait().await;
        }
    }
}
// Persisted rollback data is data, not an executable command allow-list.
fn validate_change(c: &Change) -> Result<(), String> {
    if c.exe == "/usr/sbin/networksetup" {
        if c.read.len() != 2 {
            return Err("恢复快照无效".into());
        }
        let protocol = c.read[0].strip_prefix("-get").ok_or("恢复快照无效")?;
        if !["webproxy", "securewebproxy", "socksfirewallproxy"].contains(&protocol)
            || c.read[1].len() > 200
            || c.read[1].chars().any(char::is_control)
        {
            return Err("恢复快照无效".into());
        }
        for command in [&c.after, &c.undo] {
            for group in command.split(|s| s == "\nSTATE\n") {
                if group.is_empty() {
                    continue;
                }
                if group.len() < 3 || group[1] != c.read[1] {
                    return Err("恢复快照无效".into());
                }
                if group[0] == format!("-set{protocol}state") {
                    if group.len() != 3 || !["on", "off"].contains(&group[2].as_str()) {
                        return Err("恢复快照无效".into());
                    }
                } else if group[0] == format!("-set{protocol}") {
                    if group.len() != 4
                        || !safety::valid_host(&group[2])
                        || group[3].parse::<u16>().is_err()
                    {
                        return Err("恢复快照无效".into());
                    }
                } else {
                    return Err("恢复快照命令无效".into());
                }
            }
        }
    } else if Some(c.exe.clone()) == discovery::tailscale_executable()
        && c.read == args(&["debug", "prefs"])
    {
        let key = c.before.split('=').next().unwrap_or("");
        for command in [&c.after, &c.undo] {
            let valid = match key {
                "WantRunning" => {
                    *command == args(&["up", "--timeout=8s"]) || *command == args(&["down"])
                }
                "RouteAll" => {
                    *command == args(&["set", "--accept-routes=true"])
                        || *command == args(&["set", "--accept-routes=false"])
                }
                "ExitNodeIP" => {
                    command.len() == 2
                        && command[0] == "set"
                        && command[1]
                            .strip_prefix("--exit-node=")
                            .is_some_and(|v| v.is_empty() || v.parse::<std::net::IpAddr>().is_ok())
                }
                _ => false,
            };
            if !valid {
                return Err("Tailscale 恢复快照无效".into());
            }
        }
    } else {
        return Err("恢复快照执行程序不在允许范围".into());
    }
    Ok(())
}
async fn read_change(c: &Change) -> Result<String, String> {
    validate_change(c)?;
    let raw = run(&c.exe, &c.read).await?;
    if c.read == args(&["debug", "prefs"]) {
        let key = c.before.split('=').next().ok_or("状态键无效")?;
        let v: serde_json::Value = serde_json::from_str(&raw).map_err(|_| "状态解析失败")?;
        let value = if let Some(b) = v[key].as_bool() {
            b.to_string()
        } else {
            v[key].as_str().unwrap_or("").to_string()
        };
        Ok(format!("{key}={value}"))
    } else {
        Ok(raw)
    }
}
async fn apply(c: &Change, argv: &[String]) -> Result<(), String> {
    validate_change(c)?;
    for group in argv.split(|s| s == "\nSTATE\n") {
        if !group.is_empty() {
            run(&c.exe, group).await?;
        }
    }
    Ok(())
}
fn spawn_ssh(
    file: tempfile::NamedTempFile,
    argv: &[String],
    id: &str,
    label: &str,
) -> Result<Tunnel, String> {
    let mut child = tokio::process::Command::new("/usr/bin/ssh")
        .args(argv)
        .process_group(0)
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "无法启动 SSH")?;
    let stderr = child.stderr.take().ok_or("SSH 输出不可用")?;
    let log = Arc::new(Mutex::new(String::new()));
    let authenticated = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let l = log.clone();
    let a = authenticated.clone();
    let reader = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr.take(256 * 1024)).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.contains("Authenticated to ") {
                a.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            let message = if line.contains("remote port forwarding failed") {
                Some("远端监听端口被占用，或与 Config 转发重复。")
            } else if line.contains("Permission denied") {
                Some("SSH 认证被拒绝；检查 ssh-agent 与目标授权密钥。")
            } else if line.contains("Host key verification failed") {
                Some("主机密钥未验证或已变化；请先在终端核验主机指纹。")
            } else if line.contains("Address already in use") {
                Some("本地监听端口已被占用。")
            } else if line.contains("Entering interactive session")
                || line.contains("pledge: network")
            {
                Some("forward-ready")
            } else {
                None
            };
            if let Some(message) = message
                && let Ok(mut text) = l.lock()
            {
                *text = message.into();
            }
        }
    });
    Ok(Tunnel {
        group: child.id().map(|id| id as i32),
        child,
        _file: file,
        log,
        authenticated,
        reader,
        view: RuntimeItem {
            id: id.into(),
            label: label.into(),
            status: "checking".into(),
            detail: "SSH 启动中".into(),
            started_at: now(),
        },
    })
}
async fn wait_ready(t: &mut Tunnel, forward: bool) -> Result<(), String> {
    let start = Instant::now();
    loop {
        if let Some(status) = t.child.try_wait().map_err(|_| "无法读取 SSH 状态")? {
            return Err(format!(
                "SSH 已退出 {status}：{}",
                t.log.lock().map(|s| s.clone()).unwrap_or_default()
            ));
        }
        let auth = t.authenticated.load(std::sync::atomic::Ordering::SeqCst);
        let log = t.log.lock().map(|s| s.clone()).unwrap_or_default();
        if auth && (!forward || log == "forward-ready") {
            return Ok(());
        }
        if start.elapsed() > Duration::from_secs(12) {
            return Err(format!("SSH 未在期限内确认建立：{log}"));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn forwarding_scope() {
        assert!(validate_forward("127.0.0.1:10073 localhost:7892"));
        assert!(!validate_forward("*:10073 localhost:7892"));
        assert!(!validate_forward("/tmp/sock localhost:7892"));
    }
    #[test]
    fn rejects_credential_proxy() {
        assert!(
            proxy_restore(
                "webproxy",
                "Wi-Fi",
                "Enabled: Yes\nServer: 127.0.0.1\nPort: 7892\nAuthenticated Proxy Enabled: 1"
            )
            .is_err()
        );
    }
    #[tokio::test]
    async fn confirmation_is_one_use() {
        let mut c = Controller::default();
        let p = c.preview(Request::GatewayStop).await.unwrap();
        assert!(c.execute(&p.id).await.unwrap().success);
        assert!(c.execute(&p.id).await.is_err());
    }
    #[tokio::test]
    async fn expired_preview_cannot_execute() {
        let mut c = Controller::default();
        let p = c.preview(Request::GatewayStop).await.unwrap();
        c.pending.get_mut(&p.id).unwrap().at = Instant::now() - Duration::from_secs(301);
        assert!(c.execute(&p.id).await.unwrap_err().contains("过期"));
        assert!(c.receipts().is_empty());
    }
    #[test]
    fn persisted_commands_are_not_trusted() {
        let mut c = Change {
            exe: "/bin/sh".into(),
            read: args(&["-c", "echo bad"]),
            before: String::new(),
            after: vec![],
            undo: vec![],
            expected: None,
        };
        assert!(validate_change(&c).is_err());
        c.exe = "/usr/sbin/networksetup".into();
        c.read = args(&["-getwebproxy", "Wi-Fi"]);
        c.after = args(&["-setwebproxystate", "Wi-Fi", "on"]);
        c.undo = args(&["-setwebproxystate", "Wi-Fi", "off"]);
        assert!(validate_change(&c).is_ok());
        c.undo = args(&["-setdnsservers", "Wi-Fi", "1.1.1.1"]);
        assert!(validate_change(&c).is_err());
    }
    #[tokio::test]
    async fn discarded_preview_cannot_execute() {
        let mut c = Controller::default();
        let p = c.preview(Request::GatewayStop).await.unwrap();
        c.discard(std::slice::from_ref(&p.id));
        assert!(c.execute(&p.id).await.is_err());
        assert!(c.receipts().is_empty());
    }
}
