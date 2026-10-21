use crate::{
    command::{Failure, Output, run},
    model::*,
    safety::redact,
    ssh,
};
use std::{collections::BTreeMap, path::Path};
use tokio_util::sync::CancellationToken;

pub fn parse_route(text: &str) -> BTreeMap<String, String> {
    text.lines()
        .filter_map(|line| {
            let (k, v) = line.trim().split_once(':')?;
            ["destination", "gateway", "interface", "mask", "flags"]
                .contains(&k)
                .then(|| (k.into(), redact(v.trim())))
        })
        .collect()
}
pub fn parse_proxy(text: &str) -> Result<ProxySettings, Failure> {
    if !text.contains("<dictionary>") {
        return Err(Failure::new("parse-error", "无法识别系统代理输出"));
    }
    let mut values = BTreeMap::new();
    let mut bypass = vec![];
    let mut in_bypass = false;
    for line in text.lines() {
        let s = line.trim();
        if s.starts_with("ExceptionsList") {
            in_bypass = true;
            continue;
        }
        if in_bypass && s == "}" {
            in_bypass = false;
            continue;
        }
        if let Some((k, v)) = s.split_once(" : ") {
            if in_bypass {
                bypass.push(redact(v));
            } else {
                values.insert(k, v);
            }
        }
    }
    let mut endpoints = vec![];
    for (prefix, protocol) in [("HTTP", "http"), ("HTTPS", "https"), ("SOCKS", "socks5")] {
        if let (Some(host), Some(port)) = (
            values.get(format!("{prefix}Proxy").as_str()),
            values.get(format!("{prefix}Port").as_str()),
        ) && let Ok(port) = port.parse()
        {
            endpoints.push(ProxyEndpoint {
                protocol: protocol.into(),
                host: redact(host),
                port,
                enabled: values.get(format!("{prefix}Enable").as_str()) == Some(&"1"),
            });
        }
    }
    Ok(ProxySettings {
        endpoints,
        pac_enabled: values.get("ProxyAutoConfigEnable") == Some(&"1"),
        pac_url: values.get("ProxyAutoConfigURLString").map(|s| redact(s)),
        bypass,
    })
}
pub fn parse_listeners(text: &str) -> Vec<Listener> {
    let mut process = String::new();
    let mut pid = 0;
    let mut rows = vec![];
    for line in text.lines() {
        if let Some(s) = line.strip_prefix('p') {
            pid = s.parse().unwrap_or(0);
        } else if let Some(s) = line.strip_prefix('c') {
            process = redact(s);
        } else if let Some(s) = line.strip_prefix('n') {
            rows.push(Listener {
                process: process.clone(),
                pid,
                address: redact(s),
            });
        }
        if rows.len() >= 128 {
            break;
        }
    }
    rows
}
fn strings(v: Option<&serde_json::Value>) -> Vec<String> {
    v.and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}
