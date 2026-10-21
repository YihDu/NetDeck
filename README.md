# NetDeck 0.3

macOS 日常连接工具。首页只有 **Mac VPN 代理 + 常用机器列表**，没有侧边栏、拓扑或说明卡片。没有账号或遥测。

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

## 每天开机后

1. 看顶部 **Mac VPN 代理端口**，点“检测”；端口变了点“更换端口”。候选端口来自实际系统代理，其他监听端口可在选择框内展开查看。
2. 第一次点“添加机器”：填名字、选择已有 SSH 别名、选 **公网 / SLAI**。转发默认使用稳定入口，端口细节收在折叠区。
3. 点击单台“连接”，或勾选多台后“连接所选”。确认一次方案后，依次处理必要的 Tailscale 连接/路由、Mac 稳定入口、各台 SSH 反向转发、远端 curl 出口验证。
4. 看到 **远端网络可用** 再开始工作。需要时展开该机器的“使用与排障”，复制 SSH 命令或远端 Shell 代理设置。用完可单台或批量断开。

网络路径存进机器定义，不必每天切换模式。公网与 SLAI 机器可以同时连接。SLAI 沿用已有 SSH 地址/跳板；需要 Tailscale 连接或接受路由时会列入确认方案，登录仍须在官方客户端完成。

失败会停止后续步骤，保留已建立连接并说明原因，可单独断开。重连可先断开再连接。只有本次远端检查通过、隧道仍在运行且结果未过期时显示“远端网络可用”；仅 SSH 成功显示“已连接 · 出口待检查”。

顶部“设置”进入高级工具，原有系统代理控制、诊断证据、场景检查、拓扑与操作记录仍保留，但不再占据日常首页。机器定义兼容旧版，新加的访问方式缺省为公网。

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
