# NetDeck 0.2

macOS 本地网络与远程开发连接工作台。三个入口：**主面板、按场景处理、配置与记录**。没有账号或遥测。

用户确认排除：Magpie 网关/远端转发、Windows 远程管理、Transtar 内部节点切换。研究院 Windows 仍可作为用户指定的 Tailscale Peer / 代理目标检测。

## 打开

本机 Apple Silicon 构建：`target/release/bundle/macos/NetDeck.app`，Finder 双击即可。未做 Developer ID 发布签名或公证；Intel 未验证。

```bash
cd /Users/yihdu/Codefield/Tools/NetDeck
npm run tauri dev                 # 原生开发模式
npm run tauri build               # 生成 .app
npm run cli -- status --json      # 只读发现
npm run cli -- doctor             # 脱敏发现报告
npm run cli -- diagnose PROFILE_ID
```

`npm run dev` 只是浏览器界面预览，明确显示原生后端未连接，不伪造网络状态。项目采用 npm，Rust 工具链可使用项目 `.tooling/` 或系统安装版本；需要 Xcode Command Line Tools。

## 按你的工作流使用

1. **主面板**：发现实际系统 / Shell 代理、默认路由、监听端口、Tailscale 节点和 SSH 别名。添加实际连接并启用检查。每项分别显示配置、当前证据和下一步；旧配置的结果不会算作新配置正常。
2. **日常上网 / 换 Wi-Fi**：添加当前 HTTP 或 SOCKS5 代理，运行 TCP → 协议握手 → HTTPS 检查。选择已验证的上游，预览并启动稳定入口 `127.0.0.1:18080`。上游端口变化后更新 Profile，再预览切换。
3. **访问研究院 / SLAI**：确认 Tailscale 登录，按需预览连接和接受子网路由；将 Peer、共享代理、目标按顺序加入场景。上游失败会阻止后续请求。CIDR 归属与系统实际路由分别提供证据。
4. **连接 Coder / CCI**：使用已有 SSH 别名，检查有效配置，手动预览 SSH 认证。新增 -L / -R 隧道，选择“沿用 Config”或“明确覆盖”。不会修改原 SSH 文件。
5. **远端 Codex / GitHub 使用 Mac 代理**：启动稳定入口 → 建立远端 `10073 → Mac 127.0.0.1:18080` 的 -R 转发 → 点击远端出口验证 → 在远端 Shell 执行复制的代理变量 → 再启动 CLI。
6. **恢复**：隧道先停止再启动；系统代理和 Tailscale 设置在操作记录里“预览撤销”。若外部程序已更改同一设置，会拒绝覆盖。

所有变更：**后端预览 → 用户确认 → 一次执行 → 读取验证**。预览 5 分钟失效，进程或配置变化会要求重新预览。设置变更先将恢复快照写入磁盘。网关 / 隧道停止只影响本应用持有的资源。

## 功能与验证边界

| 功能 | 已实现的行为 | 验证边界 |
| --- | --- | --- |
| 本机发现 / Profile 诊断 | DNS、CIDR、路由、TCP、HTTP CONNECT、SOCKS5、HTTPS、Tailscale ping | 原有实机只读发现 + loopback 单元测试 |
| 主面板与场景向导 | 当前配置、检查时间、过期状态、证据、按依赖顺序检查 | Chrome 模拟原生 IPC 流程测试 |
| SSH 认证 / -L / -R | 冻结配置、两种转发策略、认证与初始化确认、失败原因、进程退出、停止 | 安全预处理与 `ssh -G` 测试；真实远端认证 / 转发待用户确认验证 |
| 稳定代理入口 | loopback HTTP / CONNECT，HTTP / SOCKS5 上游，切换新连接，上游每 60 秒检查，失败不直连 | 四种协议组合真实 loopback 收发 + 上游失效测试 |
| 系统代理 | 指定网络服务的 HTTP / HTTPS / SOCKS 设置、关闭、快照与撤销 | 参数 / 恢复命令边界测试；未更改本机系统代理作实测 |
| Tailscale 控制 | 连接、断开、接受路由、Exit Node、设置快照与撤销 | 已编译集成；未切换用户网络作实测 |
| 远端出口 | 经已选 SSH 别名执行固定 curl 检查，复制 Shell 环境变量 | 未对真实远端执行 |
| 菜单栏 / 记录 / CLI | 菜单栏打开与退出、托管状态提示、操作记录、脱敏诊断报告、只读 CLI | 编译与测试；原生菜单视觉检查未完成 |

## 明确限制

- 普通 SSH 只读诊断仍在发现 `Match exec` 时拒绝执行 `ssh -G`；受控认证 / 隧道会禁用这些条件块，并在预览警示，因此可能与终端动态选择的配置不同。
- Include 限制文件名、总大小、深度和循环。沿用模式只接受支持的 loopback TCP 转发，拒绝 DynamicForward / Unix socket / 重复远端端口；自定义覆盖模式去除原转发。远端 sshd 的 GatewayPorts 等策略仍由服务器管理员决定。
- ProxyCommand / ProxyJump 只在用户确认后使用已有配置。NetDeck 不读取或复制私钥；认证由系统 OpenSSH / ssh-agent 处理。新主机指纹需先在终端核验。转发初始化成功不等于远端业务正常。
- 网关不支持代理认证、PAC 执行、明文 HTTP 的 Upgrade / chunked 请求体；HTTPS 通过 CONNECT 透传。连接上限 32，请求头 16 KiB，握手 8 秒，单连接最长 1 小时。端口变化只提供发现、检查和确认切换，不自动修改全局设置。
- 系统代理保守地拒绝含认证或原代理地址为空、无法完整恢复的启用操作。首次配置地址请使用 macOS 设置；不使用 sudo。HTTP / HTTPS / SOCKS / PAC / Shell 是独立配置。
- `tailscale debug prefs` 不支持或无法准确恢复 Exit Node 时拒绝变更。未登录需在官方客户端登录。程序异常退出时不会自动改回系统设置；记录保留快照，撤销须核对当前状态，部分执行状态可能需在系统客户端恢复。
- Shell 环境仅代表应用继承值，不能读取其他终端后续设置。未声称证明 utun 一定属于 Tailscale，也不查看远端端口所有者。
- 不安装 launchd、自启动、Windows Agent；退出应用停止自建网关及 SSH 进程组，系统设置保持显式变更后的值，可在下次启动撤销。

## 本地数据与 Git

`~/Library/Application Support/NetDeck/`：`config.json`（v1 读取时迁移到 v2，下一次保存才写入）、诊断滚动日志、`operations.json`（最多 100 条操作和恢复快照）、`reports/`。临时文件原子写入、私有权限。报告保留 IP / 端口用于排障，不保存原始 ProxyCommand 或密钥路径。

本目录是独立 Git 仓库。构建产物、工具链、真实运行数据、依赖目录不提交。实际测试与未验证事项见 [开发记录](docs/development-progress.md)。

```bash
npm test
npm run test:core
npm run test:e2e
node scripts/tool.mjs cargo clippy --workspace --all-targets -- -D warnings
```