pub fn parse_tailscale(text: &str) -> Result<Tailscale, Failure> {
    let v: serde_json::Value = serde_json::from_str(text)
        .map_err(|_| Failure::new("parse-error", "Tailscale JSON 无法解析"))?;
    let state = v
        .get("BackendState")
        .and_then(|v| v.as_str())
        .ok_or_else(|| Failure::new("parse-error", "Tailscale 缺少 BackendState"))?
        .to_string();
    let peers = v
        .get("Peer")
        .and_then(|v| v.as_object())
        .map(|m| {
            m.values()
                .take(128)
                .map(|p| Peer {
                    name: p
                        .get("HostName")
                        .and_then(|v| v.as_str())
                        .unwrap_or("peer")
                        .into(),
                    ips: strings(p.get("TailscaleIPs")),
                    online: p.get("Online").and_then(|v| v.as_bool()).unwrap_or(false),
                    os: p
                        .get("OS")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown")
                        .into(),
                    routes: strings(p.get("PrimaryRoutes")),
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(Tailscale {
        state,
        self_ips: strings(v.get("TailscaleIPs")),
        peers,
        accept_routes: None,
        exit_node: v
            .pointer("/ExitNodeStatus/TailscaleIPs/0")
            .and_then(|v| v.as_str())
            .map(String::from),
    })
}
pub fn tailscale_executable() -> Option<String> {
    let mut paths = vec![];
    if let Some(path) = std::env::var_os("PATH") {
        for p in std::env::split_paths(&path) {
            if p.is_absolute() {
                paths.push(p.join("tailscale"));
            }
        }
    }
    paths.extend(
        [
            "/opt/homebrew/bin/tailscale",
            "/usr/local/bin/tailscale",
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        ]
        .iter()
        .map(Path::new)
        .map(Path::to_path_buf),
    );
    paths
        .into_iter()
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}
pub fn failure(check: &str, e: Failure) -> Evidence {
    let mut r = Evidence::new(check, Health::Unknown, e.message, "此项未获取有效证据");
    r.error_code = Some(e.code);
    r
}
fn command_evidence(check: &str, r: &Result<Output, Failure>) -> Evidence {
    match r {
        Ok(o) => {
            let mut e = Evidence::new(
                check,
                if o.code == 0 {
                    Health::Healthy
                } else {
                    Health::Unknown
                },
                if o.code == 0 {
                    "读取成功"
                } else {
                    "命令未返回有效结果"
                },
                format!("只读系统命令 · exit {}", o.code),
            );
            e.latency_ms = o.ms;
            if o.code != 0 {
                e.error_code = Some(
                    if o.stderr.to_lowercase().contains("permission") {
                        "permission-denied"
                    } else {
                        "command-failed"
                    }
                    .into(),
                );
            }
            e
        }
        Err(e) => failure(check, e.clone()),
    }
}
pub async fn snapshot(cancel: &CancellationToken) -> Snapshot {
    let (os, proxy, route, listeners) = tokio::join!(
        run("/usr/bin/sw_vers", &["-productVersion"], 3, cancel),
        run("/usr/sbin/scutil", &["--proxy"], 3, cancel),
        run("/sbin/route", &["-n", "get", "default"], 3, cancel),
        run(
            "/usr/sbin/lsof",
            &["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"],
            4,
            cancel
        )
    );
    let mut evidence = vec![
        command_evidence("system-proxy", &proxy),
        command_evidence("default-route", &route),
        command_evidence("listeners", &listeners),
    ];
    let system_proxy = match proxy {
        Ok(o) if o.code == 0 => match parse_proxy(&o.stdout) {
            Ok(p) => p,
            Err(e) => {
                evidence[0] = failure("system-proxy", e);
                ProxySettings::default()
            }
        },
        _ => ProxySettings::default(),
    };
    let default_route = route
        .ok()
        .filter(|o| o.code == 0)
        .map(|o| parse_route(&o.stdout))
        .unwrap_or_default();
    let listeners = listeners
        .ok()
        .filter(|o| o.code == 0)
        .map(|o| parse_listeners(&o.stdout))
        .unwrap_or_default();
    let shell_proxy = [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
    ]
    .into_iter()
    .filter_map(|k| std::env::var(k).ok().map(|v| (k.into(), redact(&v))))
    .collect();
    let tailscale = if let Some(exe) = tailscale_executable() {
        match run(&exe, &["status", "--json"], 5, cancel).await {
            Ok(o) if o.code == 0 => match parse_tailscale(&o.stdout) {
                Ok(mut t) => {
                    let status = if t.state == "Running" {
                        Health::Healthy
                    } else {
                        Health::Unknown
                    };
                    evidence.push(Evidence::new(
                        "tailscale",
                        status,
                        format!("Tailscale {}", t.state),
                        "设备列表 Online 是控制平面信息；逐目标 ping 后才能确认链路",
                    ));
                    // Read-only prefs feature, never execute set/up/down.
                    match run(&exe, &["debug", "prefs"], 3, cancel).await {
                        Ok(p) if p.code == 0 => {
                            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&p.stdout) {
                                t.accept_routes = v.get("RouteAll").and_then(|v| v.as_bool());
                            }
                        }
                        _ => {}
                    }
                    Some(t)
                }
                Err(e) => {
                    evidence.push(failure("tailscale", e));
                    None
                }
            },
            Ok(o) => {
                let lower = o.stderr.to_lowercase();
                let code = if lower.contains("permission") {
                    "permission-denied"
                } else if lower.contains("logged") || lower.contains("login") {
                    "not-authenticated"
                } else {
                    "service-unavailable"
                };
                evidence.push(failure(
                    "tailscale",
                    Failure::new(code, "Tailscale 未运行、未登录或不可访问"),
                ));
                None
            }
            Err(e) => {
                evidence.push(failure("tailscale", e));
                None
            }
        }
    } else {
        evidence.push(failure(
            "tailscale",
            Failure::new("not-installed", "未找到 Tailscale CLI"),
        ));
        None
    };
    let ssh_aliases = match ssh::aliases_with_warning() {
        Ok((v, has_exec)) => {
            let mut e = Evidence::new(
                "ssh-config",
                Health::Healthy,
                format!("发现 {} 个明确别名", v.len()),
                "仅列出配置；尚未连接。身份文件内容从不读取",
            );
            e.source = Source::Configured;
            if has_exec {
                e.status = Health::Degraded;
                e.error_code = Some("unsafe-ssh-config".into());
                e.summary = format!("发现 {} 个别名；Match exec 阻止安全求值", v.len());
                e.detail="已静态读取别名；未执行 Match exec 或 ssh -G。可使用独立 TCP Profile 检查目标端口。".into();
            }
            evidence.push(e);
            v
        }
        Err(e) => {
            evidence.push(failure("ssh-config", e));
            vec![]
        }
    };
    Snapshot {
        captured_at: now(),
        os_version: os
            .ok()
            .filter(|o| o.code == 0)
            .map(|o| o.stdout.trim().into())
            .unwrap_or_else(|| "Unavailable".into()),
        arch: std::env::consts::ARCH.into(),
        default_route,
        system_proxy,
        shell_proxy,
        listeners,
        tailscale,
        ssh_aliases,
        evidence,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn proxy_parser() {
        let p=parse_proxy("<dictionary> {\nHTTPEnable : 1\nHTTPProxy : 127.0.0.1\nHTTPPort : 7892\nExceptionsList : <array> {\n0 : localhost\n}\n}").unwrap();
        assert!(p.endpoints[0].enabled);
        assert_eq!(p.endpoints[0].port, 7892);
        assert_eq!(p.bypass, vec!["localhost"]);
        assert!(parse_proxy("oops").is_err());
    }
    #[test]
    fn tailscale_not_same_as_peer_probe() {
        let t=parse_tailscale(r#"{"BackendState":"NeedsLogin","Peer":{"x":{"HostName":"win","Online":true,"TailscaleIPs":["100.64.0.1"]}}}"#).unwrap();
        assert_eq!(t.state, "NeedsLogin");
        assert!(t.peers[0].online);
        assert!(t.accept_routes.is_none());
        assert!(parse_tailscale("{}").is_err());
    }
    #[test]
    fn listener_parser() {
        let l = parse_listeners("p123\ncproxy\nf4\nn127.0.0.1:7892\np456\ncssh\nn*:22\n");
        assert_eq!(l.len(), 2);
        assert_eq!(l[0].pid, 123);
        assert_eq!(l[1].process, "ssh");
    }
}
