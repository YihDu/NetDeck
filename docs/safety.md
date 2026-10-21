# Safety and privacy

1. Discovery reads OS state. Historical examples are disabled until the user confirms current values. Active profiles never enumerate a subnet or expand `Host *` into targets.
2. Frontend IPC cannot execute arbitrary programs. Addresses, aliases, ports, URLs, schema versions and polling limits are validated by Rust. No credential-bearing URLs or query parameters are accepted as health URLs.
3. SSH config is bounded and includes are limited to config-looking files after canonicalization. Quoted/escaped `Match exec` is detected before evaluating effective configuration. Static alias listing can still succeed without executing it. ProxyCommand text and identity paths are discarded from serialized output.
4. User and system SSH configuration are flattened into a private temporary file so `ssh -G` cannot read an unvalidated later include. Include variables, non-config filenames, excessive size/depth and repeated/cyclic paths fail closed. This intentionally supports fewer forms than OpenSSH; it does not silently reinterpret unsupported forms as healthy.
5. Proxy checks implement the declared protocol. HTTP CONNECT and SOCKS5 CONNECT are separately validated. No fallback to direct traffic is used for proxy profiles. Direct HTTPS profiles explicitly disable inherited environment proxies. TLS certificate verification is never disabled.
6. Logging is local and bounded. Reports keep network identifiers useful for debugging; credentials and user-directory prefixes are redacted. There is no remote upload, telemetry or account system.
7. Config writes are atomic. Invalid or future schemas are not overwritten automatically. Stored files use private temp-file permissions; logs are created with mode 0600.
8. Tests mock only explicit fixtures or loopback services. The production bridge has no demo fallback. Test fixtures carry Mock labels.
9. Stage 2 must introduce operation previews, explicit confirmation and owned-process tracking before it can launch tunnels. System settings, remote changes, launchd, Windows agents and shared gateways need separate implementation and verification.
