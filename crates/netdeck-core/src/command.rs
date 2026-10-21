use crate::safety::redact;
use std::{
    process::Stdio,
    time::{Duration, Instant},
};
use tokio::{io::AsyncReadExt, process::Command};
use tokio_util::sync::CancellationToken;

const OUTPUT_LIMIT: u64 = 256 * 1024;
#[derive(Debug)]
pub struct Output {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
    pub ms: u64,
}
#[derive(Debug, Clone)]
pub struct Failure {
    pub code: String,
    pub message: String,
}
impl Failure {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}
pub async fn run(
    exe: &str,
    args: &[&str],
    seconds: u64,
    cancel: &CancellationToken,
) -> Result<Output, Failure> {
    if cancel.is_cancelled() {
        return Err(Failure::new("cancelled", "检测已取消"));
    }
    let start = Instant::now();
    let mut child = Command::new(exe)
        .args(args)
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            Failure::new(
                match e.kind() {
                    std::io::ErrorKind::NotFound => "not-installed",
                    std::io::ErrorKind::PermissionDenied => "permission-denied",
                    _ => "spawn-failed",
                },
                redact(&e.to_string()),
            )
        })?;
    let mut out = child.stdout.take().unwrap().take(OUTPUT_LIMIT + 1);
    let mut err = child.stderr.take().unwrap().take(OUTPUT_LIMIT + 1);
    let mut outbuf = vec![];
    let mut errbuf = vec![];
    let operation = async {
        let (status, _, _) = tokio::try_join!(
            async {
                child
                    .wait()
                    .await
                    .map_err(|e| Failure::new("wait-failed", e.to_string()))
            },
            async {
                let n = out
                    .read_to_end(&mut outbuf)
                    .await
                    .map_err(|e| Failure::new("read-failed", e.to_string()))?;
                if n as u64 > OUTPUT_LIMIT {
                    Err(Failure::new("output-limit", "命令输出超过安全限制"))
                } else {
                    Ok(())
                }
            },
            async {
                let n = err
                    .read_to_end(&mut errbuf)
                    .await
                    .map_err(|e| Failure::new("read-failed", e.to_string()))?;
                if n as u64 > OUTPUT_LIMIT {
                    Err(Failure::new("output-limit", "命令输出超过安全限制"))
                } else {
                    Ok(())
                }
            }
        )?;
        Ok::<_, Failure>(status)
    };
    let result = tokio::select! {
        _ = cancel.cancelled() => Err(Failure::new("cancelled", "检测已取消")),
        r = tokio::time::timeout(Duration::from_secs(seconds), operation) => r.unwrap_or_else(|_| Err(Failure::new("timeout", format!("命令超过 {seconds} 秒"))))
    };
    match result {
        Ok(status) => {
            if outbuf.len() as u64 > OUTPUT_LIMIT || errbuf.len() as u64 > OUTPUT_LIMIT {
                return Err(Failure::new("output-limit", "命令输出超过安全限制"));
            }
            Ok(Output {
                stdout: String::from_utf8_lossy(&outbuf).into(),
                stderr: redact(&String::from_utf8_lossy(&errbuf)),
                code: status.code().unwrap_or(-1),
                ms: start.elapsed().as_millis() as u64,
            })
        }
        Err(e) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            Err(e)
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn oversized_output_stops_process() {
        assert_eq!(
            run(
                "/usr/bin/yes",
                &["netdeck-test"],
                3,
                &CancellationToken::new()
            )
            .await
            .unwrap_err()
            .code,
            "output-limit"
        );
    }
    #[tokio::test]
    async fn command_timeout_and_cancel() {
        let c = CancellationToken::new();
        assert_eq!(
            run("/bin/sleep", &["2"], 0, &c).await.unwrap_err().code,
            "timeout"
        );
        c.cancel();
        assert_eq!(
            run("/bin/sleep", &["2"], 5, &c).await.unwrap_err().code,
            "cancelled"
        );
    }
    #[tokio::test]
    async fn missing_command_classified() {
        assert_eq!(
            run(
                "/nonexistent/netdeck-test",
                &[],
                1,
                &CancellationToken::new()
            )
            .await
            .unwrap_err()
            .code,
            "not-installed"
        );
    }
}
