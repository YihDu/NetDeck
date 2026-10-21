use netdeck_core::{CancellationToken, discovery, model::*, probe, storage};
use std::sync::Mutex;
use tauri::State;
#[derive(Default)]
struct AppState {
    active: Mutex<Option<CancellationToken>>,
    config_lock: Mutex<()>,
    snapshot_busy: std::sync::atomic::AtomicBool,
}
#[tauri::command]
async fn get_network_snapshot(state: State<'_, AppState>) -> Result<Snapshot, String> {
    use std::sync::atomic::Ordering;
    if state.snapshot_busy.swap(true, Ordering::SeqCst) {
        return Err("本机发现正在进行".into());
    }
    let snapshot = discovery::snapshot(&CancellationToken::new()).await;
    state.snapshot_busy.store(false, Ordering::SeqCst);
    Ok(snapshot)
}
#[tauri::command]
fn load_config() -> Result<Config, String> {
    storage::load()
}
#[tauri::command]
fn save_config(config: Config, state: State<'_, AppState>) -> Result<(), String> {
    let _guard = state.config_lock.lock().map_err(|_| "配置锁不可用")?;
    storage::save(&config)
}
#[tauri::command]
async fn run_diagnostics(
    profile_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<Diagnostic>, String> {
    let config = storage::load()?;
    let profiles = if let Some(id) = profile_id {
        vec![
            config
                .profiles
                .into_iter()
                .find(|p| p.id == id && p.enabled)
                .ok_or("Profile 不存在或未启用")?,
        ]
    } else {
        config.profiles
    };
    let cancel = CancellationToken::new();
    {
        let mut active = state.active.lock().map_err(|_| "诊断锁不可用")?;
        if active.is_some() {
            return Err("已有诊断正在运行".into());
        }
        *active = Some(cancel.clone());
    }
    let deadline = cancel.clone();
    let timer = tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(120)).await;
        deadline.cancel();
    });
    let results = probe::diagnose_all(profiles, cancel).await;
    timer.abort();
    *state.active.lock().map_err(|_| "诊断锁不可用")? = None;
    storage::record(&results)?;
    Ok(results)
}
#[tauri::command]
fn cancel_diagnostics(state: State<'_, AppState>) -> Result<(), String> {
    if let Some(c) = state.active.lock().map_err(|_| "诊断锁不可用")?.as_ref() {
        c.cancel();
    }
    Ok(())
}
#[tauri::command]
fn get_history() -> Result<Vec<Diagnostic>, String> {
    storage::history()
}
#[tauri::command]
fn make_report(snapshot: Option<Snapshot>, results: Vec<Diagnostic>) -> String {
    storage::report(snapshot.as_ref(), &results)
}
#[tauri::command]
fn export_report(snapshot: Option<Snapshot>, results: Vec<Diagnostic>) -> Result<String, String> {
    let dir = storage::data_dir()?.join("reports");
    std::fs::create_dir_all(&dir).map_err(|_| "无法创建报告目录")?;
    let name = format!(
        "netdeck-{}.json",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );
    let path = dir.join(name);
    let text = storage::report(snapshot.as_ref(), &results);
    use std::io::Write;
    let mut file = tempfile::NamedTempFile::new_in(&dir).map_err(|_| "无法创建报告")?;
    file.write_all(text.as_bytes())
        .map_err(|_| "无法写入报告")?;
    file.persist(&path).map_err(|_| "无法保存报告")?;
    Ok(path.to_string_lossy().into_owned())
}
#[tauri::command]
async fn copy_report(snapshot: Option<Snapshot>, results: Vec<Diagnostic>) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let text = storage::report(snapshot.as_ref(), &results);
    if text.len() > 2 * 1024 * 1024 {
        return Err("报告过大".into());
    }
    let mut child = tokio::process::Command::new("/usr/bin/pbcopy")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "剪贴板不可用")?;
    let mut stdin = child.stdin.take().ok_or("剪贴板不可用")?;
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        stdin.write_all(text.as_bytes()).await?;
        drop(stdin);
        child.wait().await
    })
    .await
    .map_err(|_| "复制超时")?
    .map_err(|_| "复制失败")?
    .success()
    .then_some(())
    .ok_or("复制失败".into())
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_network_snapshot,
            load_config,
            save_config,
            run_diagnostics,
            cancel_diagnostics,
            get_history,
            make_report,
            export_report,
            copy_report
        ])
        .run(tauri::generate_context!())
        .expect("NetDeck could not start");
}
