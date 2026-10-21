use crate::model::*;
use regex::Regex;
use std::{net::IpAddr, sync::OnceLock};
use url::Url;

pub fn redact(input: &str) -> String {
    static URLS: OnceLock<Regex> = OnceLock::new();
    static SECRET: OnceLock<Regex> = OnceLock::new();
    let urls = URLS.get_or_init(|| Regex::new(r#"(?i)(?:https?|socks5h?)://[^\s<>\"']+"#).unwrap());
    let s = urls.replace_all(input, |c: &regex::Captures| match Url::parse(&c[0]) {
        Ok(mut u) => {
            let _ = u.set_username("");
            let _ = u.set_password(None);
            u.set_query(None);
            u.set_fragment(None);
            u.to_string()
        }
        Err(_) => "[redacted-url]".into(),
    });
    let secret = SECRET.get_or_init(|| {
        Regex::new(r"(?i)(authorization|password|token|api[_-]?key|secret)(\s*[:=]\s*|\s+)[^\s,;]+")
            .unwrap()
    });
    let s = secret.replace_all(&s, "$1=[redacted]").to_string();
    match dirs::home_dir() {
        Some(home) => s.replace(&home.to_string_lossy().to_string(), "~"),
        None => s,
    }
}
pub fn valid_host(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 253
        && !s.starts_with('-')
        && (s.parse::<IpAddr>().is_ok()
            || s.split('.').all(|p| {
                !p.is_empty()
                    && p.len() <= 63
                    && !p.starts_with('-')
                    && !p.ends_with('-')
                    && p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            }))
}
pub fn valid_alias(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && !s.starts_with('-')
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
pub fn validate_url(s: &str) -> Result<Url, String> {
    let u = Url::parse(s).map_err(|_| "HTTPS 测试地址格式无效")?;
    if u.scheme() != "https"
        || u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
    {
        return Err("仅允许不含凭据、查询参数或 fragment 的 HTTPS 地址".into());
    }
    Ok(u)
}
pub fn validate_profile(p: &Profile) -> Result<(), String> {
    if !valid_alias(&p.id)
        || p.label.trim().is_empty()
        || p.label.len() > 100
        || p.label.chars().any(char::is_control)
    {
        return Err("Profile ID 或名称无效".into());
    }
    if p.source == Source::Mock {
        return Err("实时配置不能保存 Mock Profile".into());
    }
    if p.source == Source::Historical && p.enabled {
        return Err("请先确认历史配置，再启用检测".into());
    }
    if p.kind == ProfileKind::Ssh {
        if !valid_alias(&p.ssh_alias) {
            return Err("SSH 别名仅允许字母、数字、点、下划线和连字符".into());
        }
    } else if !valid_host(&p.host) || p.port == 0 {
        return Err("请输入有效主机地址和 1–65535 端口".into());
    }
    if !p.test_url.is_empty() {
        validate_url(&p.test_url)?;
    }
    if p.kind == ProfileKind::Https && p.test_url.is_empty() {
        return Err("HTTPS Profile 需要测试地址".into());
    }
    if !p.expected_cidr.is_empty() {
        p.expected_cidr
            .parse::<ipnet::IpNet>()
            .map_err(|_| "CIDR 格式无效")?;
    }
    Ok(())
}
pub fn contains_ip(cidr: &str, ip: &str) -> Result<bool, String> {
    let net = cidr.parse::<ipnet::IpNet>().map_err(|_| "CIDR 格式无效")?;
    let ip = ip.parse::<IpAddr>().map_err(|_| "IP 格式无效")?;
    Ok(net.contains(&ip))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cidr_regression() {
        assert!(contains_ip("10.204.96.0/21", "10.204.100.80").unwrap());
        assert!(!contains_ip("10.204.96.0/21", "10.204.81.72").unwrap());
    }
    #[test]
    fn redacts_credentials() {
        let s = redact(
            "https://alice:pass@example.com/x?token=123 password=abc Authorization:Bearer-secret",
        );
        assert!(!s.contains("pass@"));
        assert!(!s.contains("alice"));
        assert!(!s.contains("123"));
        assert!(!s.contains("abc"));
        assert!(!s.contains("Bearer-secret"));
    }
    #[test]
    fn blocks_argument_injection() {
        for x in ["-oProxyCommand=x", "host;id", "$(id)", "a\nb", "a/b"] {
            assert!(!valid_host(x));
            assert!(!valid_alias(x));
        }
    }
    #[test]
    fn url_policy() {
        assert!(validate_url("https://example.com/").is_ok());
        for s in [
            "http://example.com",
            "https://u:p@example.com",
            "https://example.com/?token=x",
        ] {
            assert!(validate_url(s).is_err());
        }
    }
}
