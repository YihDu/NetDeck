# NetDeck

个人网络控制中心：macOS 桌面应用与共享 Rust 核心的 CLI。中文界面，本地优先，首版只读。

## 打开应用

本机已构建的应用位于 `target/release/bundle/macos/NetDeck.app`，可在 Finder 中双击打开。当前构建目标为 Apple Silicon；Intel 未实机验证。应用未做 Developer ID 发布签名或公证。

开发启动：

```bash
cd /Users/yihdu/Codefield/Tools/NetDeck
npm install
npm run tauri dev
```

此机器已有 Node 22 和 npm，未预装 pnpm，因此采用 npm 并提交 `package-lock.json`。Rust 工具链经授权安装在项目 `.tooling/`，`scripts/tool.mjs` 自动注入项目内环境，不修改 Shell 配置。其他机器可使用正常安装的 Rust。需 Xcode Command Line Tools。

```bash
npm run build                      # 前端生产构建
npm run tauri build                # 打包 macOS .app
npm run cli -- status --json       # 本机只读快照
npm run cli -- doctor              # 脱敏 JSON 报告（不主动探测远端）
npm run cli -- diagnose PROFILE_ID # 检测已启用的 Profile
```

桌面可执行文件叫 `netdeck-desktop`，CLI 叫 `netdeck`，避免 Cargo 工作区同名二进制冲突。CLI release 构建：`node scripts/tool.mjs cargo build -p netdeck-cli --release`。

## 首次使用

1. 打开总览，本机会发现系统/Shell 代理、默认路由、TCP 监听、Tailscale 和 SSH 别名。
2. 在「连接管理」添加 TCP、HTTPS、HTTP/SOCKS5 代理、SSH 或 Tailscale Profile。
3. 核对目标并勾选「确认目标并启用主动检测」，再点「诊断」。历史线索导入后保持禁用。
4. 在诊断中心展开每一步查看来源、耗时、时间和错误分类。
5. 在活动页复制或导出报告。分享前可自行检查其中保留的网络地址。

浏览器 `npm run dev` 只供界面预览，明确显示原生后端未连接，不提供真实网络探测，也不会用假数据填充状态。

## 已实现

- 七个页面、深浅主题、可交互拓扑与证据 Inspector。
- 只读系统代理/PAC/Bypass、进程继承的 Shell 代理、默认/目标路由、最多 128 条监听采样。
- Tailscale 路径发现、状态 JSON、已知设备、偏好读取（不支持时保持未知）、显式目标 direct/relay ping。
- SSH 明确别名静态发现；安全配置条件满足时通过 `ssh -G` 读取用户及系统有效配置、转发与重复监听端口风险。
- DNS、CIDR、TCP、HTTP CONNECT、SOCKS5 CONNECT、带证书校验的 HTTPS 分层诊断。
- Profile 增删改、本机定时刷新、可选定时主动诊断（默认关闭）、有限并发与取消。
- 过期状态、滚动日志、复制/导出脱敏报告、共享核心 CLI。

## 当前限制

- SSH `Match exec` 会执行命令：可以静态列出别名，但整个配置的 `ssh -G` 求值会被阻止。不要为使用 NetDeck 而修改现有 SSH 配置；可另建 TCP Profile 检测端口。
- Include 支持普通/带空格的引号路径和 glob，限制层数、数量与体积；仅读取名为 `config`、`ssh_config` 或以 `.conf`/`.config` 结尾的配置文件。变量、特殊路径及不安全文件名会明确拒绝。
- ProxyCommand/ProxyJump 不执行，不把直连 TCP 的结果冒充跳板路径结果。首版无 SSH 认证检查、远端命令执行或隧道启动/停止。
- 远端监听端口是否被其他进程占用，不能从本地 SSH 配置确定。只报告潜在重复风险。
- `utun` 接口不等于 Tailscale 路由；CIDR、Tailscale 已公布路由和系统实际路由分别展示，不声称已完成跨来源路由归属证明。
- 代理不支持认证或 PAC 脚本执行，HTTPS 不使用用户 Token、不跟随重定向。Shell 变量仅代表应用继承的环境。
- 无稳定本地网关、系统网络变更、Windows Agent、菜单栏或后台自启动。以上为后续 Stage 2/3 范围。

## 数据

`~/Library/Application Support/NetDeck/` 存储版本化 `config.json`、`activity.jsonl`、一份轮转日志和 `reports/`。配置以临时文件原子替换，日志约 1 MiB 轮转，读取最多 100 条。未支持的配置版本不自动覆盖。

从不读取 SSH 私钥内容；不保存 SSH 用户名、身份文件路径或原始 ProxyCommand。脱敏覆盖 URL 用户信息、query/fragment、常见凭据字段与用户目录前缀。报告保留 IP、端口、别名及设备名用于排障；不上传第三方。

## 验证

```bash
npm test
npm run test:core
npm run test:e2e
node scripts/tool.mjs cargo clippy --workspace --all-targets -- -D warnings
```

E2E 使用本机 Chrome。Mock IPC 仅通过测试的 `addInitScript` 注入，测试夹具显式标记 Mock；发布应用不包含模拟后端。测试使用回环服务验证端口开放但代理被拒绝等失败路径，不探测历史地址。

架构见 `docs/architecture.md`，诊断规则见 `docs/diagnostic-rules.md`，安全边界见 `docs/safety.md`，实际验证与后续工作见 `docs/development-progress.md`。
