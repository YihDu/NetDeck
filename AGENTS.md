# NetDeck development

- Project root is `/Users/yihdu/Codefield/Tools/NetDeck` (user override).
- Use Git; commit coherent, tested changes. Never commit runtime reports, personal profiles, credentials, node_modules, or .tooling.
- User authorized controlled operations implementation. All network mutations require a one-use backend preview and explicit UI confirmation. During development, test mutations with mocks/loopback only; do not change the user’s actual network. Never alter SSH files or unrelated processes.
- Exclude Magpie, Windows remote administration and Transtar node switching.
- System commands belong in Rust, with fixed executable/argument lists, timeouts, output bounds, and redacted errors. No shell evaluation.
- Never read private keys. Ordinary SSH diagnosis rejects executable Match clauses; controlled-session previews must disable their entire blocks and disclose the semantic difference. Unsafe includes always fail closed before `ssh -G`.
- Historical examples are disabled until explicitly imported/enabled. Unknown is not healthy; stale results stay visibly stale.
- UI is Chinese-first. Keep observed/configured/historical/mock evidence distinct. Browser preview must clearly show that native backend is unavailable.
- Rust core is shared by desktop and CLI. Run relevant Rust/frontend tests and build before reporting completion.
- Record actual validation and limitations in docs/development-progress.md.
- For independent review tasks use the command-based `codex-gemini-subagent` read-only worker; the primary agent reviews findings.
