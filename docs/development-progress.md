# Development checkpoint — 2026-10-21

## Repository and environment

- User-selected location: `/Users/yihdu/Codefield/Tools/NetDeck`.
- Independent Git repository, branch `main`.
- Implementation baseline: `b309ab1` — read-only desktop dashboard, shared core and CLI. The following documentation commit records this validation; inspect `git log` for its exact hash.
- macOS 26.5.1, Apple Silicon/aarch64, Node 22.22.2, npm 10.9.7, Xcode Command Line Tools available.
- Official create-tauri-app 4.8.0 React/TypeScript template, Tauri 2.12.4 resolved in Cargo.lock. npm used because pnpm was absent.
- Rust 1.99.1 installed with approval in project-local `.tooling/`, plus rustfmt and Clippy. No sudo or shell-profile changes.

## Delivered

- `target/release/bundle/macos/NetDeck.app` — release app, approximately 6.98 MiB, Apple Silicon.
- `target/release/netdeck` — standalone CLI release executable.
- Seven Chinese-first UI pages, dark/light themes, interactive directed topology, evidence Inspector, Profile editor, history and reporting.
- macOS proxy/route/listener inventory, Tailscale inventory and explicit peer ping, SSH alias discovery and guarded effective-config evaluation.
- Per-Profile DNS/CIDR/route/TCP/HTTP CONNECT/SOCKS5 CONNECT/HTTPS diagnostics, cancellation, partial results, optional scheduling, conservative status labels.
- README, architecture, command matrix, diagnosis rules, safety documentation, tests and lockfiles.

## Actual validation

| Check                                                                | Result                                                                             |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `cargo test -p netdeck-core -p netdeck-cli` via project tool wrapper | 22 core tests passed; no CLI-specific unit tests                                   |
| `npm test`                                                           | 8 tests passed                                                                     |
| `npm run test:e2e`                                                   | 3 Chrome tests passed, explicitly mocked native contract                           |
| `cargo clippy --workspace --all-targets -- -D warnings`              | Passed                                                                             |
| `npm run build`                                                      | Passed; nonblocking warning for a roughly 513 kB JS bundle, 163 kB gzip            |
| `npm run tauri dev`                                                  | Compiled and launched native desktop executable; Vite served on loopback           |
| `npm run tauri build`                                                | Release `.app` bundled successfully                                                |
| CLI release build and `doctor`                                       | Passed; real macOS inventory collected                                             |
| npm audit after dependency updates                                   | 0 vulnerabilities reported                                                         |
| Browser screenshots                                                  | Overview preview and Mock diagnostics inspected; artifacts in ignored test-results |

Native window AX/screenshot inspection was attempted but Computer Use returned “Computer Use was not approved to use NetDeck”. No alternative UI automation bypass was used. Browser tests validate UI behavior and mock IPC contracts; they are not claimed to be native WebView end-to-end tests. The compiled native process was started, but its appearance was not visually inspected through Computer Use.

The requested Gemini command worker was attempted. Its provider returned HTTP 401 before producing findings. Safety review and fixes were performed by the primary agent, backed by tests; no Gemini review is claimed.

## Real inventory, not Mock

Report: `runtime/diagnostic-report.json` (ignored by Git).

Collected at `2026-10-21T04:01:29.602Z` / `2026-10-21 12:01:29 Asia/Shanghai`:

- macOS 26.5.1 / aarch64; default interface `en0`.
- 3 system proxy entries; HTTP_PROXY, HTTPS_PROXY, ALL_PROXY and NO_PROXY present in inherited environment. Values are redacted in the report.
- 128 listener rows sampled (cap, not a claim of the complete machine-wide count).
- Tailscale Running, 2 peer records. Peer reachability has not been actively tested.
- 13 explicit SSH aliases found by static reading. Existing Match exec prevents safe effective-config evaluation; the application reports the limitation and does not execute the clause.

No historical remote target was probed, no VPN was toggled, and no SSH authentication, remote application health, or remote port ownership was tested. Regression tests use localhost services and explicitly labelled fixtures.

## Scope still open

This is a usable read-only first version, not completion of every item in the original full specification.

1. Cross-Profile dependency orchestration for composite Mac → Tailscale → Windows → proxy → CCI/Coder paths. Current diagnostics evaluate individual Profiles and their local protocol layers.
2. Stronger correlation of Tailscale advertised routes with actual macOS routing; current evidence remains separate and does not overclaim ownership of a utun route.
3. Broader safe SSH Include/Match compatibility and identity-file type/existence metadata (currently only configured identity count; no key content is read).
4. Opt-in SSH authentication checks with safe host-key handling and forwarding disabled.
5. Stage 2 tunnel manager: operation preview, confirmation, exact process ownership, conflict preflight, exit/stderr monitoring, stop/restart only owned tunnels.
6. Menu-bar integration; stable localhost gateway and one-click operation plans belong to subsequent stages.
7. Native WebView visual QA and controlled VPN failure/recovery testing require the corresponding user-granted surface/action authorization. Intel builds, signing and notarization remain unverified.
