# Architecture

```text
React pages / Inspector / React Flow
                 │ typed Tauri IPC
src-tauri (application state, cancellation, storage entrypoints)
                 │
          netdeck-core  ←  netdeck-cli
          ├─ model      shared serde types and evidence
          ├─ discovery  bounded read-only system inventory
          ├─ command    fixed argv, timeout, kill-on-drop, capped pipes
          ├─ ssh        safe include flattening and effective config
          ├─ probe      DNS / route / TCP / proxy / HTTPS
          ├─ safety     validation, CIDR, redaction
          └─ storage    versioned config, logs, reports
```

Rust owns OS and network operations. The WebView has no arbitrary shell plugin, filesystem plugin, or HTTP plugin. Commands expose concrete typed operations. Configuration changes only affect NetDeck's own files.

Frontend state uses React hooks and a single configuration state; no redundant Zustand/Query stores are introduced. The app keeps last in-memory results visible while a new check runs. Profile edits invalidate corresponding results; previous runs remain in the activity log.

Discovery refresh: default 15 s, no active remote probes. Active profiles: manual by default, optional 30–3600 s interval, only enabled profiles. At most three diagnostics run concurrently; command and socket work are bounded. Desktop batches have a 120 s deadline that triggers cancellation and returns partial results. Closing the desktop process drops owned command futures; no detached tunnel processes exist.

Evidence is a tuple of result, source, check timestamp, latency, detail and error code. Configured peers/routes are not marked reachable. Frontend changes expired results to a stale badge rather than retaining healthy green. Historical profiles must be confirmed to become configured before enabling.

Native window minimum is 1100×700. Network Map supports zoom, pan, fit, protocol filters, directed edges, node/edge inspection. Compact overview has a topology preview. Content can scroll at small window sizes.

Package manager is npm on this machine. Workspace binaries have distinct names (`netdeck-desktop`, `netdeck`). Project-local Rust is optional and intentionally excluded from Git.
