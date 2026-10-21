use crate::{
    model::*,
    safety::{redact, validate_profile},
};
use std::{io::Write, path::PathBuf};

pub fn data_dir() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .map(|p| p.join("NetDeck"))
        .ok_or_else(|| "应用数据目录不可用".into())
}
pub fn load() -> Result<Config, String> {
    let path = data_dir()?.join("config.json");
    if !path.exists() {
        return Ok(Config::default());
    }
    let meta = std::fs::metadata(&path).map_err(|_| "无法读取配置文件")?;
    if meta.len() > 1024 * 1024 {
        return Err("配置文件过大".into());
    }
    let text = std::fs::read_to_string(path).map_err(|_| "无法读取配置文件")?;
    let c: Config = serde_json::from_str(&text).map_err(|_| "配置格式无效，未覆盖原文件")?;
    validate_config(&c)?;
    Ok(c)
}
pub fn validate_config(c: &Config) -> Result<(), String> {
    if c.version != 1 {
        return Err("不支持的配置版本；请保留原文件并升级应用".into());
    }
    if c.profiles.len() > 64 {
        return Err("最多支持 64 个 Profile".into());
    }
    let mut ids = std::collections::BTreeSet::new();
    for p in &c.profiles {
        validate_profile(p)?;
        if !ids.insert(&p.id) {
            return Err("Profile ID 重复".into());
        }
    }
    if !["dark", "light"].contains(&c.preferences.theme.as_str())
        || !(10..=300).contains(&c.preferences.refresh_seconds)
        || !(30..=3600).contains(&c.preferences.diagnose_seconds)
    {
        return Err("偏好配置无效：本机刷新 10–300 秒，主动检测 30–3600 秒".into());
    }
    Ok(())
}
pub fn save(c: &Config) -> Result<(), String> {
    validate_config(c)?;
    let dir = data_dir()?;
    std::fs::create_dir_all(&dir).map_err(|_| "无法创建配置目录")?;
    let mut temp = tempfile::NamedTempFile::new_in(&dir).map_err(|_| "无法创建配置临时文件")?;
    serde_json::to_writer_pretty(&mut temp, c).map_err(|_| "无法序列化配置")?;
    temp.flush().map_err(|_| "写入配置失败")?;
    temp.as_file().sync_all().map_err(|_| "同步配置失败")?;
    temp.persist(dir.join("config.json"))
        .map_err(|_| "保存配置失败")?;
    Ok(())
}
pub fn history() -> Result<Vec<Diagnostic>, String> {
    let path = data_dir()?.join("activity.jsonl");
    if !path.exists() {
        return Ok(vec![]);
    }
    if std::fs::metadata(&path).map_err(|_| "无法读取日志")?.len() > 2 * 1024 * 1024 {
        return Err("日志文件超过读取限制".into());
    }
    let text = std::fs::read_to_string(path).map_err(|_| "无法读取日志")?;
    Ok(text
        .lines()
        .rev()
        .take(100)
        .filter_map(|s| serde_json::from_str(s).ok())
        .collect())
}
pub fn record(results: &[Diagnostic]) -> Result<(), String> {
    let dir = data_dir()?;
    std::fs::create_dir_all(&dir).map_err(|_| "无法创建日志目录")?;
    let path = dir.join("activity.jsonl");
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > 1024 * 1024) {
        std::fs::rename(&path, dir.join("activity.previous.jsonl")).map_err(|_| "日志轮转失败")?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|_| "无法写入日志")?;
    for r in results {
        let text = serde_json::to_string(r).map_err(|_| "日志序列化失败")?;
        writeln!(file, "{}", redact(&text)).map_err(|_| "日志写入失败")?;
    }
    Ok(())
}
pub fn report(snapshot: Option<&Snapshot>, results: &[Diagnostic]) -> String {
    let value = serde_json::json!({"application":"NetDeck","reportVersion":1,"generatedAt":now(),"mode":"Live / read-only","snapshot":snapshot,"diagnostics":results,"privacy":"No private keys, credentials, SSH usernames or raw ProxyCommand are included. Network addresses remain for diagnosis."});
    redact(&serde_json::to_string_pretty(&value).unwrap_or_default())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_future_schema_and_fast_polling() {
        let mut c = Config {
            version: 2,
            ..Config::default()
        };
        assert!(validate_config(&c).is_err());
        c.version = 1;
        c.preferences.diagnose_seconds = 1;
        assert!(validate_config(&c).is_err());
    }
}
