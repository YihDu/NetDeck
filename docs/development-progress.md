# NetDeck 0.3 — daily workflow simplification

User correction: remove documentation-like dashboards from the daily flow. The home screen is now a compact Mac VPN endpoint and a machine list. Add-machine defaults expose only name, SSH alias and public/SLAI path; ports and forwarding strategy are collapsed. Existing diagnostics and configuration remain behind Settings.

Implemented single/multi-machine connection batches using explicit backend previews. After one confirmation: optional Tailscale prerequisites, stable proxy, each SSH reverse tunnel, then each remote egress check. Failure stops the sequence, leaves existing connections visible and available to disconnect, and discards unused plans. Cancellation sends no execute calls. Endpoint changes are not inferred as healthy; verified remote status is separate from SSH state and expires.

Compatibility: older tunnel definitions deserialize to public path. No existing profiles, SSH files or network settings were rewritten during development. Browser E2E fixtures use Mock machine labels; no real remote connections were made.

Validation: 39 Rust core tests, 8 Vitest tests and 7 Chrome flow tests passed; workspace Clippy with `-D warnings` passed. TypeScript/Vite production build passed. The two additional core checks cover cancelled preview tokens and old tunnel-definition compatibility. Screenshots: `test-results/daily-machines-mock.png`, `test-results/daily-connected-mock.png`; both inspected at 1100px width. These are explicitly mocked examples, not evidence of live Coder/CCI connectivity. The 0.3 Apple Silicon application bundle was built successfully (7.53 MiB); final frontend refresh was rebuilt before launch.

---

# NetDeck 0.2 development record — 2026-10-21

User scope: implement controlled networking and a minimal workflow UI; exclude Magpie, Windows remote administration and Transtar internal node switching. Work remains in the independent `Tools/NetDeck` Git repository.

## Delivered in 0.2

- Three-page Chinese UI: dashboard, four workflow guides, configuration/history. Dashboard separates saved configuration, current signed diagnostic results, age, failure evidence and next action.
- Persisted tunnel definitions and ordered workflow prerequisites. Failed prerequisites block downstream requests. v1 configuration migrates in memory to schema v2; no network action on load/save.
- Explicit SSH auth, managed -L/-R, reuse-vs-override config strategy, frozen temporary configuration, classified failures, strict host keys, own process-group cleanup. Restart is an explicit stop then start sequence.
- Loopback stable HTTP/CONNECT gateway with HTTP/SOCKS5 upstream, no direct fallback, bounded connections, validated switching and 60-second upstream checks.
- Backend-generated single-use previews, expiry, configuration/runtime state checks, system proxy and Tailscale controls, persisted before-snapshots, readback, failure recovery, externally changed state protection, validated rollback data.
- Separate remote curl egress check and copyable current-Shell proxy instructions. Menu-bar entry, owned connection status tooltip and exit cleanup.
- Magpie removed from selectable examples and user workflows. Windows may remain a detected network peer, without remote administration.

## Validation performed

| Check | Result |
| --- | --- |
| Rust core / CLI tests | 37 passed; no CLI-specific unit tests |
| Vitest | 8 passed |
| Chrome Playwright | 4 passed; native IPC mocked and visibly marked Mock |
| Clippy workspace/all-targets `-D warnings` | Passed |
| TypeScript / Vite production build | Passed |
| Apple Silicon Tauri release bundle | Passed; final 0.2 `.app` rebuild completed, 7.51 MiB |
| CLI release + doctor | Passed; real read-only inventory at 2026-10-21T04:40:00.597Z, aarch64, 128 listeners sampled, 13 SSH aliases, Tailscale Running |
| Browser screenshot review | Dashboard, remote workflow and minimum-width layout reviewed; dark/light screenshots generated |

The new loopback tests exercise real request/response bytes for HTTP and CONNECT over HTTP and SOCKS5 upstreams, plus fail-closed behavior. Other tests cover one-use/expired previews, stored command validation, forwarding scope, static Match-exec suppression with real `ssh -G`, v1 migration, and prerequisite blocking without downstream connects. Browser tests check preview cancellation, confirmation exactly once, rollback preview, persisted workflows/tunnels, CRUD, report copy, theme, minimum-width overflow and invalidation after endpoint edits.

**Not live-verified:** actual Coder/CCI authentication, remote forwarding and curl, changes to the user's Tailscale/system proxy, their real failure/rollback paths, native WebView/menu visual behavior, Intel, Developer ID signing and notarization. No such network changes were made as development tests. Previous native Computer Use permission was unavailable; no bypass was attempted. These limits are also documented in README and the UI's failure guidance.

The read-only Gemini command worker was attempted again; it returned HTTP 401 without findings. No successful independent Gemini review is claimed. Primary-agent review found and addressed stale endpoint results, post-preview runtime replacement, gateway-switch preservation, unsafe persisted rollback command data, original-forward duplication and owned subprocess cleanup.

Artifacts: `target/release/bundle/macos/NetDeck.app`, `target/release/netdeck`; screenshots under ignored `test-results/`. Personal configuration, local reports, build outputs and toolchain are not committed.

---

# Archived 0.1 record (historical; the open-scope list below is superseded by 0.2)

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
