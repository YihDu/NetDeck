import { useState, useEffect, useRef, useCallback } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  Copy,
  GitBranch,
  Globe2,
  Layers,
  LayoutDashboard,
  Loader2,
  Monitor,
  Moon,
  Network,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Shield,
  SlidersHorizontal,
  Square,
  Sun,
  Terminal,
  Trash2,
  Waypoints,
  X,
} from "lucide-react";
import { api, native } from "./lib/api";
import {
  clockTime,
  defaultConfig,
  freshProfile,
  historical,
  isStale,
  kindLabels,
  type Config,
  type Diagnostic,
  type Evidence,
  type Profile,
  type Snapshot,
  type Health,
} from "./lib/types";
import { Button } from "./components/ui/button";
import { Sheet } from "./components/ui/sheet";
import { EvidenceList, SourceBadge, Status } from "./components/Status";
import { NetworkMap } from "./components/NetworkMap";
import { ProfileForm } from "./components/ProfileForm";
import "./App.css";

type Page =
  | "overview"
  | "map"
  | "connections"
  | "tunnels"
  | "diagnostics"
  | "activity"
  | "settings";
const nav = [
  { id: "overview", label: "总览", en: "Overview", icon: LayoutDashboard },
  { id: "map", label: "网络拓扑", en: "Network Map", icon: Waypoints },
  { id: "connections", label: "连接管理", en: "Connections", icon: Layers },
  { id: "tunnels", label: "SSH 隧道", en: "Tunnels", icon: GitBranch },
  { id: "diagnostics", label: "诊断中心", en: "Diagnostics", icon: Activity },
  { id: "activity", label: "活动与日志", en: "Activity", icon: Clock3 },
  { id: "settings", label: "设置", en: "Settings", icon: Settings2 },
] as const;
const pageCopy: Record<Page, [string, string]> = {
  overview: ["掌握每一条连接。", "本机发现、连接状态与逐跳证据，汇聚在这里。"],
  map: ["你的网络，一目了然。", "点击设备或链路查看证据。虚线表示尚未验证。"],
  connections: [
    "连接你的工作环境。",
    "显式配置目标，再启用检测。各条连接可以同时存在。",
  ],
  tunnels: [
    "看清每一条 SSH 转发。",
    "检查有效配置与重复端口风险，保留现有连接的控制权。",
  ],
  diagnostics: [
    "从现象，定位到一跳。",
    "DNS、路由、TCP、代理与 HTTPS，各层独立报告。",
  ],
  activity: [
    "每次检查，都有迹可循。",
    "诊断结果仅保存在本机，报告自动移除凭据。",
  ],
  settings: ["按你的方式工作。", "调整显示、刷新节奏与检测范围。"],
};
function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
export default function App() {
  const [page, setPage] = useState<Page>("overview");
  const [config, setConfig] = useState<Config>(defaultConfig);
  const [configReady, setConfigReady] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [results, setResults] = useState<Diagnostic[]>([]);
  const [history, setHistory] = useState<Diagnostic[]>([]);
  const [loading, setLoading] = useState(native);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [filter, setFilter] = useState("");
  const [inspector, setInspector] = useState<{
    title: string;
    detail: unknown;
  } | null>(null);
  const [editing, setEditing] = useState<Profile | null>(null);
  const [importing, setImporting] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Profile | null>(null);
  const [tick, setTick] = useState(0);
  const fetching = useRef(false);
  const busy = useRef(false);
  const configRef = useRef(config);
  configRef.current = config;
  const notify = useCallback((s: string) => setToast(s), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 7000);
    return () => clearTimeout(t);
  }, [toast]);
  const refresh = useCallback(async () => {
    if (!native || fetching.current) return;
    fetching.current = true;
    setLoading(true);
    try {
      setSnapshot(await api.snapshot());
      setError("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      fetching.current = false;
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (!native) {
      setLoading(false);
      return;
    }
    void refresh();
    void api
      .config()
      .then((c) => {
        setConfig(c);
        setConfigReady(true);
      })
      .catch((e) => setError(errorText(e)));
    void api
      .history()
      .then(setHistory)
      .catch((e) => setError(errorText(e)));
  }, [refresh]);
  useEffect(() => {
    document.documentElement.dataset.theme = config.preferences.theme;
  }, [config.preferences.theme]);
  useEffect(() => {
    const t = setInterval(
      () => void refresh(),
      config.preferences.refreshSeconds * 1000,
    );
    return () => clearInterval(t);
  }, [refresh, config.preferences.refreshSeconds]);
  useEffect(() => {
    const t = setInterval(() => setTick((t) => t + 1), 10000);
    return () => clearInterval(t);
  }, []);
  const diagnose = useCallback(
    async (id?: string) => {
      if (busy.current || !native) return;
      busy.current = true;
      setRunning(true);
      setError("");
      setPage("diagnostics");
      try {
        const next = await api.diagnose(id);
        setResults((old) => [
          ...old.filter((r) => !next.some((n) => n.profileId === r.profileId)),
          ...next,
        ]);
        setSelected(next[0]?.profileId ?? null);
        setHistory(await api.history());
        notify(
          next.some((r) => r.cancelled)
            ? "已取消，保留完成的逐跳结果"
            : `已完成 ${next.length} 条连接诊断`,
        );
      } catch (e) {
        setError(errorText(e));
      } finally {
        busy.current = false;
        setRunning(false);
      }
    },
    [notify],
  );
  useEffect(() => {
    if (!config.preferences.autoDiagnose || !configReady) return;
    const t = setInterval(() => {
      if (configRef.current.profiles.some((p) => p.enabled)) void diagnose();
    }, config.preferences.diagnoseSeconds * 1000);
    return () => clearInterval(t);
  }, [
    config.preferences.autoDiagnose,
    config.preferences.diagnoseSeconds,
    configReady,
    diagnose,
  ]);
  async function save(next: Config) {
    await api.save(next);
    setConfig(next);
  }
  async function saveProfile(p: Profile) {
    const current = configRef.current;
    await save({
      ...current,
      profiles: [...current.profiles.filter((x) => x.id !== p.id), p],
    });
    setResults((old) => old.filter((r) => r.profileId !== p.id));
    setEditing(null);
    notify("连接已保存；检测状态已重置");
  }
  async function changePreference<K extends keyof Config["preferences"]>(
    key: K,
    value: Config["preferences"][K],
  ) {
    try {
      if (native && !configReady)
        throw new Error("配置尚未成功加载；为保护现有文件，暂不保存偏好。");
      if (native)
        await save({
          ...configRef.current,
          preferences: { ...configRef.current.preferences, [key]: value },
        });
      else
        setConfig((c) => ({
          ...c,
          preferences: { ...c.preferences, [key]: value },
        }));
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function report(action: "copy" | "export") {
    try {
      if (action === "copy") {
        await api.copy(snapshot, results);
        notify("脱敏报告已复制到剪贴板");
      } else {
        const path = await api.export(snapshot, results);
        notify(`报告已导出：${path.replace(/^\/Users\/[^/]+/, "~")}`);
      }
    } catch (e) {
      setError(errorText(e));
    }
  }
  const inspect = (title: string, detail: unknown) =>
    setInspector({ title, detail });
  const enabled = config.profiles.filter((p) => p.enabled);
  const peers = snapshot?.tailscale?.peers ?? [];
  const currentResults = results.filter((r) => !isStale(r.finishedAt));
  const issues = currentResults.filter(
    (r) => r.status === "down" || r.status === "degraded",
  );
  const discoveryIssues = snapshot?.evidence.filter((e) => e.errorCode) ?? [];
  const currentPage = nav.find((n) => n.id === page)!;
  const available = native && configReady;
  const selectedResult =
    results.find((r) => r.profileId === selected) ?? results[0];
  const staleSnapshot = isStale(
    snapshot?.capturedAt,
    Math.max(config.preferences.refreshSeconds * 3, 45),
  );
  const internet = currentResults.find(
    (r) => config.profiles.find((p) => p.id === r.profileId)?.kind === "https",
  );
  const proxyEndpoints =
    snapshot?.systemProxy.endpoints.filter((p) => p.enabled) ?? [];
  const proxyResult = currentResults.find((r) =>
    config.profiles.some(
      (p) =>
        p.id === r.profileId &&
        ["http-proxy", "socks5-proxy"].includes(p.kind) &&
        proxyEndpoints.some((e) => e.host === p.host && e.port === p.port),
    ),
  );
  const stats: [string, string, string, Health, typeof Globe2, unknown][] = [
    [
      "Internet",
      internet?.status === "healthy" ? "已验证" : "未检查",
      internet?.label ?? "添加 HTTPS 目标以验证出口",
      internet?.status ?? "unknown",
      Globe2,
      internet ??
        "本机存在默认路由不代表互联网可用。请添加 HTTPS Profile，并启用后发起诊断。",
    ],
    [
      "Local Proxy",
      `${proxyEndpoints.length} 个配置`,
      proxyResult ? "最近代理诊断结果" : "系统配置 ≠ 实际可用",
      proxyResult?.status ?? "unknown",
      Shield,
      {
        system: snapshot?.systemProxy,
        shell: snapshot?.shellProxy,
        diagnostic: proxyResult,
      },
    ],
    [
      "Tailscale",
      snapshot?.tailscale?.state === "Running"
        ? "运行中"
        : (snapshot?.tailscale?.state ?? "不可用"),
      `${peers.length} 个已知设备 · 连通性待验证`,
      snapshot?.tailscale?.state === "Running" && !staleSnapshot
        ? "healthy"
        : "unknown",
      Network,
      snapshot?.tailscale ??
        snapshot?.evidence.find((e) => e.check === "tailscale"),
    ],
    [
      "SSH Profiles",
      `${snapshot?.sshAliases.length ?? 0} 个别名`,
      "配置已发现 · 未建立连接",
      "unknown",
      Terminal,
      {
        aliases: snapshot?.sshAliases,
        evidence: snapshot?.evidence.find((e) => e.check === "ssh-config"),
      },
    ],
  ];
  return (
    <div className="app-shell" data-tick={tick}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Waypoints size={23} />
          </div>
          <div>
            <strong>
              NetDeck<span>·</span>
            </strong>
            <small>NETWORK CONTROL CENTER</small>
          </div>
        </div>
        <div className="workspace">
          <span className="workspace-icon">
            <Monitor size={17} />
          </span>
          <div>
            <strong>个人工作空间</strong>
            <small>Local-first · macOS</small>
          </div>
          <span className="workspace-dot" />
        </div>
        <span className="nav-caption">工作台</span>
        <nav>
          {nav.map((n) => (
            <button
              key={n.id}
              aria-label={n.label}
              className={`nav-item ${page === n.id ? "active" : ""}`}
              onClick={() => setPage(n.id)}
            >
              <n.icon size={18} />
              <span>{n.label}</span>
              {n.id === "connections" && config.profiles.length > 0 && (
                <small>{config.profiles.length}</small>
              )}
              {n.id === "diagnostics" && issues.length > 0 && (
                <small className="attention-count">{issues.length}</small>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="safe-mode">
            <Shield size={17} />
            <div>
              <strong>只读诊断模式</strong>
              <small>你的网络，由你掌控</small>
            </div>
          </div>
          <div className="sidebar-footer">
            <span>
              NetDeck <b>0.1</b>
            </span>
            <button
              aria-label="切换主题"
              onClick={() =>
                void changePreference(
                  "theme",
                  config.preferences.theme === "dark" ? "light" : "dark",
                )
              }
            >
              {config.preferences.theme === "dark" ? (
                <Sun size={16} />
              ) : (
                <Moon size={16} />
              )}
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <span>工作台</span>
            <ChevronRight size={13} />
            <strong>{currentPage.label}</strong>
          </div>
          <div className="topbar-right">
            <span
              className={`live-indicator ${snapshot && !staleSnapshot ? "connected" : ""}`}
            >
              <i />
              {native ? "本机连接" : "浏览器预览"}
            </span>
            <span className="topbar-divider" />
            <button
              className="icon-button"
              aria-label="刷新本机状态"
              onClick={() => void refresh()}
              disabled={!native || loading}
            >
              <RefreshCw size={16} className={loading ? "spin" : ""} />
            </button>
            <span className="timestamp">
              {loading ? "正在发现…" : clockTime(snapshot?.capturedAt)}
              {staleSnapshot ? " · 已过期" : ""}
            </span>
          </div>
        </header>
        <main>
          <section className="page-heading">
            <div>
              <div className="eyebrow">
                {currentPage.en.toUpperCase()} <span>/ 个人网络控制中心</span>
              </div>
              <h1>{pageCopy[page][0]}</h1>
              <p>{pageCopy[page][1]}</p>
            </div>
            <div className="heading-actions">
              {running ? (
                <Button
                  variant="secondary"
                  onClick={() =>
                    void api.cancel().catch((e) => setError(errorText(e)))
                  }
                >
                  <Square size={14} />
                  取消诊断
                </Button>
              ) : (
                <Button
                  onClick={() => void diagnose()}
                  disabled={!available || enabled.length === 0}
                >
                  <Activity size={16} />
                  诊断全部
                  <span className="button-counter">{enabled.length}</span>
                </Button>
              )}
            </div>
          </section>
          {!native && (
            <div className="notice">
              <CircleHelp size={17} />
              <span>
                <strong>原生后端未连接。</strong> 当前仅预览界面；通过{" "}
                <code>npm run tauri dev</code> 打开桌面应用后可获取真实状态。
              </span>
            </div>
          )}
          {error && (
            <div role="alert" className="notice error">
              <CircleHelp size={17} />
              <span>{error}</span>
              <button aria-label="关闭错误" onClick={() => setError("")}>
                <X size={15} />
              </button>
            </div>
          )}
          {page === "overview" && (
            <>
              <div className="stats-grid">
                {stats.map(([label, value, sub, status, Icon, detail]) => (
                  <button
                    className="stat-card"
                    key={label}
                    onClick={() => inspect(label, detail)}
                  >
                    <div className="stat-top">
                      <span>{label}</span>
                      <Icon size={18} />
                    </div>
                    <div className="stat-value">
                      {loading && !snapshot ? (
                        <span className="skeleton">正在读取</span>
                      ) : (
                        value
                      )}
                    </div>
                    <div className="stat-bottom">
                      <span>{sub}</span>
                      <Status status={status} />
                    </div>
                  </button>
                ))}
              </div>
              <div className="overview-grid">
                <section className="panel map-panel">
                  <div className="panel-heading">
                    <div>
                      <span className="section-icon">
                        <Waypoints size={17} />
                      </span>
                      <h2>连接拓扑</h2>
                      <span className="tiny-tag">LIVE MAP</span>
                    </div>
                    <button
                      className="text-button"
                      onClick={() => setPage("map")}
                    >
                      展开视图
                      <ArrowUpRight size={14} />
                    </button>
                  </div>
                  <NetworkMap
                    snapshot={snapshot}
                    profiles={config.profiles}
                    results={results}
                    onInspect={inspect}
                    compact
                  />
                </section>
                <section className="panel environments">
                  <div className="panel-heading">
                    <div>
                      <Layers size={17} />
                      <h2>工作连接</h2>
                    </div>
                    <button
                      aria-label="新增连接"
                      className="icon-button"
                      disabled={!available}
                      onClick={() => setEditing(freshProfile())}
                    >
                      <Plus size={17} />
                    </button>
                  </div>
                  {config.profiles.length ? (
                    config.profiles.slice(0, 4).map((p) => {
                      const r = results.find((r) => r.profileId === p.id);
                      return (
                        <button
                          className="environment-row"
                          key={p.id}
                          onClick={() => {
                            setPage("connections");
                            setFilter(p.label);
                          }}
                        >
                          <span className="connection-icon">
                            <Monitor size={18} />
                          </span>
                          <span>
                            <strong>{p.label}</strong>
                            <small>{kindLabels[p.kind]}</small>
                          </span>
                          <Status
                            status={
                              p.enabled
                                ? (r?.status ?? "unknown")
                                : "not-configured"
                            }
                            stale={isStale(r?.finishedAt)}
                          />
                        </button>
                      );
                    })
                  ) : (
                    <div className="empty-state small">
                      <span className="empty-icon">
                        <Layers size={26} />
                      </span>
                      <h3>从一条连接开始</h3>
                      <p>
                        添加代理、SSH 主机或服务，
                        <br />
                        构建你的网络工作台。
                      </p>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={!available}
                        onClick={() => setEditing(freshProfile())}
                      >
                        <Plus size={14} />
                        添加连接
                      </Button>
                    </div>
                  )}
                  <div className="panel-footer">
                    <button
                      className="text-button"
                      onClick={() => setPage("connections")}
                    >
                      管理全部连接
                      <ArrowRight size={14} />
                    </button>
                  </div>
                </section>
              </div>
              <div className="bottom-grid">
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <Activity size={17} />
                      <h2>需要关注</h2>
                      <span className="count-badge">
                        {issues.length + discoveryIssues.length}
                      </span>
                    </div>
                    <span className="muted small-text">基于最近一次检查</span>
                  </div>
                  {issues.length + discoveryIssues.length === 0 ? (
                    <div className="quiet-state">
                      <div className="quiet-icon">
                        <Check size={21} />
                      </div>
                      <div>
                        <strong>
                          {enabled.length ? "暂未记录异常" : "等待更多连接证据"}
                        </strong>
                        <p>
                          {enabled.length
                            ? "诊断结果将在这里汇总。"
                            : "完成本机发现后，添加并检测目标以了解链路健康度。"}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="issues">
                      {discoveryIssues.map((e) => (
                        <button
                          className="issue-row"
                          key={e.check}
                          onClick={() => inspect(e.summary, e)}
                        >
                          <span className="issue-dot" />
                          <div>
                            <strong>{e.summary}</strong>
                            <small>
                              {e.check} · {e.errorCode}
                            </small>
                          </div>
                          <ChevronRight size={15} />
                        </button>
                      ))}
                      {issues.map((r) => (
                        <button
                          className="issue-row"
                          key={r.profileId}
                          onClick={() => {
                            setSelected(r.profileId);
                            setPage("diagnostics");
                          }}
                        >
                          <span className={`issue-dot ${r.status}`} />
                          <div>
                            <strong>{r.label}</strong>
                            <small>
                              {r.steps.find(
                                (s) =>
                                  s.status === "down" ||
                                  s.status === "degraded",
                              )?.summary ?? "部分步骤尚未验证"}
                            </small>
                          </div>
                          <ChevronRight size={15} />
                        </button>
                      ))}
                    </div>
                  )}
                </section>
                <section className="panel machine-panel">
                  <div className="panel-heading">
                    <div>
                      <Monitor size={17} />
                      <h2>本机概况</h2>
                    </div>
                    <SourceBadge
                      source={snapshot ? "observed" : "configured"}
                    />
                  </div>
                  <dl>
                    <div>
                      <dt>系统</dt>
                      <dd>
                        {snapshot ? `macOS ${snapshot.osVersion}` : "未读取"}
                      </dd>
                    </div>
                    <div>
                      <dt>默认出口</dt>
                      <dd>{snapshot?.defaultRoute.interface ?? "未读取"}</dd>
                    </div>
                    <div>
                      <dt>监听端口</dt>
                      <dd>
                        <button
                          className="text-button"
                          onClick={() =>
                            inspect("本机 TCP 监听端口", snapshot?.listeners)
                          }
                        >
                          {snapshot?.listeners.length ?? "—"} 个
                          <ArrowUpRight size={12} />
                        </button>
                      </dd>
                    </div>
                    <div>
                      <dt>系统 / Shell 代理</dt>
                      <dd>
                        <button
                          className="text-button"
                          onClick={() =>
                            inspect("代理来源对照", {
                              system: snapshot?.systemProxy,
                              shell: snapshot?.shellProxy,
                              note: "Shell 变量为应用继承的进程环境，可能与另一个终端窗口不同。",
                            })
                          }
                        >
                          查看对照
                          <ArrowUpRight size={12} />
                        </button>
                      </dd>
                    </div>
                  </dl>
                </section>
              </div>
              <div className="page-footnote">
                <Shield size={12} />
                本机发现不会修改网络配置。主动检查仅针对你启用的目标。
                <span>所有时间均为本地时间</span>
              </div>
            </>
          )}
          {page === "map" && (
            <section className="panel full-map">
              <NetworkMap
                snapshot={snapshot}
                profiles={config.profiles}
                results={results}
                onInspect={inspect}
              />
            </section>
          )}
          {page === "connections" && (
            <>
              <div className="section-toolbar">
                <div className="search-input">
                  <Search size={16} />
                  <input
                    aria-label="搜索连接"
                    placeholder="搜索名称、地址或别名…"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                </div>
                <div>
                  <Button
                    variant="secondary"
                    disabled={!available}
                    onClick={() => setImporting(true)}
                  >
                    <ArrowDownToLine size={15} />
                    导入历史线索
                  </Button>
                  <Button
                    disabled={!available}
                    onClick={() => setEditing(freshProfile())}
                  >
                    <Plus size={15} />
                    新增连接
                  </Button>
                </div>
              </div>
              {config.profiles.length === 0 ? (
                <section className="panel empty-state">
                  <span className="empty-icon">
                    <Layers size={31} />
                  </span>
                  <h2>让你的连接有一个家</h2>
                  <p>
                    从已知的代理或 SSH 别名开始。
                    <br />
                    历史地址需确认，启用之后才会发起检测。
                  </p>
                  <Button
                    disabled={!available}
                    onClick={() => setEditing(freshProfile())}
                  >
                    <Plus size={16} />
                    添加第一个连接
                  </Button>
                  {!!snapshot?.sshAliases.length && (
                    <div className="discovered-aliases">
                      <span>发现的 SSH 别名</span>
                      {snapshot.sshAliases.slice(0, 8).map((a) => (
                        <button
                          key={a}
                          onClick={() =>
                            setEditing({
                              ...freshProfile(),
                              label: a,
                              kind: "ssh",
                              sshAlias: a,
                              port: 22,
                            })
                          }
                        >
                          <Terminal size={13} />
                          {a}
                          <Plus size={12} />
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              ) : (
                <div className="connections-grid">
                  {config.profiles
                    .filter((p) =>
                      `${p.label} ${p.host} ${p.sshAlias}`
                        .toLowerCase()
                        .includes(filter.toLowerCase()),
                    )
                    .map((p) => {
                      const r = results.find((r) => r.profileId === p.id);
                      return (
                        <section className="panel connection-card" key={p.id}>
                          <div className="connection-card-top">
                            <span className="connection-icon">
                              <Monitor size={20} />
                            </span>
                            <SourceBadge source={p.source} />
                          </div>
                          <h2>{p.label}</h2>
                          <p className="mono endpoint">
                            {p.sshAlias || `${p.host}:${p.port}`}
                          </p>
                          <div className="connection-meta">
                            <span>{kindLabels[p.kind]}</span>
                            <Status
                              status={
                                p.enabled
                                  ? (r?.status ?? "unknown")
                                  : "not-configured"
                              }
                              stale={isStale(r?.finishedAt)}
                            />
                          </div>
                          <div className="connection-date">
                            <Clock3 size={12} />
                            {clockTime(r?.finishedAt)}
                          </div>
                          <div className="connection-actions">
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={!p.enabled || running}
                              onClick={() => void diagnose(p.id)}
                            >
                              <Activity size={14} />
                              诊断
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setEditing(p)}
                            >
                              <SlidersHorizontal size={14} />
                              编辑
                            </Button>
                            <button
                              className="icon-button delete"
                              aria-label={`删除 ${p.label}`}
                              onClick={() => setDeleteTarget(p)}
                            >
                              <Trash2 size={15} />
                            </button>
                          </div>
                        </section>
                      );
                    })}
                </div>
              )}
            </>
          )}
          {page === "diagnostics" && (
            <>
              {running && (
                <div className="diagnosing">
                  <Loader2 size={19} className="spin" />
                  <div>
                    <strong>正在逐跳检查…</strong>
                    <span>
                      最多 3 条连接并发 · 单步超时 · 总任务 120 秒上限
                    </span>
                  </div>
                  <div className="scan-bars">
                    <i />
                    <i />
                    <i />
                    <i />
                    <i />
                  </div>
                </div>
              )}
              {results.length ? (
                <div className="diagnostic-layout">
                  <aside className="panel result-list">
                    <div className="panel-heading">
                      <h2>连接结果</h2>
                      <span className="count-badge">{results.length}</span>
                    </div>
                    {results.map((r) => (
                      <button
                        className={`result-row ${selectedResult?.profileId === r.profileId ? "selected" : ""}`}
                        key={r.profileId}
                        onClick={() => setSelected(r.profileId)}
                      >
                        <strong>{r.label}</strong>
                        <div>
                          <Status
                            status={r.status}
                            stale={isStale(r.finishedAt)}
                          />
                          <small>{clockTime(r.finishedAt)}</small>
                        </div>
                      </button>
                    ))}
                  </aside>
                  {selectedResult && (
                    <section className="panel diagnostic-detail">
                      <div className="panel-heading">
                        <div>
                          <h2>{selectedResult.label}</h2>
                          <Status
                            status={selectedResult.status}
                            stale={isStale(selectedResult.finishedAt)}
                          />
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void report("copy")}
                        >
                          <Copy size={14} />
                          复制报告
                        </Button>
                      </div>
                      <div className="diagnostic-caption">
                        <span>
                          {selectedResult.cancelled
                            ? "已取消 · 已完成步骤仍可查看"
                            : "逐跳证据"}
                        </span>
                        <span>
                          {clockTime(selectedResult.startedAt)} →{" "}
                          {clockTime(selectedResult.finishedAt)}
                        </span>
                      </div>
                      <EvidenceList steps={selectedResult.steps} />
                    </section>
                  )}
                </div>
              ) : (
                <section className="panel empty-state">
                  <span className="empty-icon">
                    <Activity size={32} />
                  </span>
                  <h2>{running ? "正在收集连接证据" : "每个结论，都有依据"}</h2>
                  <p>
                    选择已启用的连接，或运行「诊断全部」。
                    <br />
                    结果会按配置 → DNS → 路由 → TCP → 服务展开。
                  </p>
                  {enabled.length === 0 && (
                    <Button
                      variant="secondary"
                      onClick={() => setPage("connections")}
                    >
                      配置连接
                      <ArrowRight size={14} />
                    </Button>
                  )}
                </section>
              )}
            </>
          )}
          {page === "tunnels" && (
            <>
              <div className="notice">
                <GitBranch size={17} />
                <span>
                  首版只读检查 SSH
                  配置与转发风险。启动、停止隧道将在后续版本提供。
                </span>
              </div>
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <Terminal size={17} />
                    <h2>已配置的 SSH 主机</h2>
                  </div>
                  <span className="tiny-tag">READ ONLY</span>
                </div>
                {config.profiles.filter((p) => p.kind === "ssh").length ? (
                  config.profiles
                    .filter((p) => p.kind === "ssh")
                    .map((p) => {
                      const r = results.find((r) => r.profileId === p.id);
                      const e = r?.steps.find((s) => s.check === "ssh-config");
                      return (
                        <div className="tunnel-row" key={p.id}>
                          <Terminal size={20} />
                          <div>
                            <strong>{p.label}</strong>
                            <small>{p.sshAlias}</small>
                          </div>
                          <span>{e?.summary ?? "等待读取生效配置"}</span>
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={!p.enabled || running}
                            onClick={() => void diagnose(p.id)}
                          >
                            检查配置
                          </Button>
                          {e && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => inspect("SSH 有效转发规则", e)}
                            >
                              查看规则
                            </Button>
                          )}
                        </div>
                      );
                    })
                ) : (
                  <div className="empty-state">
                    <GitBranch size={32} />
                    <h3>还没有 SSH Profile</h3>
                    <p>
                      添加已发现的 SSH 别名后，可检查有效转发与重复端口风险。
                    </p>
                    <Button
                      variant="secondary"
                      onClick={() => setPage("connections")}
                    >
                      前往连接管理
                    </Button>
                  </div>
                )}
              </section>
            </>
          )}
          {page === "activity" && (
            <>
              <div className="section-toolbar">
                <span className="muted">
                  最近 {history.length} 条诊断 · 本机滚动日志
                </span>
                <div>
                  <Button
                    variant="secondary"
                    disabled={!native || !snapshot}
                    onClick={() => void report("copy")}
                  >
                    <Copy size={15} />
                    复制当前报告
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={!native || !snapshot}
                    onClick={() => void report("export")}
                  >
                    <ArrowDownToLine size={15} />
                    导出 JSON
                  </Button>
                </div>
              </div>
              <section className="panel">
                {history.length ? (
                  history.map((r, i) => (
                    <button
                      className="activity-row"
                      key={`${r.finishedAt}-${i}`}
                      onClick={() =>
                        inspect(`${r.label} · ${clockTime(r.finishedAt)}`, r)
                      }
                    >
                      <span className="activity-icon">
                        <Activity size={16} />
                      </span>
                      <div>
                        <strong>{r.label}</strong>
                        <small>
                          {new Date(r.finishedAt).toLocaleString("zh-CN")} ·{" "}
                          {r.steps.length} 个步骤
                          {r.cancelled ? " · 已取消" : ""}
                        </small>
                      </div>
                      <Status status={r.status} stale={isStale(r.finishedAt)} />
                      <ChevronRight size={15} />
                    </button>
                  ))
                ) : (
                  <div className="empty-state">
                    <Clock3 size={30} />
                    <h3>还没有诊断记录</h3>
                    <p>完成一次主动检查后，结果会自动保存在这里。</p>
                  </div>
                )}
              </section>
            </>
          )}
          {page === "settings" && (
            <div className="settings-grid">
              <section className="panel settings-panel">
                <div className="panel-heading">
                  <div>
                    <Settings2 size={17} />
                    <h2>应用偏好</h2>
                  </div>
                </div>
                <div className="setting-row">
                  <div>
                    <strong>界面主题</strong>
                    <small>选择适合当前环境的外观</small>
                  </div>
                  <div className="segmented">
                    <button
                      className={
                        config.preferences.theme === "dark" ? "selected" : ""
                      }
                      onClick={() => void changePreference("theme", "dark")}
                    >
                      <Moon size={14} />
                      深色
                    </button>
                    <button
                      className={
                        config.preferences.theme === "light" ? "selected" : ""
                      }
                      onClick={() => void changePreference("theme", "light")}
                    >
                      <Sun size={14} />
                      浅色
                    </button>
                  </div>
                </div>
                <div className="setting-row">
                  <div>
                    <strong>本机发现刷新间隔</strong>
                    <small>仅读取代理、路由、端口及 Tailscale 状态</small>
                  </div>
                  <select
                    disabled={!available}
                    value={config.preferences.refreshSeconds}
                    onChange={(e) =>
                      void changePreference(
                        "refreshSeconds",
                        Number(e.target.value),
                      )
                    }
                  >
                    {[10, 15, 30, 60].map((n) => (
                      <option key={n} value={n}>
                        {n} 秒
                      </option>
                    ))}
                  </select>
                </div>
                <div className="setting-row">
                  <div>
                    <strong>定时主动诊断</strong>
                    <small>仅对已启用 Profile 发送请求；默认关闭</small>
                  </div>
                  <input
                    aria-label="定时主动诊断"
                    type="checkbox"
                    className="toggle"
                    disabled={!available}
                    checked={config.preferences.autoDiagnose}
                    onChange={(e) =>
                      void changePreference("autoDiagnose", e.target.checked)
                    }
                  />
                </div>
                <div className="setting-row">
                  <div>
                    <strong>主动诊断间隔</strong>
                    <small>已有任务运行时跳过新一轮检查</small>
                  </div>
                  <select
                    disabled={!available}
                    value={config.preferences.diagnoseSeconds}
                    onChange={(e) =>
                      void changePreference(
                        "diagnoseSeconds",
                        Number(e.target.value),
                      )
                    }
                  >
                    {[30, 60, 120, 300].map((n) => (
                      <option key={n} value={n}>
                        {n} 秒
                      </option>
                    ))}
                  </select>
                </div>
              </section>
              <section className="panel settings-panel">
                <div className="panel-heading">
                  <div>
                    <Shield size={17} />
                    <h2>数据与边界</h2>
                  </div>
                  <span className="tiny-tag">LOCAL ONLY</span>
                </div>
                <div className="settings-copy">
                  <p>配置、诊断日志和导出报告保存在：</p>
                  <code>~/Library/Application Support/NetDeck/</code>
                  <p>
                    报告移除 URL 凭据、查询参数、Token
                    和个人目录前缀。保留网络地址以便排障，分享前仍可自行审阅。
                  </p>
                  <p>
                    本版不修改系统代理、VPN、Tailscale、SSH 配置或远端服务。
                  </p>
                  <Button
                    variant="secondary"
                    disabled={!native || !snapshot}
                    onClick={() => void report("export")}
                  >
                    <ArrowDownToLine size={15} />
                    导出当前诊断报告
                  </Button>
                </div>
              </section>
            </div>
          )}
        </main>
      </div>
      <Sheet
        open={!!inspector}
        onClose={() => setInspector(null)}
        title={inspector?.title ?? "详情"}
        description="查看本机采集、配置来源与检测证据。"
      >
        {inspector && <Inspector detail={inspector.detail} />}
      </Sheet>
      <Sheet
        open={!!editing}
        onClose={() => setEditing(null)}
        title={
          config.profiles.some((p) => p.id === editing?.id)
            ? "编辑连接"
            : "新增连接"
        }
        description="保存目标后，只有明确启用的连接才会参与主动诊断。"
      >
        {editing && (
          <ProfileForm
            key={editing.id}
            initial={editing}
            aliases={snapshot?.sshAliases ?? []}
            onSave={saveProfile}
          />
        )}
      </Sheet>
      <Sheet
        open={importing}
        onClose={() => setImporting(false)}
        title="导入历史线索"
        description="这些地址来自历史记录，可能已失效。导入后保持禁用，编辑确认后才能启用。"
      >
        <div className="historical-list">
          {historical.map((p) => (
            <div className="historical-item" key={p.id}>
              <div>
                <strong>{p.label}</strong>
                <small>{p.sshAlias || `${p.host}:${p.port}`}</small>
                <SourceBadge source="historical" />
              </div>
              <Button
                variant="secondary"
                size="sm"
                disabled={config.profiles.some((x) => x.id === p.id)}
                onClick={() =>
                  void saveProfile(p)
                    .then(() => notify("历史线索已导入，检测保持禁用"))
                    .catch((e) => setError(errorText(e)))
                }
              >
                {config.profiles.some((x) => x.id === p.id) ? "已导入" : "导入"}
              </Button>
            </div>
          ))}
        </div>
      </Sheet>
      <Sheet
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="删除连接"
        description="仅删除 NetDeck 中的 Profile，历史诊断日志仍保留。"
      >
        <p>确认删除「{deleteTarget?.label}」？</p>
        <Button
          variant="destructive"
          onClick={() => {
            if (deleteTarget)
              void save({
                ...configRef.current,
                profiles: configRef.current.profiles.filter(
                  (p) => p.id !== deleteTarget.id,
                ),
              })
                .then(() => {
                  setResults((r) =>
                    r.filter((x) => x.profileId !== deleteTarget.id),
                  );
                  setDeleteTarget(null);
                  notify("连接已删除");
                })
                .catch((e) => setError(errorText(e)));
          }}
        >
          <Trash2 size={15} />
          删除连接
        </Button>
      </Sheet>
      {toast && (
        <div role="status" className="toast">
          <Check size={17} />
          <span>{toast}</span>
          <button aria-label="关闭通知" onClick={() => setToast("")}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
function Inspector({ detail }: { detail: unknown }) {
  if (detail && typeof detail === "object") {
    const d = detail as { steps?: Evidence[]; check?: string };
    if (Array.isArray(d.steps)) return <EvidenceList steps={d.steps} />;
    if (d.check) return <EvidenceList steps={[detail as Evidence]} />;
  }
  return (
    <pre className="inspector-json">
      {detail === undefined || detail === null
        ? "尚未获取数据"
        : typeof detail === "string"
          ? detail
          : JSON.stringify(detail, null, 2)}
    </pre>
  );
}
