use crate::{
    command::{Failure, run},
    model::SshConfig,
    safety::{redact, valid_alias, valid_host},
};
use std::{
    collections::BTreeSet,
    io::Write,
    path::{Path, PathBuf},
};
use tokio_util::sync::CancellationToken;

// Only configuration-looking include files are read; no identity/key files are opened.
fn flatten_inner(
    path: &Path,
    depth: usize,
    seen: &mut BTreeSet<PathBuf>,
    total: &mut usize,
    reject_exec: bool,
) -> Result<String, Failure> {
    if depth > 6 {
        return Err(Failure::new("unsafe-ssh-config", "SSH Include 嵌套过深"));
    }
    let real = path
        .canonicalize()
        .map_err(|_| Failure::new("ssh-config-unavailable", "SSH 配置文件不可读"))?;
    let filename = real.file_name().and_then(|s| s.to_str()).unwrap_or("");
    if !(filename == "config"
        || filename == "ssh_config"
        || filename.ends_with(".conf")
        || filename.ends_with(".config"))
    {
        return Err(Failure::new(
            "unsafe-ssh-include",
            "Include 文件须以 .conf/.config 命名，或名为 config；未读取其他文件",
        ));
    }
    if !seen.insert(real.clone()) {
        return Err(Failure::new(
            "unsafe-ssh-config",
            "SSH Include 存在循环或重复引用",
        ));
    }
    let meta = std::fs::metadata(&real)
        .map_err(|_| Failure::new("ssh-config-unavailable", "无法读取配置元信息"))?;
    if !meta.is_file() || meta.len() > 128 * 1024 || *total + meta.len() as usize > 256 * 1024 {
        return Err(Failure::new("ssh-config-limit", "SSH 配置超过安全读取限制"));
    }
    *total += meta.len() as usize;
    let text = std::fs::read_to_string(&real)
        .map_err(|_| Failure::new("ssh-config-unavailable", "SSH 配置不是可读取的文本"))?;
    let mut result = String::new();
    for line in text.lines() {
        let line_clean = line.trim();
        if line_clean.is_empty() || line_clean.starts_with('#') {
            continue;
        }
        let normalized = line_clean.replacen('=', " ", 1);
        let tokens = shell_words::split(&normalized).map_err(|_| {
            Failure::new("unsafe-ssh-config", "无法安全解析 SSH 配置引号；未执行 ssh")
        })?;
        let mut parts = tokens.iter().map(String::as_str);
        let key = parts.next().unwrap_or("").to_ascii_lowercase();
        if reject_exec
            && key == "match"
            && parts
                .clone()
                .any(|p| p.trim_start_matches('!').eq_ignore_ascii_case("exec"))
        {
            return Err(Failure::new(
                "unsafe-ssh-config",
                "发现 Match exec：为避免配置读取执行命令，已停止 SSH 求值",
            ));
        }
        if key == "include" {
            for pat in parts {
                if pat.contains(['\'', '"', '%', '$']) {
                    return Err(Failure::new(
                        "unsafe-ssh-include",
                        "带引号或变量的 Include 暂不支持安全展开",
                    ));
                }
                let home = dirs::home_dir()
                    .ok_or_else(|| Failure::new("ssh-config-unavailable", "用户目录不可用"))?;
                let base = if real.starts_with("/etc/ssh") || real.starts_with("/private/etc/ssh") {
                    PathBuf::from("/etc/ssh")
                } else {
                    home.join(".ssh")
                };
                let p = if let Some(rest) = pat.strip_prefix("~/") {
                    home.join(rest)
                } else if Path::new(pat).is_absolute() {
                    PathBuf::from(pat)
                } else {
                    base.join(pat)
                };
                let pattern = p
                    .to_str()
                    .ok_or_else(|| Failure::new("unsafe-ssh-include", "Include 路径无效"))?;
                let mut count = 0;
                for p in glob::glob(pattern)
                    .map_err(|_| Failure::new("unsafe-ssh-include", "Include 模式无效"))?
                {
                    count += 1;
                    if count > 32 {
                        return Err(Failure::new("ssh-config-limit", "Include 文件过多"));
                    }
                    let p =
                        p.map_err(|_| Failure::new("ssh-config-unavailable", "Include 不可读"))?;
                    result.push_str(&flatten_inner(&p, depth + 1, seen, total, reject_exec)?);
                }
            }
        } else {
            result.push_str(line);
            result.push('\n');
        }
    }
    Ok(result)
}
fn read_config(reject_exec: bool) -> Result<String, Failure> {
    let path = dirs::home_dir()
        .ok_or_else(|| Failure::new("ssh-config-unavailable", "用户目录不可用"))?
        .join(".ssh/config");
    let mut total = 0;
    let mut text = if path.exists() {
        flatten_inner(&path, 0, &mut BTreeSet::new(), &mut total, reject_exec)?
    } else {
        String::new()
    };
    let system = Path::new("/etc/ssh/ssh_config");
    if system.exists() {
        text.push_str("\nHost *\n");
        text.push_str(&flatten_inner(
            system,
            0,
            &mut BTreeSet::new(),
            &mut total,
            reject_exec,
        )?);
    }
    Ok(text)
}
fn safe_config() -> Result<String, Failure> {
    read_config(true)
}
pub fn aliases_with_warning() -> Result<(Vec<String>, bool), Failure> {
    let text = read_config(false)?;
    let has_exec = text.lines().any(|line| {
        let normalized = line.replacen('=', " ", 1);
        let tokens = shell_words::split(&normalized).unwrap_or_default();
        tokens
            .first()
            .is_some_and(|s| s.eq_ignore_ascii_case("match"))
            && tokens
                .iter()
                .skip(1)
                .any(|s| s.trim_start_matches('!').eq_ignore_ascii_case("exec"))
    });
    Ok((parse_aliases(&text), has_exec))
}
#[cfg(test)]
fn flatten(
    path: &Path,
    depth: usize,
    seen: &mut BTreeSet<PathBuf>,
    total: &mut usize,
) -> Result<String, Failure> {
    flatten_inner(path, depth, seen, total, true)
}
pub fn parse_aliases(text: &str) -> Vec<String> {
    let mut names = BTreeSet::new();
    for line in text.lines() {
        let normalized = line.replacen('=', " ", 1);
        let tokens = shell_words::split(&normalized).unwrap_or_default();
        let mut p = tokens.iter().map(String::as_str);
        if p.next().is_some_and(|x| x.eq_ignore_ascii_case("host")) {
            for s in p.take_while(|s| !s.starts_with('#')) {
                if valid_alias(s) {
                    names.insert(s.to_string());
                }
            }
        }
    }
    names.into_iter().collect()
}
pub async fn effective(alias: &str, cancel: &CancellationToken) -> Result<SshConfig, Failure> {
    if !valid_alias(alias) {
        return Err(Failure::new("invalid-alias", "SSH 别名无效"));
    }
    let config = safe_config()?;
    if !parse_aliases(&config).iter().any(|s| s == alias) {
        return Err(Failure::new(
            "alias-not-found",
            "请使用已发现的明确 SSH Host 别名；不接受通配符或任意主机",
        ));
    }
    let mut file =
        tempfile::NamedTempFile::new().map_err(|_| Failure::new("io", "无法创建临时配置"))?;
    file.write_all(config.as_bytes())
        .map_err(|_| Failure::new("io", "无法写入临时配置"))?;
    let path = file.path().to_string_lossy().into_owned();
    // -F excludes implicit config reads. User + system config and includes were safely flattened.
    let out = run("/usr/bin/ssh", &["-G", "-F", &path, alias], 5, cancel).await?;
    if out.code != 0 {
        return Err(Failure::new(
            "ssh-config-error",
            "ssh -G 无法解析配置；请在终端检查配置语法",
        ));
    }
    parse_effective(alias, &out.stdout)
}
pub fn forward_port(s: &str) -> Option<u16> {
    let bind = s.split_whitespace().next()?;
    bind.rsplit(':').next()?.parse::<u16>().ok()
}
pub fn parse_effective(alias: &str, text: &str) -> Result<SshConfig, Failure> {
    let mut c = SshConfig {
        alias: alias.into(),
        hostname: String::new(),
        port: 22,
        proxy_jump: None,
        proxy_command: false,
        local_forwards: vec![],
        remote_forwards: vec![],
        identity_count: 0,
        duplicate_ports: vec![],
    };
    for line in text.lines() {
        let Some((key, val)) = line.split_once(' ') else {
            continue;
        };
        let val = val.trim();
        match key {
            "hostname" => c.hostname = val.into(),
            "port" => {
                c.port = val
                    .parse()
                    .map_err(|_| Failure::new("parse-error", "SSH 端口无法解析"))?
            }
            "proxyjump" if val != "none" => {
                c.proxy_jump = Some(redact(val.split('@').next_back().unwrap_or(val)))
            }
            "proxycommand" if val != "none" => c.proxy_command = true,
            "localforward" => c.local_forwards.push(redact(val)),
            "remoteforward" => c.remote_forwards.push(redact(val)),
            "identityfile" => c.identity_count += 1,
            _ => {}
        }
    }
    if !valid_host(&c.hostname) || c.port == 0 {
        return Err(Failure::new("parse-error", "SSH HostName 或 Port 无效"));
    }
    let mut ports = BTreeSet::new();
    for f in &c.remote_forwards {
        if let Some(port) = forward_port(f)
            && !ports.insert(port)
        {
            c.duplicate_ports.push(port);
        }
    }
    Ok(c)
}
/// Freeze configuration for an explicitly confirmed session. Executable Match blocks are
/// disabled, and config-defined forwarding is stripped when a custom forward is selected.
pub fn session_config(alias: &str, reuse: bool) -> Result<(tempfile::NamedTempFile, bool), String> {
    if !valid_alias(alias) {
        return Err("SSH 别名无效".into());
    }
    let raw = read_config(false).map_err(|e| e.message)?;
    if !parse_aliases(&raw).iter().any(|s| s == alias) {
        return Err("SSH 别名未发现".into());
    }
    let (safe, skipped) = sanitize_session(&raw, reuse)?;
    let mut file = tempfile::NamedTempFile::new().map_err(|_| "无法创建会话配置")?;
    file.write_all(safe.as_bytes())
        .map_err(|_| "无法保存会话配置")?;
    Ok((file, skipped))
}

