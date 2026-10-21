# Architecture — 0.2

```text
React: 主面板 / 场景步骤 / 配置与记录 / Radix Inspector
                    │ typed IPC (no shell plugin)
Tauri: configuration mutex, one diagnostic batch, Controller mutex, tray, exit cleanup
                    │
netdeck-core ← read-only netdeck CLI
  model / storage: schema v2, profiles, tunnel definitions, ordered workflows
  discovery: bounded read-only OS/Tailscale/SSH inventory
  probe: individual layered checks, ordered prerequisite chain, cancellation
  ssh: include flattening, static effective config, frozen controlled-session config
  control: typed preview tokens, frozen requests, owned process groups, settings journal
  gateway: loopback-only HTTP/CONNECT server, HTTP/SOCKS5 upstream, no direct fallback
  command / safety: bounded argv execution, validation, privacy
```

The UI has one configuration source. A diagnostic includes a deterministic signature of its exact Profile; current rows and graph accept only matching signatures. Historical results remain available in logs. Results older than 120 seconds are displayed as stale.

Default local discovery interval 15 s. Optional active checks have a separate 30–3600 s interval and only probe enabled profiles. Global batches have concurrency 3 and deadline 120 s; ordered workflows stop requesting downstream targets on any non-healthy prerequisite.

A preview lives in memory for five minutes, capped at 128 pending plans. It captures the frozen SSH configuration, selected upstream and request. Execution consumes the token before any effects. Settings are read again to reject changes since preview; owned runtime generation is checked as well. Controller operations serialize, preventing duplicate starts and settings races within this process.

Settings recovery snapshots are saved before mutation. Post-state is read and compared, failures attempt restore and readback. Recovery refuses to overwrite an externally changed state. Persisted rollback entries are validated against the same fixed program/argument allow-list; the JSON file is not an arbitrary command runner. OS changes are not a transaction: an abrupt process/machine failure can leave an intermediate external state that requires manual reconciliation.

SSH sessions use an isolated Unix process group; exit cleanup terminates only those owned groups, including inherited ProxyCommand children. Authentication success is distinct from forwarding initialization and remote egress. A temporary config survives as long as the child session. No private-key file content is read by NetDeck.

The gateway accepts 32 simultaneous clients, headers up to 16 KiB, 8 s setup, 1 h session maximum. HTTP upstream gets absolute-form HTTP requests; SOCKS5 gets an explicit protocol bridge. CONNECT is tunneled through either upstream. Switching the upstream at the same port affects new sessions; changing the listening port first binds the new listener, then shuts down the old one. An unsuccessful upstream check keeps the existing gateway. Health checks recur every 60 s while running. Shutdown cancels all connection tasks.

The menu bar opens the window, reports owned connection health and exits with cleanup. Closing the app does not roll back persistent system settings or install a background service. Minimum window 1100×700, themes via CSS tokens. React Flow remains under expandable discovery details rather than dominating the main dashboard.


## 0.3 daily surface

`App.tsx` is now the daily proxy + machines screen. The previous diagnostic workspace is lazy-loaded as `AdvancedApp.tsx` behind Settings. The daily UI composes existing typed backend plans into a reviewed sequence; confirmation remains explicit. Execution is serial and stops on the first error. Cancelled, unexecuted and failed preparation tokens are discarded through a bounded IPC command. A new optional/defaulted `route` field on tunnel definitions distinguishes public and SLAI prerequisites without changing old saved definitions. The default remains schema v2.

The UI never equates the SSH runtime state with remote Internet availability. Remote egress checks are timestamped and tied to the active session start, and expire after two minutes. Changing the selected proxy invalidates its prior check signature. Normal refresh is read-only; startup does not automatically connect saved machines.
