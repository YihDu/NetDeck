use crate::{
    command::{Failure, run},
    discovery::{failure, parse_route, tailscale_executable},
    model::*,
    safety::{contains_ip, validate_profile, validate_url},
    ssh,
};
use std::{
    net::SocketAddr,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpStream, lookup_host},
};
use tokio_util::sync::CancellationToken;

async fn bounded<T>(
    cancel: &CancellationToken,
    future: impl std::future::Future<Output = Result<T, Failure>>,
) -> Result<T, Failure> {
    tokio::select! { biased; _=cancel.cancelled()=>Err(Failure::new("cancelled","检测已取消")), r=tokio::time::timeout(Duration::from_secs(6),future)=>r.unwrap_or_else(|_|Err(Failure::new("timeout","探测超过 6 秒"))) }
}
fn io_error(e: std::io::Error) -> Failure {
    Failure::new(
        match e.kind() {
            std::io::ErrorKind::ConnectionRefused => "connection-refused",
            std::io::ErrorKind::PermissionDenied => "permission-denied",
            std::io::ErrorKind::TimedOut => "timeout",
            _ => "network-error",
        },
        "网络连接失败；请检查服务监听、路由及防火墙",
    )
}
async fn connect(addresses: &[SocketAddr]) -> Result<TcpStream, Failure> {
    let mut last = Failure::new("no-address", "没有可用 IP 地址");
    for addr in addresses.iter().take(4) {
        match tokio::time::timeout(Duration::from_millis(1200), TcpStream::connect(addr)).await {
            Ok(Ok(s)) => return Ok(s),
            Ok(Err(e)) => last = io_error(e),
            Err(_) => last = Failure::new("timeout", "TCP 连接超时"),
        }
    }
    Err(last)
}
pub async fn http_handshake(
    stream: &mut TcpStream,
    host: &str,
    port: u16,
) -> Result<String, Failure> {
    let authority = if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    stream
        .write_all(format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n\r\n").as_bytes())
        .await
        .map_err(io_error)?;
    let mut data = vec![];
    while data.len() < 8192 {
        let b = stream.read_u8().await.map_err(io_error)?;
        data.push(b);
        if data.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    if !data.ends_with(b"\r\n\r\n") {
        return Err(Failure::new("proxy-header-limit", "代理响应头过大或不完整"));
    }
    let text = String::from_utf8_lossy(&data);
    let line = text.lines().next().unwrap_or("");
    let parts: Vec<_> = line.split_whitespace().collect();
    if parts.len() < 2 || !parts[0].starts_with("HTTP/") {
        return Err(Failure::new(
            "proxy-protocol",
            "服务未返回 HTTP CONNECT 响应",
        ));
    }
    let code = parts[1].parse::<u16>().unwrap_or(0);
    if (200..300).contains(&code) {
        Ok(format!("HTTP CONNECT {code}"))
    } else {
        Err(Failure::new(
            if code == 407 {
                "proxy-auth-required"
            } else {
                "proxy-rejected"
            },
            format!("HTTP CONNECT 返回 {code}；端口开放不代表代理可用"),
        ))
    }
}
pub async fn socks_handshake(
    stream: &mut TcpStream,
    host: &str,
    port: u16,
) -> Result<String, Failure> {
    stream.write_all(&[5, 1, 0]).await.map_err(io_error)?;
    let mut greeting = [0; 2];
    stream.read_exact(&mut greeting).await.map_err(io_error)?;
    if greeting != [5, 0] {
        return Err(Failure::new(
            "socks-auth-or-protocol",
            "SOCKS5 不支持无认证握手，或此端口协议不符",
        ));
    }
    if host.len() > 255 {
        return Err(Failure::new("invalid-target", "SOCKS 目标域名过长"));
    }
    let mut request = vec![5, 1, 0, 3, host.len() as u8];
    request.extend_from_slice(host.as_bytes());
    request.extend_from_slice(&port.to_be_bytes());
    stream.write_all(&request).await.map_err(io_error)?;
    let mut reply = [0; 4];
    stream.read_exact(&mut reply).await.map_err(io_error)?;
    if reply[0] != 5 || reply[1] != 0 || reply[2] != 0 {
        return Err(Failure::new(
            "socks-rejected",
            format!("SOCKS5 CONNECT 被拒绝（code {}）", reply[1]),
        ));
    }
    let len = match reply[3] {
        1 => 4,
        4 => 16,
        3 => stream.read_u8().await.map_err(io_error)? as usize,
        _ => return Err(Failure::new("socks-protocol", "SOCKS5 响应地址类型无效")),
    };
    let mut rest = vec![0; len + 2];
    stream.read_exact(&mut rest).await.map_err(io_error)?;
    Ok("SOCKS5 无认证协商与 CONNECT 成功".into())
}
async fn https(p: &Profile) -> Result<String, Failure> {
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(6));
    if matches!(p.kind, ProfileKind::HttpProxy | ProfileKind::Socks5Proxy) {
        let host = if p.host.contains(':') {
            format!("[{}]", p.host)
        } else {
            p.host.clone()
        };
        let scheme = if p.kind == ProfileKind::Socks5Proxy {
            "socks5h"
        } else {
            "http"
        };
        let proxy = reqwest::Proxy::all(format!("{scheme}://{host}:{}", p.port))
            .map_err(|_| Failure::new("invalid-proxy", "代理地址无效"))?;
        builder = builder.proxy(proxy);
    }
    let client = builder
        .build()
        .map_err(|_| Failure::new("tls-config", "无法初始化 TLS 客户端"))?;
    let response = client.get(&p.test_url).send().await.map_err(|e| {
        Failure::new(
            if e.is_timeout() {
                "timeout"
            } else if e.is_connect() {
                "tls-or-connect"
            } else {
                "https-error"
            },
            "HTTPS 请求失败（代理、TLS 或连接层）；未携带凭据，未跳过证书验证",
        )
    })?;
    let status = response.status();
    if status.is_success() || status.is_redirection() {
        Ok(format!(
            "TLS 验证成功 · HTTP {}{}",
            status.as_u16(),
            if status.is_redirection() {
                "（不跟随重定向）"
            } else {
                ""
            }
        ))
    } else {
        Err(Failure::new(
            "http-status",
            format!(
                "TLS 成功，但服务返回 HTTP {}；不判定业务健康",
                status.as_u16()
            ),
        ))
    }
}
pub fn parse_tailscale_ping(text: &str) -> Result<String, Failure> {
    let text = text.to_ascii_lowercase();
    let line = text
        .lines()
        .rfind(|l| l.contains("pong from"))
        .ok_or_else(|| Failure::new("parse-error", "ping 未返回可识别的 pong 证据"))?;
    if line.contains("derp(") || line.contains("peer-relay") {
        Ok("Tailscale 已连通 · relay 中继".into())
    } else if line.contains(" via ") {
        Ok("Tailscale 已连通 · direct 直连".into())
    } else {
        Err(Failure::new(
            "parse-error",
            "收到 pong，但无法识别 direct / relay 路径",
        ))
    }
}

fn step_result(check: &str, r: Result<String, Failure>, start: Instant) -> Evidence {
    let mut e = match r {
        Ok(s) => Evidence::new(check, Health::Healthy, s, "来自本次实际探测"),
        Err(f) => {
            let code = f.code.clone();
            let mut e = failure(check, f);
            if !["cancelled", "permission-denied", "not-installed"].contains(&code.as_str()) {
                e.status = Health::Down;
            }
            e
        }
    };
    e.latency_ms = start.elapsed().as_millis() as u64;
    e
}
fn finish(p: &Profile, started_at: String, steps: Vec<Evidence>, cancelled: bool) -> Diagnostic {
    let status = if cancelled {
        Health::Unknown
    } else if steps.iter().any(|s| s.status == Health::Down) {
        Health::Down
    } else if steps
        .iter()
        .any(|s| s.status == Health::Degraded || s.status == Health::Unknown)
    {
        Health::Degraded
    } else {
        Health::Healthy
    };
    Diagnostic {
        profile_id: p.id.clone(),
        label: p.label.clone(),
        status,
        started_at,
        finished_at: now(),
        cancelled,
        steps,
    }
}
pub async fn diagnose(p: &Profile, cancel: &CancellationToken) -> Diagnostic {
    let started_at = now();
    let mut steps = vec![];
    if let Err(e) = validate_profile(p) {
        steps.push(failure("configured", Failure::new("invalid-profile", e)));
        return finish(p, started_at, steps, false);
    }
    if !p.enabled {
        steps.push(Evidence::new(
            "configured",
            Health::NotConfigured,
            "Profile 未启用",
            "启用后才会发起主动网络请求",
        ));
        return Diagnostic {
            profile_id: p.id.clone(),
            label: p.label.clone(),
            status: Health::NotConfigured,
            started_at,
            finished_at: now(),
            cancelled: false,
            steps,
        };
    }
    let mut configured = Evidence::new(
        "configured",
        Health::Healthy,
        "配置已确认",
        "探测只针对这个 Profile 的目标",
    );
    configured.source = Source::Configured;
    steps.push(configured);
    let mut host = p.host.clone();
    let mut port = p.port;
    if p.kind == ProfileKind::Ssh {
        match ssh::effective(&p.ssh_alias, cancel).await {
            Ok(c) => {
                let mut e = Evidence::new(
                    "ssh-config",
                    if c.duplicate_ports.is_empty() {
                        Health::Healthy
                    } else {
                        Health::Degraded
                    },
                    format!(
                        "{}:{} · {} 条远端转发",
                        c.hostname,
                        c.port,
                        c.remote_forwards.len()
                    ),
                    serde_json::to_string_pretty(&c).unwrap_or_default(),
                );
                e.source = Source::Configured;
                steps.push(e);
                if !c.remote_forwards.is_empty() {
                    let mut e = Evidence::new(
                        "forwarding",
                        Health::Degraded,
                        "配置中已有 RemoteForward",
                        "再次添加同一远端监听端口可能冲突；本地配置无法确认远端端口占用，尚未启动隧道",
                    );
                    e.source = Source::Configured;
                    steps.push(e);
                }
                if c.proxy_command || c.proxy_jump.is_some() {
                    steps.push(Evidence::new("tcp",Health::Unknown,"该 SSH 别名依赖 ProxyCommand / ProxyJump","首版不会执行外部代理命令或登录跳板；请单独添加代理/跳板 Profile 诊断。直连目标的结果不能代表这条 SSH 路径"));
                    return finish(p, started_at, steps, cancel.is_cancelled());
                }
                host = c.hostname;
                port = c.port;
            }
            Err(e) => {
                steps.push(failure("ssh-config", e));
                return finish(p, started_at, steps, cancel.is_cancelled());
            }
        }
    }
    if p.kind == ProfileKind::Https
        && let Ok(u) = validate_url(&p.test_url)
    {
        host = u.host_str().unwrap_or("").trim_matches(['[', ']']).into();
        port = u.port_or_known_default().unwrap_or(443);
    }
    if p.kind == ProfileKind::Tailscale {
        let start = Instant::now();
        let result = if let Some(exe) = tailscale_executable() {
            match run(
                &exe,
                &["ping", "--c", "2", "--timeout", "3s", &host],
                7,
                cancel,
            )
            .await
            {
                Ok(o) if o.code == 0 => parse_tailscale_ping(&o.stdout),
                Ok(_) => Err(Failure::new(
                    "peer-unreachable",
                    "Tailscale ping 失败；此结果与代理服务状态独立",
                )),
                Err(e) => Err(e),
            }
        } else {
            Err(Failure::new("not-installed", "未找到 Tailscale CLI"))
        };
        steps.push(step_result("tailscale-ping", result, start));
        return finish(p, started_at, steps, cancel.is_cancelled());
    }
    let start = Instant::now();
    let addresses = bounded(cancel, async {
        lookup_host((host.as_str(), port))
            .await
            .map(|v| v.take(8).collect::<Vec<_>>())
            .map_err(|_| Failure::new("dns-failed", "DNS 解析失败"))
    })
    .await;
    let addresses = match addresses {
        Ok(a) if !a.is_empty() => {
            steps.push(step_result(
                "dns",
                Ok(format!("解析到 {} 个地址", a.len())),
                start,
            ));
            a
        }
        Ok(_) => {
            steps.push(failure("dns", Failure::new("dns-empty", "DNS 未返回地址")));
            return finish(p, started_at, steps, cancel.is_cancelled());
        }
        Err(e) => {
            steps.push(step_result("dns", Err(e), start));
            return finish(p, started_at, steps, cancel.is_cancelled());
        }
    };
    if !p.expected_cidr.is_empty() {
        let matches = addresses
            .iter()
            .any(|a| contains_ip(&p.expected_cidr, &a.ip().to_string()).unwrap_or(false));
        let mut e = Evidence::new(
            "cidr",
            if matches {
                Health::Healthy
            } else {
                Health::Degraded
            },
            if matches {
                "目标属于预期子网"
            } else {
                "目标不在预期子网范围"
            },
            format!("{}；网段归属不代表路由已下发或被系统采用", p.expected_cidr),
        );
        e.source = Source::Configured;
        steps.push(e);
    }
    let target_ip = addresses[0].ip().to_string();
    match run("/sbin/route", &["-n", "get", &target_ip], 3, cancel).await {
        Ok(o) if o.code == 0 => {
            let route = parse_route(&o.stdout);
            let interface = route
                .get("interface")
                .map(String::as_str)
                .unwrap_or("unknown");
            let mut e = Evidence::new(
                "route",
                Health::Healthy,
                format!("首个解析地址经 {interface}"),
                format!(
                    "{target_ip} · {}；utun 本身不能证明由 Tailscale 承载",
                    serde_json::to_string(&route).unwrap_or_default()
                ),
            );
            e.latency_ms = o.ms;
            steps.push(e);
        }
        Ok(_) => steps.push(failure(
            "route",
            Failure::new("route-unavailable", "无法读取目标路由"),
        )),
        Err(e) => steps.push(failure("route", e)),
    }
    let start = Instant::now();
    let stream = bounded(cancel, connect(&addresses)).await;
    let mut stream = match stream {
        Ok(s) => {
            let peer = s.peer_addr().map(|a| a.to_string()).unwrap_or_default();
            steps.push(step_result("tcp", Ok(format!("TCP 已连接 {peer}")), start));
            s
        }
        Err(e) => {
            steps.push(step_result("tcp", Err(e), start));
            return finish(p, started_at, steps, cancel.is_cancelled());
        }
    };
    if matches!(p.kind, ProfileKind::HttpProxy | ProfileKind::Socks5Proxy) {
        if p.test_url.is_empty() {
            steps.push(Evidence::new(
                "proxy",
                Health::Unknown,
                "缺少 HTTPS 测试地址",
                "TCP 开放仅说明端口可连接；添加测试地址后检测握手及出口",
            ));
            return finish(p, started_at, steps, cancel.is_cancelled());
        }
        let u = validate_url(&p.test_url).unwrap();
        let h = u.host_str().unwrap().trim_matches(['[', ']']);
        let port = u.port_or_known_default().unwrap_or(443);
        let start = Instant::now();
        let result = if p.kind == ProfileKind::HttpProxy {
            bounded(cancel, http_handshake(&mut stream, h, port)).await
        } else {
            bounded(cancel, socks_handshake(&mut stream, h, port)).await
        };
        let success = result.is_ok();
        steps.push(step_result("proxy-handshake", result, start));
        if !success {
            // Listening but unusable proxy is explicitly partial availability.
            let mut d = finish(p, started_at, steps, cancel.is_cancelled());
            if !d.cancelled {
                d.status = Health::Degraded;
            }
            return d;
        }
    }
    drop(stream);
    if matches!(
        p.kind,
        ProfileKind::HttpProxy | ProfileKind::Socks5Proxy | ProfileKind::Https
    ) {
        let start = Instant::now();
        steps.push(step_result("https", bounded(cancel, https(p)).await, start));
    } else if p.kind == ProfileKind::Ssh {
        steps.push(Evidence::new(
            "ssh-auth",
            Health::Unknown,
            "SSH 认证与远端应用：未检测",
            "本次只检查配置和 TCP；首版未实现认证检查入口，也不会建立隧道",
        ));
    }
    let mut d = finish(p, started_at, steps, cancel.is_cancelled());
    if matches!(p.kind, ProfileKind::HttpProxy | ProfileKind::Socks5Proxy)
        && d.status == Health::Down
        && !d.cancelled
    {
        d.status = Health::Degraded;
    }
    d
}

pub async fn diagnose_all(profiles: Vec<Profile>, cancel: CancellationToken) -> Vec<Diagnostic> {
    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(3));
    let mut jobs = tokio::task::JoinSet::new();
    for p in profiles.into_iter().filter(|p| p.enabled) {
        let c = cancel.clone();
        let sem = semaphore.clone();
        jobs.spawn(async move {
            let _permit = sem.acquire().await.unwrap();
            diagnose(&p, &c).await
        });
    }
    let mut results = vec![];
    while let Some(r) = jobs.join_next().await {
        if let Ok(r) = r {
            results.push(r);
        }
    }
    results.sort_by(|a, b| a.profile_id.cmp(&b.profile_id));
    results
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tailscale_path_requires_evidence() {
        assert!(
            parse_tailscale_ping("pong from win via DERP(hkg) in 30ms")
                .unwrap()
                .contains("relay")
        );
        assert!(
            parse_tailscale_ping("pong from win via 192.0.2.1:41641 in 3ms")
                .unwrap()
                .contains("direct")
        );
        assert!(parse_tailscale_ping("pong from win").is_err());
    }
    #[tokio::test]
    async fn listening_but_rejected_proxy_is_partial() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = [0; 512];
            assert!(s.read(&mut buf).await.unwrap() > 0);
            s.write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
                .await
                .unwrap();
        });
        let profile = Profile {
            id: "mock-proxy".into(),
            label: "Mock local test".into(),
            kind: ProfileKind::HttpProxy,
            enabled: true,
            source: Source::Configured,
            host: "127.0.0.1".into(),
            port,
            ssh_alias: String::new(),
            test_url: "https://example.com/".into(),
            expected_cidr: String::new(),
        };
        let result = diagnose(&profile, &CancellationToken::new()).await;
        assert_eq!(result.status, Health::Degraded);
        assert!(
            result
                .steps
                .iter()
                .any(|s| s.check == "tcp" && s.status == Health::Healthy)
        );
        assert!(
            result
                .steps
                .iter()
                .any(|s| s.error_code.as_deref() == Some("proxy-auth-required"))
        );
        assert!(!result.steps.iter().any(|s| s.check == "https"));
        server.await.unwrap();
    }
    #[tokio::test]
    async fn http_port_is_not_proxy_success() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = [0; 512];
            assert!(s.read(&mut buf).await.unwrap() > 0);
            s.write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
                .await
                .unwrap();
        });
        let mut s = TcpStream::connect(addr).await.unwrap();
        let e = http_handshake(&mut s, "example.com", 443)
            .await
            .unwrap_err();
        assert_eq!(e.code, "proxy-auth-required");
        server.await.unwrap();
    }
    #[tokio::test]
    async fn socks_connect_reply_is_checked() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = [0; 3];
            s.read_exact(&mut buf).await.unwrap();
            s.write_all(&[5, 0]).await.unwrap();
            let mut buf = [0; 256];
            assert!(s.read(&mut buf).await.unwrap() > 0);
            s.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]).await.unwrap();
        });
        let mut s = TcpStream::connect(addr).await.unwrap();
        assert_eq!(
            socks_handshake(&mut s, "example.com", 443)
                .await
                .unwrap_err()
                .code,
            "socks-rejected"
        );
        server.await.unwrap();
    }
    #[tokio::test]
    async fn cancel_interrupts_probe() {
        let c = CancellationToken::new();
        c.cancel();
        let e = bounded::<()>(&c, async {
            tokio::time::sleep(Duration::from_secs(30)).await;
            Ok(())
        })
        .await
        .unwrap_err();
        assert_eq!(e.code, "cancelled");
    }
}