fn sanitize_session(raw: &str, reuse: bool) -> Result<(String, bool), String> {
    let mut safe = String::new();
    let mut skipped = false;
    for line in raw.lines() {
        let normalized = line.replacen('=', " ", 1);
        let tokens = shell_words::split(&normalized).map_err(|_| "SSH 配置语法无效")?;
        let key = tokens
            .first()
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();
        if key == "match"
            && tokens
                .iter()
                .skip(1)
                .any(|s| s.trim_start_matches('!').eq_ignore_ascii_case("exec"))
        {
            safe.push_str("Match host !*\n");
            skipped = true;
            continue;
        }
        if reuse && key == "dynamicforward" {
            return Err("沿用模式暂不支持 DynamicForward；请选择明确覆盖".into());
        }
        if !reuse && ["localforward", "remoteforward", "dynamicforward"].contains(&key.as_str()) {
            continue;
        }
        // Disallow local command / multiplexing inherited from the configuration.
        if [
            "localcommand",
            "permitlocalcommand",
            "controlmaster",
            "controlpath",
            "controlpersist",
            "forkafterauthentication",
            "sessiontype",
            "remotecommand",
            "requesttty",
        ]
        .contains(&key.as_str())
        {
            continue;
        }
        safe.push_str(line);
        safe.push('\n');
    }
    Ok((safe, skipped))
}

