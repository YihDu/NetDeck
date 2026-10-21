//! Loopback-only HTTP/CONNECT proxy. Every destination goes through the selected upstream.
use crate::{
    model::{Profile, ProfileKind},
    probe::{http_handshake, socks_handshake},
    safety::valid_host,
};
use std::{sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Semaphore,
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;

async fn header(s: &mut TcpStream) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    loop {
        let b = s.read_u8().await.map_err(|_| "请求头读取失败")?;
        bytes.push(b);
        if bytes.ends_with(b"\r\n\r\n") {
            return Ok(bytes);
        }
        if bytes.len() >= 16384 {
            return Err("请求头过大".into());
        }
    }
}
fn authority(text: &str) -> Result<(String, u16), String> {
    let url = url::Url::parse(&format!("http://{text}")).map_err(|_| "目标地址无效")?;
    let host = url
        .host_str()
        .unwrap_or("")
        .trim_matches(['[', ']'])
        .to_string();
    if !valid_host(&host)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("目标地址无效".into());
    }
    Ok((host, url.port().unwrap_or(80)))
}
async fn connect(up: &Profile, host: &str, port: u16) -> Result<TcpStream, String> {
    let mut stream = TcpStream::connect((up.host.as_str(), up.port))
        .await
        .map_err(|_| "上游不可达")?;
    let r = match up.kind {
        ProfileKind::HttpProxy => http_handshake(&mut stream, host, port).await,
        ProfileKind::Socks5Proxy => socks_handshake(&mut stream, host, port).await,
        _ => return Err("上游协议无效".into()),
    };
    r.map_err(|_| "上游握手失败")?;
    Ok(stream)
}
async fn session(client: &mut TcpStream, up: &Profile) -> Result<TcpStream, String> {
    let bytes = header(client).await?;
    let text = std::str::from_utf8(&bytes).map_err(|_| "请求头编码无效")?;
    let mut lines = text.split("\r\n");
    let parts: Vec<_> = lines.next().unwrap_or("").split_whitespace().collect();
    if parts.len() != 3 || !["HTTP/1.0", "HTTP/1.1"].contains(&parts[2]) {
        return Err("请求行无效".into());
    }
    // Reject browser-originated proxy control and request smuggling ambiguity.
    let headers: Vec<_> = lines.filter(|l| !l.is_empty()).collect();
    for line in &headers {
        let (key, _) = line.split_once(':').ok_or("请求头无效")?;
        if key.trim() != key
            || key.is_empty()
            || key.bytes().any(|b| !b.is_ascii_alphanumeric() && b != b'-')
        {
            return Err("请求头无效".into());
        }
        if [
            "origin",
            "proxy-authorization",
            "transfer-encoding",
            "upgrade",
        ]
        .contains(&key.to_ascii_lowercase().as_str())
        {
            return Err("不支持此请求头".into());
        }
    }
    if headers
        .iter()
        .filter(|h| h.to_ascii_lowercase().starts_with("content-length:"))
        .count()
        > 1
    {
        return Err("重复长度".into());
    }
    if parts[0] == "CONNECT" {
        let (host, port) = authority(parts[1])?;
        let upstream = connect(up, &host, port).await?;
        client
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .await
            .map_err(|_| "客户端已关闭")?;
        Ok(upstream)
    } else {
        if !["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"].contains(&parts[0]) {
            return Err("HTTP 方法不支持".into());
        }
        let url = url::Url::parse(parts[1]).map_err(|_| "需要绝对 HTTP URL")?;
        if url.scheme() != "http"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err("URL 无效；HTTPS 请使用 CONNECT".into());
        }
        let host = url.host_str().ok_or("缺少主机")?.trim_matches(['[', ']']);
        if !valid_host(host) {
            return Err("主机无效".into());
        }
        let http_upstream = up.kind == ProfileKind::HttpProxy;
        let mut upstream = if http_upstream {
            TcpStream::connect((up.host.as_str(), up.port))
                .await
                .map_err(|_| "上游不可达")?
        } else {
            connect(up, host, url.port_or_known_default().unwrap_or(80)).await?
        };
        let path = if http_upstream {
            url.as_str()
        } else {
            &url[url::Position::BeforePath..url::Position::AfterQuery]
        };
        let mut rewritten = format!(
            "{} {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n",
            parts[0],
            path,
            &url[url::Position::BeforeHost..url::Position::AfterPort]
        );
        for line in headers {
            let key = line.split(':').next().unwrap_or("").to_ascii_lowercase();
            if ![
                "host",
                "connection",
                "proxy-connection",
                "keep-alive",
                "te",
                "trailer",
            ]
            .contains(&key.as_str())
            {
                rewritten.push_str(line);
                rewritten.push_str("\r\n");
            }
        }
        rewritten.push_str("\r\n");
        upstream
            .write_all(rewritten.as_bytes())
            .await
            .map_err(|_| "上游写入失败")?;
        Ok(upstream)
    }
}
pub async fn serve(listener: TcpListener, upstream: Profile, cancel: CancellationToken) {
    serve_managed(listener, Arc::new(std::sync::RwLock::new(upstream)), cancel).await;
}
pub async fn serve_managed(
    listener: TcpListener,
    upstream: Arc<std::sync::RwLock<Profile>>,
    cancel: CancellationToken,
) {
    let limit = Arc::new(Semaphore::new(32));
    let mut tasks = JoinSet::new();
    loop {
        tokio::select! {
            _=cancel.cancelled()=>break,
            Some(_)=tasks.join_next(), if !tasks.is_empty()=>{},
            accepted=listener.accept()=> {
                let Ok((mut client,_))=accepted else { break };
                let Ok(permit)=limit.clone().try_acquire_owned() else { continue };
                let Ok(up)=upstream.read().map(|p|p.clone()) else {continue};
                tasks.spawn(async move {
                    let _permit=permit;
                    match tokio::time::timeout(Duration::from_secs(8),session(&mut client,&up)).await {
                        Ok(Ok(mut remote))=> { let _=tokio::time::timeout(Duration::from_secs(3600),tokio::io::copy_bidirectional(&mut client,&mut remote)).await; },
                        _=>{let _=client.write_all(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n").await;}
                    }
                });
            }
        }
    }
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authority_rejects_credentials_and_paths() {
        assert!(authority("user:pass@host:80").is_err());
        assert!(authority("host:80/path").is_err());
        assert_eq!(
            authority("example.com:443").unwrap(),
            ("example.com".into(), 443)
        );
    }
    #[tokio::test]
    async fn unavailable_upstream_fails_closed() {
        let reserved = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = reserved.local_addr().unwrap().port();
        drop(reserved);
        let up = Profile {
            id: "test".into(),
            label: "test".into(),
            kind: ProfileKind::HttpProxy,
            enabled: true,
            source: crate::model::Source::Configured,
            host: "127.0.0.1".into(),
            port,
            ssh_alias: String::new(),
            test_url: String::new(),
            expected_cidr: String::new(),
        };
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let cancel = CancellationToken::new();
        let task = tokio::spawn(serve(listener, up, cancel.clone()));
        let mut c = TcpStream::connect(addr).await.unwrap();
        c.write_all(b"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n")
            .await
            .unwrap();
        let h = header(&mut c).await.unwrap();
        assert!(h.starts_with(b"HTTP/1.1 502"));
        cancel.cancel();
        task.await.unwrap();
        assert!(TcpStream::connect(addr).await.is_err());
    }
    async fn through_upstream(kind: ProfileKind, tunnel: bool) {
        let mock = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = mock.local_addr().unwrap().port();
        let socks = kind == ProfileKind::Socks5Proxy;
        let server = tokio::spawn(async move {
            let (mut stream, _) = mock.accept().await.unwrap();
            if socks {
                let mut greeting = [0; 3];
                stream.read_exact(&mut greeting).await.unwrap();
                assert_eq!(greeting, [5, 1, 0]);
                stream.write_all(&[5, 0]).await.unwrap();
                let mut request = [0; 5];
                stream.read_exact(&mut request).await.unwrap();
                assert_eq!(&request[..4], &[5, 1, 0, 3]);
                let mut address = vec![0; request[4] as usize + 2];
                stream.read_exact(&mut address).await.unwrap();
                assert_eq!(&address[..address.len() - 2], b"destination.invalid");
                stream
                    .write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 80])
                    .await
                    .unwrap();
            } else if tunnel {
                let request = header(&mut stream).await.unwrap();
                assert!(
                    String::from_utf8_lossy(&request).starts_with("CONNECT destination.invalid:")
                );
                stream
                    .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                    .await
                    .unwrap();
            }
            if tunnel {
                let mut body = [0; 4];
                stream.read_exact(&mut body).await.unwrap();
                assert_eq!(&body, b"ping");
                stream.write_all(b"pong").await.unwrap();
            } else {
                let request = header(&mut stream).await.unwrap();
                let request = String::from_utf8(request).unwrap();
                assert!(request.starts_with(if socks {
                    "GET /resource?q=1 HTTP/1.1"
                } else {
                    "GET http://destination.invalid/resource?q=1 HTTP/1.1"
                }));
                assert!(request.contains("Host: destination.invalid"));
                assert!(!request.contains("wrong.invalid"));
                stream
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                    )
                    .await
                    .unwrap();
            }
        });
        let up = Profile {
            id: "test".into(),
            label: "test".into(),
            kind,
            enabled: true,
            source: crate::model::Source::Configured,
            host: "127.0.0.1".into(),
            port,
            ssh_alias: String::new(),
            test_url: String::new(),
            expected_cidr: String::new(),
        };
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let cancel = CancellationToken::new();
        let gateway = tokio::spawn(serve(listener, up, cancel.clone()));
        let mut client = TcpStream::connect(addr).await.unwrap();
        if tunnel {
            client.write_all(b"CONNECT destination.invalid:443 HTTP/1.1\r\nHost: destination.invalid\r\n\r\n").await.unwrap();
            assert!(
                header(&mut client)
                    .await
                    .unwrap()
                    .starts_with(b"HTTP/1.1 200")
            );
            client.write_all(b"ping").await.unwrap();
            let mut pong = [0; 4];
            client.read_exact(&mut pong).await.unwrap();
            assert_eq!(&pong, b"pong");
        } else {
            client.write_all(b"GET http://destination.invalid/resource?q=1 HTTP/1.1\r\nHost: wrong.invalid\r\n\r\n").await.unwrap();
            let h = header(&mut client).await.unwrap();
            assert!(h.starts_with(b"HTTP/1.1 200"));
            let mut body = [0; 2];
            client.read_exact(&mut body).await.unwrap();
            assert_eq!(&body, b"ok");
        }
        server.await.unwrap();
        cancel.cancel();
        gateway.await.unwrap();
    }
    #[tokio::test]
    async fn http_via_http_upstream() {
        tokio::time::timeout(
            Duration::from_secs(3),
            through_upstream(ProfileKind::HttpProxy, false),
        )
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn connect_via_http_upstream() {
        tokio::time::timeout(
            Duration::from_secs(3),
            through_upstream(ProfileKind::HttpProxy, true),
        )
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn http_via_socks_upstream() {
        tokio::time::timeout(
            Duration::from_secs(3),
            through_upstream(ProfileKind::Socks5Proxy, false),
        )
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn connect_via_socks_upstream() {
        tokio::time::timeout(
            Duration::from_secs(3),
            through_upstream(ProfileKind::Socks5Proxy, true),
        )
        .await
        .unwrap();
    }
}
