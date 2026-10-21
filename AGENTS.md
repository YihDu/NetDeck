# NetDeck development

- Project root is `/Users/yihdu/Codefield/Tools/NetDeck` (user override).
- Use Git; commit coherent, tested changes. Never commit runtime reports, personal profiles, credentials, node_modules, or .tooling.
- Stage 1 is read-only. Never change system proxy, VPN, Tailscale, SSH configuration, routes, remote hosts, or unrelated processes.
- System commands belong in Rust, with fixed executable/argument lists, timeouts, output bounds, and redacted errors. No shell evaluation.
- Never read private keys. SSH config evaluation must reject executable Match clauses and unsafe includes before `ssh -G`.
- Historical examples are disabled until explicitly imported/enabled. Unknown is not healthy; stale results stay visibly stale.
- UI is Chinese-first. Keep observed/configured/historical/mock evidence distinct. Browser preview must clearly show that native backend is unavailable.
- Rust core is shared by desktop and CLI. Run relevant Rust/frontend tests and build before reporting completion.
- Record actual validation and limitations in docs/development-progress.md.
- For independent review tasks use the command-based `codex-gemini-subagent` read-only worker; the primary agent reviews findings.