#[cfg(test)]
mod session_tests {
    use super::*;
    #[tokio::test]
    async fn frozen_config_disables_exec_and_removes_original_forwards() {
        let raw = "Host test\n HostName example.com\n RemoteForward 10073 localhost:7892\n LocalCommand touch /tmp/never-netdeck\nMatch exec \"false\"\n HostName dangerous.invalid\nHost other\n HostName other.invalid\n";
        let (safe, skipped) = sanitize_session(raw, false).unwrap();
        assert!(skipped);
        assert!(!safe.contains("exec"));
        assert!(!safe.contains("RemoteForward"));
        assert!(!safe.contains("LocalCommand"));
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(safe.as_bytes()).unwrap();
        let output = run(
            "/usr/bin/ssh",
            &["-G", "-F", file.path().to_str().unwrap(), "test"],
            3,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(output.code, 0);
        assert!(output.stdout.contains("hostname example.com"));
        assert!(!output.stdout.contains("dangerous.invalid"));
    }
    #[test]
    fn reuse_keeps_one_forward() {
        let (text, _) =
            sanitize_session("Host test\nRemoteForward 10073 localhost:7892", true).unwrap();
        assert_eq!(text.matches("RemoteForward").count(), 1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn aliases_exclude_patterns() {
        assert_eq!(
            parse_aliases("Host * !bad foo bar\nHost x?\nHost=ok"),
            vec!["bar", "foo", "ok"]
        );
    }
    #[test]
    fn forwards_and_proxy() {
        let c=parse_effective("cci","hostname example.com\nport 2202\nproxycommand sh -c SECRET\nidentityfile /secret/path\nremoteforward 10073 localhost:7892\nremoteforward [::1]:10073 localhost:7893").unwrap();
        assert_eq!(c.duplicate_ports, vec![10073]);
        assert!(c.proxy_command);
        let json = serde_json::to_string(&c).unwrap();
        assert!(!json.contains("SECRET"));
        assert!(!json.contains("/secret/path"));
    }
    #[test]
    fn match_exec_rejected_before_ssh() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("config");
        std::fs::write(
            &p,
            "Host safe\n HostName example.com\nMatch !exec \"touch /tmp/never\"",
        )
        .unwrap();
        assert_eq!(
            flatten(&p, 0, &mut BTreeSet::new(), &mut 0)
                .unwrap_err()
                .code,
            "unsafe-ssh-config"
        );
    }
    #[test]
    fn refuses_identity_include_without_reading() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("id_ed25519");
        std::fs::write(&p, "private").unwrap();
        assert_eq!(
            flatten(&p, 0, &mut BTreeSet::new(), &mut 0)
                .unwrap_err()
                .code,
            "unsafe-ssh-include"
        );
    }
    #[test]
    fn quoted_match_exec_is_rejected() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("config");
        for line in [
            "Match \"exec\" \"true\"",
            "Match e\\xec true",
            "Match !exec true",
        ] {
            std::fs::write(&p, line).unwrap();
            assert_eq!(
                flatten(&p, 0, &mut BTreeSet::new(), &mut 0)
                    .unwrap_err()
                    .code,
                "unsafe-ssh-config"
            );
        }
    }
    #[test]
    fn quoted_include_preserves_spaces() {
        let d = tempfile::tempdir().unwrap();
        let child = d.path().join("remote hosts.conf");
        std::fs::write(&child, "Host example\n HostName example.com\n").unwrap();
        let p = d.path().join("config");
        std::fs::write(&p, format!("Include \"{}\"", child.display())).unwrap();
        let text = flatten(&p, 0, &mut BTreeSet::new(), &mut 0).unwrap();
        assert_eq!(parse_aliases(&text), vec!["example"]);
    }
}
