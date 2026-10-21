import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowRight,
  Check,
  ChevronRight,
  Copy,
  Globe2,
  LayoutDashboard,
  Plus,
  RefreshCw,
  Settings2,
  Shield,
  Terminal,
  Waypoints,
} from "lucide-react";
import { api, native } from "./lib/api";
import {
  profileSignature,
  clockTime,
  defaultConfig,
  freshProfile,
  healthLabels,
  historical,
  isStale,
  kindLabels,
  type Config,
  type Diagnostic,
  type Profile,
  type Snapshot,
  type Plan,
  type Operation,
  type RuntimeItem,
  type Receipt,
  type TunnelDefinition,
  type Workflow,
} from "./lib/types";
import { Button } from "./components/ui/button";
import { Sheet } from "./components/ui/sheet";
import { Status, EvidenceList } from "./components/Status";
import { ProfileForm } from "./components/ProfileForm";
const NetworkMap = lazy(() =>
  import("./components/NetworkMap").then((m) => ({ default: m.NetworkMap })),
);
import "./App.css";

type Page = "dashboard" | "scenarios" | "settings";
const scenes = [
  {
    id: "daily",
    title: "日常上网 / 换了 Wi-Fi",
    icon: Globe2,
    subtitle: "浏览器能上网，终端或 API 却不通？",
    steps: [
      [
        "确认当前出口",
        "看系统代理、PAC 与 Shell 代理是否指向同一有效端口。浏览器可用不代表终端沿用系统代理。",
      ],
      [
        "检查代理与 HTTPS",
        "添加实际 HTTP / SOCKS5 代理并启用检测。TCP → 协议握手 → HTTPS 必须分别通过。",
      ],
      [
        "固定入口，减少改端口",
        "选择通过检查的上游，启动 127.0.0.1:18080。以后上游变了，只需在这里预览切换。",
      ],
      [
        "按需设置系统或终端",
        "系统代理在高级控制里逐项预览。终端只复制下面的环境变量到需要使用代理的 Shell。",
      ],
    ],
  },
  {
    id: "slai",
    title: "访问研究院 / SLAI",
    icon: Shield,
    subtitle: "先到 Tailscale 节点，再确认目标子网与代理。",
    steps: [
      [
        "连接 Tailscale",
        "在主面板看本机连接状态；未登录时先到 Tailscale 官方客户端登录。已登录可在下方预览连接。",
      ],
      [
        "检查研究院 Peer",
        "从发现的节点中选择实际 IP，建立 Tailscale Profile。ping 结果会区分 direct / relay / 不可达。",
      ],
      [
        "确认接受路由与目标网段",
        "需要子网路由时预览开启 accept-routes。在目标 Profile 填入实际预期 CIDR；网段不包含目标时，开启路由也无法解决。",
      ],
      [
        "检查共享代理再访问 CCI",
        "把 Peer、共享代理、目标按依赖顺序加入场景检查。上游失败时后续步骤停在“前置未通过”。",
      ],
    ],
  },
  {
    id: "ssh",
    title: "连接 Coder / CCI",
    icon: Terminal,
    subtitle: "入口地址、SSH 配置、认证，逐项排查。",
    steps: [
      [
        "选择已有 SSH 别名",
        "在连接配置中添加 SSH Profile，选择本机发现的别名。动态 CCI 端口变更请先在原 SSH 配置中更正。",
      ],
      [
        "检查连接与生效配置",
        "普通诊断检查配置、TCP 和重复转发；包含跳板时会明确标记无法用直连结果代表整条路径。",
      ],
      [
        "单独验证 SSH 认证",
        "点击 SSH 认证并确认。只使用已有密钥 / ssh-agent，不保存密码；新主机指纹须先在终端核验。",
      ],
      [
        "建立需要的转发",
        "新增隧道，选择沿用 Config 或明确覆盖。本地 -L 用于访问远端服务；远端 -R 用于把 Mac 服务带到服务器。",
      ],
    ],
  },
  {
    id: "remote",
    title: "让远端 Codex / GitHub 使用 Mac 代理",
    icon: Waypoints,
    subtitle: "稳定入口 → SSH 反向转发 → 远端出口验证。",
    steps: [
      [
        "先让 Mac 代理可用",
        "选择上游并启动稳定入口 127.0.0.1:18080，或使用已验证的本地 HTTP 代理端口。",
      ],
      [
        "新建反向隧道",
        "选择 Coder / CCI 的 SSH 别名；方向选远端 -R；远端监听 10073，目标 127.0.0.1:18080。沿用 Config 时不重复追加 -R。",
      ],
      [
        "启动并看实际结果",
        "预览后确认。NetDeck 等待 SSH 认证与转发初始化；端口被占用时请更换端口或检查已有会话。",
      ],
      [
        "验证远端并设置当前 Shell",
        "隧道卡片里点击“远端出口验证”。验证通过后，在远端终端执行 HTTP_PROXY / HTTPS_PROXY 设置，再启动 Codex 或 Git。",
      ],
    ],
  },
];
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
export default function AdvancedApp() {
  const [page, setPage] = useState<Page>("settings");
  const [config, setConfig] = useState<Config>(defaultConfig);
  const [ready, setReady] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [results, setResults] = useState<Diagnostic[]>([]);
  const [runtime, setRuntime] = useState<RuntimeItem[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [services, setServices] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [tunnel, setTunnel] = useState<TunnelDefinition | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [detail, setDetail] = useState<{
    title: string;
    value: unknown;
  } | null>(null);
  const [evidence, setEvidence] = useState<Diagnostic | null>(null);
  const [scene, setScene] = useState("daily");
  const [service, setService] = useState("");
  const [protocol, setProtocol] = useState("webproxy");
  const [proxyHost, setProxyHost] = useState("127.0.0.1");
  const [proxyPort, setProxyPort] = useState(18080);
  const [exitNode, setExitNode] = useState("");
  const [testUrl, setTestUrl] = useState("https://example.com/");
  const [workflow, setWorkflow] = useState<Workflow>({
    id: "daily",
    label: "日常检查",
    profileIds: [],
  });
  const refreshLock = useRef(false);
  const checkLock = useRef(false);
  const refresh = useCallback(async () => {
    if (!native || refreshLock.current) return;
    refreshLock.current = true;
    try {
      const [s, r, o] = await Promise.all([
        api.snapshot(),
        api.runtime(),
        api.operations(),
      ]);
      setSnapshot(s);
      setRuntime(r);
      setReceipts(o);
    } catch (e) {
      setError(errorText(e));
    } finally {
      refreshLock.current = false;
    }
  }, []);
  useEffect(() => {
    if (!native) return;
    let alive = true;
    api
      .config()
      .then((c) => {
        if (alive) {
          setConfig(c);
          setReady(true);
        }
      })
      .catch((e) => setError(errorText(e)));
    api
      .history()
      .then((h) => {
        if (alive) setResults(h);
      })
      .catch((e) => setError(errorText(e)));
    api
      .services()
      .then((s) => {
        if (alive) {
          setServices(s);
          setService(s[0] ?? "");
        }
      })
      .catch((e) => setError(errorText(e)));
    void refresh();
    return () => {
      alive = false;
    };
  }, [refresh]);
  useEffect(() => {
    const timer = setInterval(
      () => void refresh(),
      config.preferences.refreshSeconds * 1000,
    );
    return () => clearInterval(timer);
  }, [refresh, config.preferences.refreshSeconds]);
  useEffect(() => {
    document.documentElement.dataset.theme = config.preferences.theme;
  }, [config.preferences.theme]);
  async function save(next: Config) {
    await api.save(next);
    setConfig(next);
    setNotice("配置已保存。保存配置不会自动连接。");
  }
  async function diagnose(profileId?: string, workflowId?: string) {
    if (checkLock.current) return;
    checkLock.current = true;
    setChecking(true);
    setError("");
    try {
      const r = workflowId
        ? await api.workflow(workflowId)
        : await api.diagnose(profileId);
      setResults((old) => [...r, ...old].slice(0, 100));
      if (profileId && r[0]) setEvidence(r[0]);
    } catch (e) {
      setError(errorText(e));
    } finally {
      checkLock.current = false;
      setChecking(false);
    }
  }
  useEffect(() => {
    if (!ready || !config.preferences.autoDiagnose) return;
    const timer = setInterval(
      () => void diagnose(),
      config.preferences.diagnoseSeconds * 1000,
    );
    return () => clearInterval(timer);
  }, [
    ready,
    config.preferences.autoDiagnose,
    config.preferences.diagnoseSeconds,
  ]);
  async function action(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function preview(request: Operation) {
    await action(async () => setPlan(await api.preview(request)));
  }
  async function execute() {
    if (!plan) return;
    const id = plan.id;
    setPlan(null);
    await action(async () => {
      const r = await api.execute(id);
      setNotice(r.success ? r.detail : "");
      if (!r.success) setError(r.detail);
      await refresh();
    });
  }
  useEffect(() => {
    const saved = config.controls.workflows.find((w) => w.id === scene);
    if (saved) setWorkflow(saved);
  }, [config.controls.workflows, scene]);
  const currentResults = results.filter((r) => {
    const p = config.profiles.find((p) => p.id === r.profileId);
    return p && r.profileSignature === profileSignature(p);
  });
  const latest = (id: string) => currentResults.find((r) => r.profileId === id);
  const enabled = config.profiles.filter((p) => p.enabled);
  const usable = native && ready && !busy;
  const selectedScene = scenes.find((s) => s.id === scene)!;
  const openScenario = (id: string) => {
    setScene(id);
    setPage("scenarios");
    const existing = config.controls.workflows.find((w) => w.id === id);
    setWorkflow(
      existing ?? {
        id,
        label: scenes.find((s) => s.id === id)!.title,
        profileIds: [],
      },
    );
  };
  const startTunnel = (t: TunnelDefinition) => {
    const { label: _, route: _route, ...rest } = t;
    void preview({ kind: "tunnel-start", ...rest });
  };
  const gatewayStart = () =>
    void preview({
      kind: "gateway-start",
      profileId: config.controls.gatewayProfileId,
      port: config.controls.gatewayPort,
    });
  const newTunnel = () =>
    setTunnel({
      id: crypto.randomUUID(),
      label: "远端代理",
      alias:
        config.profiles.find((p) => p.kind === "ssh")?.sshAlias ??
        snapshot?.sshAliases[0] ??
        "",
      direction: "remote",
      listenPort: 10073,
      targetHost: "127.0.0.1",
      targetPort: config.controls.gatewayPort,
      reuseConfig: false,
    });
  const endpoint = (p: Profile) =>
    p.kind === "ssh"
      ? p.sshAlias
      : p.kind === "https"
        ? p.testUrl
        : `${p.host}:${p.port}`;
  const copyShell = async (port: number) => {
    await navigator.clipboard.writeText(
      `export HTTP_PROXY=http://127.0.0.1:${port}\nexport HTTPS_PROXY=http://127.0.0.1:${port}\nexport http_proxy="$HTTP_PROXY"\nexport https_proxy="$HTTPS_PROXY"`,
    );
    setNotice(
      "已复制当前 Shell 的代理设置。撤销：unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy",
    );
  };
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Waypoints size={23} />
          </span>
          <div>
            NetDeck<small>你的连接工作台</small>
          </div>
        </div>
        <nav>
          {(
            [
              { id: "dashboard", label: "主面板", icon: LayoutDashboard },
              { id: "scenarios", label: "按场景处理", icon: Waypoints },
              { id: "settings", label: "配置与记录", icon: Settings2 },
            ] as const
          ).map((n) => (
            <button
              key={n.id}
              className={page === n.id ? "nav-item active" : "nav-item"}
              onClick={() => setPage(n.id)}
            >
              <n.icon size={18} />
              {n.label}
              <ChevronRight size={14} />
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="live-dot" />
          本地运行 · 明确确认
          <small>
            连接与检查各自独立。
            <br />
            关闭应用会停止自建隧道与网关；系统设置可在记录里撤销。
          </small>
        </div>
      </aside>
      <main>
        <header>
          <span className="breadcrumb">
            工作台 /{" "}
            {page === "dashboard"
              ? "主面板"
              : page === "scenarios"
                ? "按场景处理"
                : "配置与记录"}
          </span>
          <div className="row">
            <span className="muted">{clockTime(snapshot?.capturedAt)}</span>
            <Button
              variant="ghost"
              disabled={!native || busy}
              onClick={() => void refresh()}
              aria-label="刷新本机状态"
            >
              <RefreshCw size={16} />
            </Button>
            <Button
              disabled={!usable || checking || !enabled.length}
              onClick={() => void diagnose()}
            >
              {checking ? "检查中…" : "检查全部连接"}
            </Button>
            {checking && (
              <Button
                variant="secondary"
                onClick={() => void action(api.cancel)}
              >
                取消检查
              </Button>
            )}
          </div>
        </header>
        <div className="content">
          {!native && (
            <div className="notice">
              原生后端未连接。浏览器仅展示界面；请运行 NetDeck
              桌面应用进行检测与操作。
            </div>
          )}
          {error && (
            <div role="alert" className="notice error">
              {error}
              <button onClick={() => setError("")}>关闭</button>
            </div>
          )}
          {notice && (
            <div role="status" className="notice success">
              {notice}
              <button onClick={() => setNotice("")}>关闭</button>
            </div>
          )}
          {busy && (
            <div className="notice">
              正在准备或执行操作，请稍候。SSH 检查最多约 15
              秒，网关启动前会先验证出口。
            </div>
          )}
          {page === "dashboard" && (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">YOUR NETWORK, AT A GLANCE</span>
                  <h1>现在，连接是否就绪？</h1>
                  <p>配置告诉你走哪条路，检测告诉你这条路是否可用。</p>
                </div>
                <Button
                  variant="secondary"
                  disabled={!usable}
                  onClick={() => setProfile(freshProfile())}
                >
                  <Plus size={16} />
                  添加连接
                </Button>
              </div>
              <div className="summary-grid">
                <button
                  className="summary-card"
                  onClick={() =>
                    setDetail({ title: "本机网络与代理", value: snapshot })
                  }
                >
                  <Globe2 size={20} />
                  <small>本机出口</small>
                  <strong>
                    {snapshot?.defaultRoute.interface ?? "尚未发现"}
                  </strong>
                  <span>
                    {snapshot
                      ? `系统代理 ${snapshot.systemProxy.endpoints.filter((p) => p.enabled).length} 项 · PAC ${snapshot.systemProxy.pacEnabled ? "开启" : "关闭"}`
                      : "等待原生检测"}
                  </span>
                </button>
                <button
                  className="summary-card"
                  onClick={() => openScenario("daily")}
                >
                  <Shield size={20} />
                  <small>连接检查</small>
                  <strong>
                    {
                      enabled.filter(
                        (p) =>
                          latest(p.id)?.status === "healthy" &&
                          !isStale(latest(p.id)?.finishedAt),
                      ).length
                    }{" "}
                    / {enabled.length}
                    <em>已验证</em>
                  </strong>
                  <span>超过 2 分钟的检测不计入正常</span>
                </button>
                <button
                  className="summary-card"
                  onClick={() => openScenario("slai")}
                >
                  <Waypoints size={20} />
                  <small>Tailscale</small>
                  <strong>{snapshot?.tailscale?.state ?? "未知"}</strong>
                  <span>
                    {snapshot?.tailscale
                      ? `路由接收 ${snapshot.tailscale.acceptRoutes === null ? "未知" : snapshot.tailscale.acceptRoutes ? "开" : "关"} · Exit Node ${snapshot.tailscale.exitNode || "无"}`
                      : "安装并登录后刷新"}
                  </span>
                </button>
                <button
                  className="summary-card"
                  onClick={() => openScenario("remote")}
                >
                  <Terminal size={20} />
                  <small>NetDeck 托管</small>
                  <strong>
                    {runtime.filter((r) => r.status === "healthy").length}
                    <em>状态正常</em>
                  </strong>
                  <span>网关与隧道 · 远端出口单独验证</span>
                </button>
              </div>
              <section className="panel">
                <div className="section-heading">
                  <div>
                    <h2>我的连接</h2>
                    <p>每一项都有配置、实际结果与下一步。</p>
                  </div>
                  <Button variant="ghost" onClick={() => setPage("settings")}>
                    管理配置
                    <ArrowRight size={15} />
                  </Button>
                </div>
                {!config.profiles.length ? (
                  <div className="empty">
                    <div className="empty-icon">
                      <Plus size={24} />
                    </div>
                    <h3>先添加你工作中使用的连接</h3>
                    <p>
                      从本机 SSH 别名、实际代理端口或 Tailscale
                      节点开始。不会自动连接历史地址。
                    </p>
                    <Button
                      disabled={!usable}
                      onClick={() => setProfile(freshProfile())}
                    >
                      添加第一个连接
                    </Button>
                  </div>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>连接 / 配置</th>
                          <th>实际检查</th>
                          <th>下一步</th>
                          <th>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {config.profiles.map((p) => {
                          const d = latest(p.id);
                          const stale = isStale(d?.finishedAt);
                          const issue = d?.steps.find(
                            (s) =>
                              s.status === "down" ||
                              s.status === "degraded" ||
                              s.status === "unknown",
                          );
                          return (
                            <tr key={p.id}>
                              <td>
                                <strong>{p.label}</strong>
                                <code>{endpoint(p)}</code>
                                <small>
                                  {kindLabels[p.kind]} ·{" "}
                                  {p.enabled ? "已启用" : "未启用检测"}
                                </small>
                              </td>
                              <td>
                                <Status
                                  status={
                                    p.enabled
                                      ? (d?.status ?? "unknown")
                                      : "not-configured"
                                  }
                                  stale={stale}
                                />
                                <small>{clockTime(d?.finishedAt)}</small>
                              </td>
                              <td>
                                <span className="next-step">
                                  {!p.enabled
                                    ? "确认地址，编辑并启用"
                                    : !d || stale
                                      ? "运行一次检查，获取当前证据"
                                      : (issue?.summary ??
                                        "检查通过；使用时仍以应用响应为准")}
                                </span>
                              </td>
                              <td>
                                <div className="row">
                                  <Button
                                    size="sm"
                                    variant="secondary"
                                    disabled={!usable || checking || !p.enabled}
                                    onClick={() => void diagnose(p.id)}
                                  >
                                    检查
                                  </Button>
                                  {d && (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => setEvidence(d)}
                                    >
                                      证据
                                    </Button>
                                  )}
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={!usable}
                                    onClick={() => setProfile(p)}
                                  >
                                    编辑
                                  </Button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
              <section>
                <div className="section-heading">
                  <div>
                    <h2>今天要做什么？</h2>
                    <p>按你的工作顺序处理，不必从零排查。</p>
                  </div>
                </div>
                <div className="scene-grid">
                  {scenes.map((s) => (
                    <button
                      className="scene-card"
                      key={s.id}
                      onClick={() => openScenario(s.id)}
                    >
                      <s.icon size={20} />
                      <div>
                        <strong>{s.title}</strong>
                        <p>{s.subtitle}</p>
                      </div>
                      <ArrowRight size={17} />
                    </button>
                  ))}
                </div>
              </section>
              {runtime.length > 0 && (
                <section className="panel">
                  <div className="section-heading">
                    <h2>正在管理的连接</h2>
                  </div>
                  {runtime.map((r) => (
                    <div className="runtime-row" key={r.id}>
                      <div>
                        <strong>{r.label}</strong>
                        <p>{r.detail}</p>
                      </div>
                      <Status status={r.status} />
                      <Button
                        variant="secondary"
                        disabled={!usable}
                        onClick={() =>
                          void preview(
                            r.id === "gateway"
                              ? { kind: "gateway-stop" }
                              : { kind: "tunnel-stop", id: r.id },
                          )
                        }
                      >
                        停止…
                      </Button>
                    </div>
                  ))}
                </section>
              )}
              <details className="panel">
                <summary>
                  本机发现与网络拓扑{" "}
                  <span className="muted">
                    查看代理、监听端口、Tailscale 节点和检测证据
                  </span>
                </summary>
                <div className="discovery-grid">
                  <div>
                    <h3>系统代理</h3>
                    {snapshot?.systemProxy.endpoints.map((p, i) => (
                      <p key={i}>
                        <code>
                          {p.protocol} {p.host}:{p.port}
                        </code>{" "}
                        · {p.enabled ? "已开启" : "已关闭"}
                      </p>
                    ))}
                    <h3>当前应用继承的 Shell 代理</h3>
                    <pre>
                      {JSON.stringify(snapshot?.shellProxy ?? {}, null, 2)}
                    </pre>
                    <small>桌面应用无法读取其他终端后续修改的环境变量。</small>
                  </div>
                  <div>
                    <h3>Tailscale 节点</h3>
                    {snapshot?.tailscale?.peers.map((p) => (
                      <div className="peer" key={p.name}>
                        <strong>{p.name}</strong>
                        <small>
                          {p.ips.join(", ")} ·{" "}
                          {p.online ? "在线记录，尚需 ping" : "离线记录"}
                        </small>
                        <small>宣告路由：{p.routes.join(", ") || "无"}</small>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!usable}
                          onClick={() =>
                            setProfile({
                              ...freshProfile(),
                              label: p.name,
                              kind: "tailscale",
                              host: p.ips[0] ?? "",
                              port: 22,
                            })
                          }
                        >
                          添加为检查目标
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
                <EvidenceList steps={snapshot?.evidence ?? []} />
                <div className="map-container">
                  <Suspense fallback={<p className="muted">加载网络拓扑…</p>}>
                    <NetworkMap
                      snapshot={snapshot}
                      profiles={config.profiles}
                      results={currentResults}
                      onInspect={(title, value) => setDetail({ title, value })}
                    />
                  </Suspense>
                </div>
              </details>
            </>
          )}
          {page === "scenarios" && (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">A CLEAR NEXT STEP</span>
                  <h1>从你要做的事开始。</h1>
                  <p>先检查前置条件，再连接，最后验证实际出口。</p>
                </div>
              </div>
              <div className="scene-tabs">
                {scenes.map((s) => (
                  <button
                    className={scene === s.id ? "selected" : ""}
                    key={s.id}
                    onClick={() => openScenario(s.id)}
                  >
                    {s.title}
                  </button>
                ))}
              </div>
              <section className="panel guide">
                <div className="section-heading">
                  <div>
                    <h2>{selectedScene.title}</h2>
                    <p>{selectedScene.subtitle}</p>
                  </div>
                  <selectedScene.icon size={26} />
                </div>
                <div className="guide-steps">
                  {selectedScene.steps.map(([title, description], i) => (
                    <div className="guide-step" key={title}>
                      <span className="step-index">{i + 1}</span>
                      <div>
                        <h3>{title}</h3>
                        <p>{description}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
              <section className="panel">
                <div className="section-heading">
                  <div>
                    <h2>这条路径的检查顺序</h2>
                    <p>
                      选择已启用连接。按添加顺序检查；前一步未通过时，不请求后续目标。
                    </p>
                  </div>
                  <Button
                    disabled={
                      !usable ||
                      checking ||
                      !config.controls.workflows.find((w) => w.id === scene)
                        ?.profileIds.length
                    }
                    onClick={() => void diagnose(undefined, scene)}
                  >
                    检查已保存路径
                  </Button>
                </div>
                <div className="workflow-path">
                  {workflow.profileIds.map((id, i) => (
                    <div className="path-step" key={id}>
                      <span>{i + 1}</span>
                      <strong>
                        {config.profiles.find((p) => p.id === id)?.label ?? id}
                      </strong>
                      <Status
                        status={latest(id)?.status ?? "unknown"}
                        stale={isStale(latest(id)?.finishedAt)}
                      />
                      <button
                        aria-label={`移除步骤 ${i + 1}`}
                        onClick={() =>
                          setWorkflow({
                            ...workflow,
                            profileIds: workflow.profileIds.filter(
                              (x) => x !== id,
                            ),
                          })
                        }
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
                <div className="row">
                  <select
                    aria-label="添加检查步骤"
                    value=""
                    onChange={(e) =>
                      e.target.value &&
                      setWorkflow({
                        ...workflow,
                        profileIds: [...workflow.profileIds, e.target.value],
                      })
                    }
                  >
                    <option value="">添加一个前置 / 目标连接…</option>
                    {enabled
                      .filter((p) => !workflow.profileIds.includes(p.id))
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                  </select>
                  <Button
                    variant="secondary"
                    disabled={!usable}
                    onClick={() =>
                      void action(() =>
                        save({
                          ...config,
                          controls: {
                            ...config.controls,
                            workflows: [
                              ...config.controls.workflows.filter(
                                (w) => w.id !== scene,
                              ),
                              workflow,
                            ],
                          },
                        }),
                      )
                    }
                  >
                    保存检查顺序
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={!usable}
                    onClick={() => setProfile(freshProfile())}
                  >
                    添加连接
                  </Button>
                </div>
                {workflow.profileIds.map((id) => {
                  const d = latest(id);
                  return (
                    d && (
                      <details className="workflow-result" key={id}>
                        <summary>
                          {d.label} · {healthLabels[d.status]} ·{" "}
                          {clockTime(d.finishedAt)}
                        </summary>
                        <EvidenceList steps={d.steps} />
                      </details>
                    )
                  );
                })}
              </section>
              {(scene === "daily" || scene === "remote") && (
                <section className="panel">
                  <div className="section-heading">
                    <div>
                      <h2>稳定代理入口</h2>
                      <p>
                        仅监听 Mac 的 127.0.0.1；支持 HTTP / SOCKS5
                        上游，上游不可用时返回失败。
                      </p>
                    </div>
                    <Status
                      status={
                        runtime.find((r) => r.id === "gateway")?.status ??
                        "not-configured"
                      }
                    />
                  </div>
                  <div className="form-row">
                    <label>
                      实际上游代理
                      <select
                        value={config.controls.gatewayProfileId}
                        disabled={!usable}
                        onChange={(e) =>
                          void action(() =>
                            save({
                              ...config,
                              controls: {
                                ...config.controls,
                                gatewayProfileId: e.target.value,
                              },
                            }),
                          )
                        }
                      >
                        <option value="">选择已启用的代理 Profile</option>
                        {enabled
                          .filter(
                            (p) =>
                              p.kind === "http-proxy" ||
                              p.kind === "socks5-proxy",
                          )
                          .map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.label} · {p.host}:{p.port}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label>
                      固定本地端口
                      <input
                        type="number"
                        min={1024}
                        max={65535}
                        defaultValue={config.controls.gatewayPort}
                        key={config.controls.gatewayPort}
                        disabled={!usable}
                        onBlur={(e) => {
                          const port = Number(e.target.value);
                          if (port !== config.controls.gatewayPort)
                            void action(() =>
                              save({
                                ...config,
                                controls: {
                                  ...config.controls,
                                  gatewayPort: port,
                                },
                              }),
                            );
                        }}
                      />
                    </label>
                  </div>
                  <div className="row">
                    <Button
                      disabled={!usable || !config.controls.gatewayProfileId}
                      onClick={gatewayStart}
                    >
                      预览启动 / 切换
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={
                        !usable || !runtime.some((r) => r.id === "gateway")
                      }
                      onClick={() => void preview({ kind: "gateway-stop" })}
                    >
                      停止…
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() =>
                        void action(() =>
                          copyShell(config.controls.gatewayPort),
                        )
                      }
                    >
                      <Copy size={15} />
                      复制 Mac Shell 设置
                    </Button>
                  </div>
                  <p className="hint">
                    只改当前终端：执行复制的 export 后再启动 CLI。退出该终端或
                    unset 对应变量即可恢复。稳定入口不自动更改系统代理。
                  </p>
                </section>
              )}
              {scene === "slai" && (
                <section className="panel">
                  <div className="section-heading">
                    <div>
                      <h2>Tailscale 本机控制</h2>
                      <p>
                        当前 {snapshot?.tailscale?.state ?? "未知"} · 接受路由{" "}
                        {snapshot?.tailscale?.acceptRoutes === true
                          ? "开启"
                          : snapshot?.tailscale?.acceptRoutes === false
                            ? "关闭"
                            : "未知"}
                      </p>
                    </div>
                  </div>
                  <div className="row">
                    <Button
                      disabled={!usable}
                      onClick={() =>
                        void preview({
                          kind: "tailscale",
                          setting: "connected",
                          value: "true",
                        })
                      }
                    >
                      预览连接
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={!usable}
                      onClick={() =>
                        void preview({
                          kind: "tailscale",
                          setting: "connected",
                          value: "false",
                        })
                      }
                    >
                      预览断开
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={!usable}
                      onClick={() =>
                        void preview({
                          kind: "tailscale",
                          setting: "accept-routes",
                          value: snapshot?.tailscale?.acceptRoutes
                            ? "false"
                            : "true",
                        })
                      }
                    >
                      预览{snapshot?.tailscale?.acceptRoutes ? "关闭" : "开启"}
                      接受路由
                    </Button>
                  </div>
                  <p className="hint">
                    Tailscale 连接成功不代表研究院服务可达。继续检查
                    Peer、CIDR、系统路由与共享代理。
                  </p>
                </section>
              )}
              {(scene === "ssh" || scene === "remote") && (
                <section className="panel">
                  <div className="section-heading">
                    <div>
                      <h2>SSH 认证与端口转发</h2>
                      <p>
                        多个隧道可以并行运行；停止操作只影响 NetDeck
                        创建的进程。
                      </p>
                    </div>
                    <Button disabled={!usable} onClick={newTunnel}>
                      <Plus size={16} />
                      新增隧道
                    </Button>
                  </div>
                  <div className="row wrap">
                    {enabled
                      .filter((p) => p.kind === "ssh")
                      .map((p) => (
                        <Button
                          key={p.id}
                          variant="secondary"
                          disabled={!usable}
                          onClick={() =>
                            void preview({
                              kind: "ssh-auth",
                              alias: p.sshAlias,
                            })
                          }
                        >
                          验证 {p.label} 的 SSH 认证…
                        </Button>
                      ))}
                  </div>
                  {!config.controls.tunnels.length && (
                    <p className="empty-inline">
                      还没有隧道。远端需要使用 Mac 代理时，新增一个远端 -R
                      转发。
                    </p>
                  )}
                  {config.controls.tunnels.map((t) => {
                    const r = runtime.find((r) => r.id === t.id);
                    return (
                      <article className="tunnel-card" key={t.id}>
                        <div className="section-heading">
                          <div>
                            <h3>{t.label}</h3>
                            <code>
                              {t.alias} ·{" "}
                              {t.reuseConfig
                                ? "沿用 SSH Config"
                                : `${t.direction === "remote" ? "远端 -R" : "本地 -L"} 127.0.0.1:${t.listenPort} → ${t.targetHost}:${t.targetPort}`}
                            </code>
                          </div>
                          <Status status={r?.status ?? "not-configured"} />
                        </div>
                        <p>{r?.detail ?? "已保存定义，尚未启动。"}</p>
                        <div className="row wrap">
                          <Button
                            disabled={!usable || r?.status === "healthy"}
                            onClick={() => startTunnel(t)}
                          >
                            预览启动
                          </Button>
                          <Button
                            variant="secondary"
                            disabled={!usable || !r || r.status === "down"}
                            onClick={() =>
                              void preview({ kind: "tunnel-stop", id: t.id })
                            }
                          >
                            停止…
                          </Button>
                          <Button
                            variant="ghost"
                            disabled={!usable}
                            onClick={() => setTunnel(t)}
                          >
                            编辑
                          </Button>
                          {t.direction === "remote" && (
                            <>
                              <Button
                                variant="secondary"
                                disabled={!usable}
                                onClick={() =>
                                  void preview({
                                    kind: "remote-check",
                                    alias: t.alias,
                                    port: t.listenPort,
                                    url: testUrl,
                                  })
                                }
                              >
                                远端出口验证…
                              </Button>
                              <Button
                                variant="ghost"
                                onClick={() =>
                                  void action(() => copyShell(t.listenPort))
                                }
                              >
                                复制远端 Shell 设置
                              </Button>
                            </>
                          )}
                        </div>
                        <small>
                          重新启动：先停止，确认退出后再预览启动。沿用 Config
                          时，远端出口验证仍使用本定义填写的端口。
                        </small>
                      </article>
                    );
                  })}
                  <label>
                    远端出口验证 URL
                    <input
                      type="url"
                      value={testUrl}
                      onChange={(e) => setTestUrl(e.target.value)}
                    />
                  </label>
                  <small>
                    HTTPS、无认证，不跟随重定向。远端必须已安装 curl。
                  </small>
                </section>
              )}
              <details className="panel">
                <summary>遇到失败时，下一步怎么做？</summary>
                <div className="troubleshooting">
                  <p>
                    <strong>代理端口变了：</strong>
                    在主面板的本机发现里查监听端口，更新代理 Profile
                    并检查三层结果，再切换稳定入口上游。
                  </p>
                  <p>
                    <strong>远端 10073 被占用：</strong>
                    停止本应用旧隧道，或换用新的远端端口。已有其他终端 SSH
                    会话请自行确认，NetDeck 不会结束它们。
                  </p>
                  <p>
                    <strong>SSH 认证失败：</strong>先核验目标主机指纹，确认
                    ssh-agent 中已有授权密钥；含 Match exec
                    的条件在受控会话中被跳过。
                  </p>
                  <p>
                    <strong>换 Wi-Fi 后不通：</strong>刷新本机出口 → 检查
                    Tailscale → 检查上游代理 → 重新检查
                    SSH。按路径逐项处理，不盲目重连全部。
                  </p>
                  <p>
                    <strong>改设置后更糟：</strong>
                    到“配置与记录”选择最近操作的“预览撤销”。如果外部客户端已更改同一设置，先核对当前值再处理。
                  </p>
                </div>
              </details>
            </>
          )}
          {page === "settings" && (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">CONFIGURATION & HISTORY</span>
                  <h1>配置清楚，每一步可追溯。</h1>
                  <p>所有设置保存在本机。系统变更先预览，执行后检查。</p>
                </div>
              </div>
              <section className="panel">
                <div className="section-heading">
                  <div>
                    <h2>连接配置</h2>
                    <p>地址来自你的确认；历史样例默认不启用。</p>
                  </div>
                  <Button
                    disabled={!usable}
                    onClick={() => setProfile(freshProfile())}
                  >
                    添加连接
                  </Button>
                </div>
                {config.profiles.map((p) => (
                  <div className="config-row" key={p.id}>
                    <div>
                      <strong>{p.label}</strong>
                      <small>{endpoint(p)}</small>
                    </div>
                    <span>{p.enabled ? "启用" : "停用"}</span>
                    <Button
                      variant="ghost"
                      disabled={!usable}
                      onClick={() => setProfile(p)}
                    >
                      编辑
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={!usable}
                      onClick={() =>
                        void action(() =>
                          save({
                            ...config,
                            profiles: config.profiles.filter(
                              (x) => x.id !== p.id,
                            ),
                            controls: {
                              ...config.controls,
                              workflows: config.controls.workflows.map((w) => ({
                                ...w,
                                profileIds: w.profileIds.filter(
                                  (id) => id !== p.id,
                                ),
                              })),
                              gatewayProfileId:
                                config.controls.gatewayProfileId === p.id
                                  ? ""
                                  : config.controls.gatewayProfileId,
                            },
                          }),
                        )
                      }
                    >
                      删除
                    </Button>
                  </div>
                ))}
                <details>
                  <summary>从历史线索建立配置（未验证）</summary>
                  <div className="row wrap">
                    {historical.map((p) => (
                      <Button
                        key={p.id}
                        variant="secondary"
                        disabled={!usable}
                        onClick={() =>
                          setProfile({ ...p, id: crypto.randomUUID() })
                        }
                      >
                        {p.label}
                      </Button>
                    ))}
                  </div>
                </details>
              </section>
              <section className="panel">
                <div className="section-heading">
                  <div>
                    <h2>显示与检查</h2>
                    <p>自动检查仅对已启用的目标发起请求。</p>
                  </div>
                </div>
                <div className="form-row">
                  <label>
                    主题
                    <select
                      value={config.preferences.theme}
                      disabled={!usable}
                      onChange={(e) =>
                        void action(() =>
                          save({
                            ...config,
                            preferences: {
                              ...config.preferences,
                              theme: e.target.value as "dark" | "light",
                            },
                          }),
                        )
                      }
                    >
                      <option value="dark">深色</option>
                      <option value="light">浅色</option>
                    </select>
                  </label>
                  <label>
                    本机刷新周期（秒）
                    <input
                      type="number"
                      min={10}
                      max={300}
                      key={config.preferences.refreshSeconds}
                      defaultValue={config.preferences.refreshSeconds}
                      disabled={!usable}
                      onBlur={(e) => {
                        if (
                          Number(e.target.value) !==
                          config.preferences.refreshSeconds
                        )
                          void action(() =>
                            save({
                              ...config,
                              preferences: {
                                ...config.preferences,
                                refreshSeconds: Number(e.target.value),
                              },
                            }),
                          );
                      }}
                    />
                  </label>
                  <label>
                    主动检测周期（秒）
                    <input
                      type="number"
                      min={30}
                      max={3600}
                      key={config.preferences.diagnoseSeconds}
                      defaultValue={config.preferences.diagnoseSeconds}
                      disabled={!usable}
                      onBlur={(e) => {
                        if (
                          Number(e.target.value) !==
                          config.preferences.diagnoseSeconds
                        )
                          void action(() =>
                            save({
                              ...config,
                              preferences: {
                                ...config.preferences,
                                diagnoseSeconds: Number(e.target.value),
                              },
                            }),
                          );
                      }}
                    />
                  </label>
                </div>
                <label className="check-label">
                  <input
                    type="checkbox"
                    disabled={!usable}
                    checked={config.preferences.autoDiagnose}
                    onChange={(e) =>
                      void action(() =>
                        save({
                          ...config,
                          preferences: {
                            ...config.preferences,
                            autoDiagnose: e.target.checked,
                          },
                        }),
                      )
                    }
                  />
                  定时主动检查已启用的目标
                </label>
              </section>
              <details className="panel">
                <summary>
                  高级控制 · macOS 系统代理 / Tailscale Exit Node
                </summary>
                <div className="advanced">
                  <h3>系统代理</h3>
                  <p>
                    一次只修改所选服务的一种代理。HTTP、HTTPS、SOCKS、PAC
                    与终端环境变量互相独立。
                  </p>
                  <div className="form-row">
                    <label>
                      网络服务
                      <select
                        value={service}
                        onChange={(e) => setService(e.target.value)}
                      >
                        {services.length ? (
                          services.map((s) => <option key={s}>{s}</option>)
                        ) : (
                          <option value="">原生后端读取后可用</option>
                        )}
                      </select>
                    </label>
                    <label>
                      代理类型
                      <select
                        value={protocol}
                        onChange={(e) => setProtocol(e.target.value)}
                      >
                        <option value="webproxy">HTTP</option>
                        <option value="securewebproxy">HTTPS</option>
                        <option value="socksfirewallproxy">SOCKS</option>
                      </select>
                    </label>
                    <label>
                      主机
                      <input
                        value={proxyHost}
                        onChange={(e) => setProxyHost(e.target.value)}
                      />
                    </label>
                    <label>
                      端口
                      <input
                        type="number"
                        min={1}
                        max={65535}
                        value={proxyPort}
                        onChange={(e) => setProxyPort(Number(e.target.value))}
                      />
                    </label>
                  </div>
                  <div className="row">
                    <Button
                      disabled={!usable || !service}
                      onClick={() =>
                        void preview({
                          kind: "system-proxy",
                          service,
                          protocol,
                          host: proxyHost,
                          port: proxyPort,
                          enabled: true,
                        })
                      }
                    >
                      预览设置代理
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={!usable || !service}
                      onClick={() =>
                        void preview({
                          kind: "system-proxy",
                          service,
                          protocol,
                          host: proxyHost,
                          port: proxyPort,
                          enabled: false,
                        })
                      }
                    >
                      预览关闭代理
                    </Button>
                  </div>
                  <h3>Tailscale Exit Node</h3>
                  <p>
                    会改变 Tailscale 出口。通常访问研究院子网只需接受路由，无需
                    Exit Node。
                  </p>
                  <label>
                    已授权出口节点 IP（留空关闭）
                    <input
                      value={exitNode}
                      onChange={(e) => setExitNode(e.target.value)}
                      placeholder="100.x.x.x"
                    />
                  </label>
                  <Button
                    disabled={!usable}
                    onClick={() =>
                      void preview({
                        kind: "tailscale",
                        setting: "exit-node",
                        value: exitNode,
                      })
                    }
                  >
                    预览 Exit Node 变更
                  </Button>
                </div>
              </details>
              <section className="panel">
                <div className="section-heading">
                  <div>
                    <h2>操作记录</h2>
                    <p>
                      系统设置可在状态未被外部更改时撤销。网关和隧道请在场景中停止。
                    </p>
                  </div>
                </div>
                {!receipts.length ? (
                  <p className="empty-inline">尚未执行操作。</p>
                ) : (
                  receipts.map((r) => (
                    <div className="receipt" key={r.id}>
                      <div>
                        <strong>
                          {r.success ? <Check size={15} /> : null}
                          {r.title}
                        </strong>
                        <p>{r.detail}</p>
                        <small>
                          {new Date(r.at).toLocaleString("zh-CN")} ·{" "}
                          {r.success ? "验证通过" : "执行失败"}
                        </small>
                      </div>
                      {r.reversible && (
                        <Button
                          variant="secondary"
                          disabled={!usable}
                          onClick={() =>
                            void preview({ kind: "rollback", id: r.id })
                          }
                        >
                          预览撤销
                        </Button>
                      )}
                    </div>
                  ))
                )}
              </section>
              <section className="panel">
                <div className="section-heading">
                  <div>
                    <h2>诊断记录与报告</h2>
                    <p>复制脱敏的发现与诊断信息，可用于继续排障。</p>
                  </div>
                  <div className="row">
                    <Button
                      variant="secondary"
                      disabled={!native}
                      onClick={() =>
                        void action(async () => {
                          await api.copy(snapshot, results);
                          setNotice("诊断报告已复制。");
                        })
                      }
                    >
                      复制报告
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={!native}
                      onClick={() =>
                        void action(async () =>
                          setNotice(
                            `报告已保存：${await api.export(snapshot, results)}`,
                          ),
                        )
                      }
                    >
                      导出报告
                    </Button>
                  </div>
                </div>
                {results.slice(0, 15).map((d, i) => (
                  <button
                    className="history-row"
                    key={`${d.profileId}-${i}`}
                    onClick={() => setEvidence(d)}
                  >
                    <span>{d.label}</span>
                    <Status status={d.status} stale={isStale(d.finishedAt)} />
                    <small>{clockTime(d.finishedAt)}</small>
                    <ChevronRight size={15} />
                  </button>
                ))}
              </section>
            </>
          )}
          <footer>
            NetDeck · 本地优先 <span>配置 ≠ 可达 ≠ 应用可用</span>
          </footer>
        </div>
      </main>
      <Sheet
        open={!!profile}
        onClose={() => setProfile(null)}
        title={profile?.label || "添加连接"}
        description="确认实际地址后启用检查。SSH 登录与系统变更需要另行预览。"
      >
        {profile && (
          <ProfileForm
            key={profile.id}
            initial={profile}
            aliases={snapshot?.sshAliases ?? []}
            onSave={async (p) => {
              await save({
                ...config,
                profiles: [...config.profiles.filter((x) => x.id !== p.id), p],
              });
              setProfile(null);
            }}
          />
        )}
      </Sheet>
      <Sheet
        open={!!tunnel}
        onClose={() => setTunnel(null)}
        title="配置 SSH 隧道"
        description="保存定义不会连接。启动时将显示实际转发策略与影响。"
      >
        {tunnel && (
          <form
            className="profile-form"
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                await save({
                  ...config,
                  controls: {
                    ...config.controls,
                    tunnels: [
                      ...config.controls.tunnels.filter(
                        (t) => t.id !== tunnel.id,
                      ),
                      tunnel,
                    ],
                  },
                });
                setTunnel(null);
              });
            }}
          >
            <label>
              名称
              <input
                required
                maxLength={100}
                value={tunnel.label}
                onChange={(e) =>
                  setTunnel({ ...tunnel, label: e.target.value })
                }
              />
            </label>
            <label>
              SSH Host 别名
              <input
                required
                list="tunnel-aliases"
                value={tunnel.alias}
                onChange={(e) =>
                  setTunnel({ ...tunnel, alias: e.target.value })
                }
              />
              <datalist id="tunnel-aliases">
                {snapshot?.sshAliases.map((a) => (
                  <option key={a} value={a} />
                ))}
              </datalist>
            </label>
            <label>
              转发策略
              <select
                value={tunnel.reuseConfig ? "reuse" : "override"}
                onChange={(e) =>
                  setTunnel({
                    ...tunnel,
                    reuseConfig: e.target.value === "reuse",
                  })
                }
              >
                <option value="override">明确覆盖：仅创建下方一条规则</option>
                <option value="reuse">沿用 SSH Config 的转发规则</option>
              </select>
            </label>
            <label>
              方向
              <select
                value={tunnel.direction}
                onChange={(e) =>
                  setTunnel({
                    ...tunnel,
                    direction: e.target.value as "remote" | "local",
                  })
                }
              >
                <option value="remote">远端 -R：让远端使用 Mac 的服务</option>
                <option value="local">本地 -L：让 Mac 访问远端服务</option>
              </select>
            </label>
            <label>
              {tunnel.direction === "remote" ? "远端" : "Mac 本地"}监听端口
              <input
                required
                type="number"
                min={1}
                max={65535}
                value={tunnel.listenPort}
                onChange={(e) =>
                  setTunnel({ ...tunnel, listenPort: Number(e.target.value) })
                }
              />
            </label>
            <div className="form-row">
              <label>
                目标主机
                <input
                  required
                  value={tunnel.targetHost}
                  onChange={(e) =>
                    setTunnel({ ...tunnel, targetHost: e.target.value })
                  }
                />
              </label>
              <label>
                目标端口
                <input
                  required
                  type="number"
                  min={1}
                  max={65535}
                  value={tunnel.targetPort}
                  onChange={(e) =>
                    setTunnel({ ...tunnel, targetPort: Number(e.target.value) })
                  }
                />
              </label>
            </div>
            <p className="hint">
              {tunnel.reuseConfig
                ? "沿用时以冻结 Config 中的规则为准。上面的端口用于远端出口验证和 Shell 指令，请填写实际值。"
                : "监听请求限定 loopback。远端 -R 的目标从 Mac 连接；本地 -L 的目标从服务器连接。"}
              不修改你的原 SSH 文件。
            </p>
            <div className="row">
              <Button type="submit" disabled={!usable}>
                保存定义
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={
                  !usable ||
                  runtime.some((r) => r.id === tunnel.id && r.status !== "down")
                }
                onClick={() =>
                  void action(async () => {
                    await save({
                      ...config,
                      controls: {
                        ...config.controls,
                        tunnels: config.controls.tunnels.filter(
                          (t) => t.id !== tunnel.id,
                        ),
                      },
                    });
                    setTunnel(null);
                  })
                }
              >
                删除定义
              </Button>
            </div>
          </form>
        )}
      </Sheet>
      <Sheet
        open={!!plan}
        onClose={() => setPlan(null)}
        title={plan?.title ?? "确认操作"}
        description="仅预览尚未执行。确认将执行下列操作；预览 5 分钟后失效。"
      >
        {plan && (
          <div className="plan">
            <h3>执行内容</h3>
            {plan.commands.map((c, i) => (
              <pre key={i}>{c}</pre>
            ))}
            {plan.warnings.map((w) => (
              <div key={w} className="notice">
                {w}
              </div>
            ))}
            <h3>如何恢复</h3>
            <p>{plan.rollback}</p>
            <div className="row">
              <Button disabled={busy} onClick={() => void execute()}>
                确认执行
              </Button>
              <Button variant="secondary" onClick={() => setPlan(null)}>
                取消，保持现状
              </Button>
            </div>
          </div>
        )}
      </Sheet>
      <Sheet
        open={!!evidence}
        onClose={() => setEvidence(null)}
        title={evidence?.label ?? "检查证据"}
        description={`检查时间：${clockTime(evidence?.finishedAt)}。点击每一步查看详情。`}
      >
        {evidence && <EvidenceList steps={evidence.steps} />}
      </Sheet>
      <Sheet
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail?.title ?? "详情"}
      >
        <pre>{JSON.stringify(detail?.value, null, 2)}</pre>
      </Sheet>
    </div>
  );
}
