import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Globe2,
  Plus,
  Power,
  RefreshCw,
  Server,
  Settings2,
  Shield,
  Waypoints,
} from "lucide-react";
import { api, native } from "./lib/api";
import {
  defaultConfig,
  freshProfile,
  profileSignature,
  isStale,
  type Config,
  type Snapshot,
  type RuntimeItem,
  type Profile,
  type Diagnostic,
  type TunnelDefinition,
  type Plan,
  type Operation,
} from "./lib/types";
import { Button } from "./components/ui/button";
import { Sheet } from "./components/ui/sheet";
import { EvidenceList } from "./components/Status";
import "./App.css";
import "./Daily.css";
const Advanced = lazy(() => import("./AdvancedApp"));
type Batch = {
  proxySignature?: string;
  title: string;
  steps: { plan: Plan; machineId?: string; kind?: Operation["kind"] }[];
};
export default function App() {
  const [advanced, setAdvanced] = useState(false);
  const [config, setConfig] = useState<Config>(defaultConfig);
  const [ready, setReady] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [runtime, setRuntime] = useState<RuntimeItem[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [machine, setMachine] = useState<TunnelDefinition | null>(null);
  const [proxyOpen, setProxyOpen] = useState(false);
  const [proxyPort, setProxyPort] = useState(7892);
  const [proxyKind, setProxyKind] = useState<"http-proxy" | "socks5-proxy">(
    "http-proxy",
  );
  const [proxyHost, setProxyHost] = useState("127.0.0.1");
  const [validatedProxy, setValidatedProxy] = useState<{
    signature: string;
    at: number;
  } | null>(null);
  const [proxyCheck, setProxyCheck] = useState<Diagnostic | null>(null);
  const [details, setDetails] = useState<Diagnostic | null>(null);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [verified, setVerified] = useState<
    Record<string, { at: number; success: boolean; detail: string }>
  >({});
  const lock = useRef(false);
  const refreshing = useRef(false);
  async function refresh() {
    if (!native || refreshing.current) return;
    refreshing.current = true;
    try {
      const [s, r] = await Promise.all([api.snapshot(), api.runtime()]);
      setSnapshot(s);
      setRuntime(r);
    } catch (e) {
      setError(String(e));
    } finally {
      refreshing.current = false;
    }
  }
  useEffect(() => {
    if (!native || advanced) return;
    let alive = true;
    api
      .config()
      .then((c) => {
        if (alive) {
          setConfig(c);
          setReady(true);
          const p = c.profiles.find(
            (p) => p.id === c.controls.gatewayProfileId,
          );
          if (p) {
            setProxyPort(p.port);
            setProxyHost(p.host);
            if (p.kind === "socks5-proxy" || p.kind === "http-proxy")
              setProxyKind(p.kind);
          }
        }
      })
      .catch((e) => setError(String(e)));
    void refresh();
    const timer = setInterval(
      () => void refresh(),
      config.preferences.refreshSeconds * 1000,
    );
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [advanced, config.preferences.refreshSeconds]);
  useEffect(() => {
    document.documentElement.dataset.theme = config.preferences.theme;
  }, [config.preferences.theme]);
  useEffect(() => {
    if (!native || !ready || advanced || !config.preferences.autoDiagnose)
      return;
    const timer = setInterval(() => {
      if (lock.current) return;
      lock.current = true;
      api
        .diagnose()
        .then((rows) => {
          const r = rows.find(
            (r) => r.profileId === config.controls.gatewayProfileId,
          );
          if (r) {
            setValidatedProxy(null);
            setProxyCheck(r);
          }
        })
        .catch((e) => setError(String(e)))
        .finally(() => {
          lock.current = false;
        });
    }, config.preferences.diagnoseSeconds * 1000);
    return () => clearInterval(timer);
  }, [
    ready,
    advanced,
    config.preferences.autoDiagnose,
    config.preferences.diagnoseSeconds,
    config.controls.gatewayProfileId,
  ]);
  async function task(label: string, fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
      lock.current = false;
    }
  }
  async function save(c: Config) {
    await api.save(c);
    setConfig(c);
  }
  const proxy = config.profiles.find(
    (p) => p.id === config.controls.gatewayProfileId && p.enabled,
  );
  const candidates = (snapshot?.systemProxy.endpoints ?? []).filter(
    (p) =>
      p.enabled &&
      p.port > 0 &&
      ["127.0.0.1", "localhost", "::1"].includes(p.host),
  );
  const machines = config.controls.tunnels.filter(
    (t) => t.direction === "remote",
  );
  const enabled = native && ready && !busy;
  const matchingCheck =
    proxy &&
    proxyCheck?.profileSignature === profileSignature(proxy) &&
    !isStale(proxyCheck.finishedAt)
      ? proxyCheck
      : null;
  const pendingPort = candidates.find(
    (p) =>
      proxy &&
      p.port !== proxy.port &&
      (proxy.kind === "socks5-proxy") ===
        p.protocol.toLowerCase().includes("socks"),
  );
  const proxyWorks =
    matchingCheck?.status === "healthy" ||
    !!(
      proxy &&
      validatedProxy?.signature === profileSignature(proxy) &&
      Date.now() - validatedProxy.at < 120000
    );
  const proxyStatus = !proxy
    ? "选择 VPN 代理"
    : proxyWorks
      ? "代理可用"
      : matchingCheck
        ? "代理需要检查"
        : "尚未检查出口";
  const proxyError = matchingCheck?.steps.find(
    (s) =>
      s.status === "down" || s.status === "degraded" || s.status === "unknown",
  );
  const selectedMachines = machines.filter((m) => selected.includes(m.id));
  async function configureProxy(
    host = proxyHost,
    port = proxyPort,
    kind = proxyKind,
  ) {
    const p: Profile = {
      ...(proxy ?? freshProfile()),
      label: "Mac VPN 代理",
      host,
      port,
      kind,
      enabled: true,
      source: "configured",
      testUrl: proxy?.testUrl || "https://example.com/",
    };
    await save({
      ...config,
      profiles: [...config.profiles.filter((x) => x.id !== p.id), p],
      controls: { ...config.controls, gatewayProfileId: p.id },
    });
    setProxyPort(port);
    setProxyHost(host);
    setProxyKind(kind);
    setProxyCheck(null);
    setProxyOpen(false);
    setNotice(`已记住 ${host}:${port}。现在可以检测，或直接连接机器。`);
  }
  function newMachine(alias = "") {
    setMachine({
      id: crypto.randomUUID(),
      label: alias,
      alias,
      route: "public",
      direction: "remote",
      listenPort: 10073,
      targetHost: "127.0.0.1",
      targetPort: config.controls.gatewayPort,
      reuseConfig: false,
    });
  }
  async function prepare(
    title: string,
    requests: { request: Operation; machineId?: string }[],
  ) {
    const steps: Batch["steps"] = [];
    try {
      for (const r of requests) {
        steps.push({
          kind: r.request.kind,
          plan: await api.preview(r.request),
          machineId: r.machineId,
        });
      }
    } catch (e) {
      await api.discard(steps.map((s) => s.plan.id)).catch(() => {});
      throw e;
    }
    setBatch({
      title,
      steps,
      proxySignature: proxy ? profileSignature(proxy) : undefined,
    });
  }
  function closeBatch() {
    const old = batch;
    setBatch(null);
    if (old)
      void api
        .discard(old.steps.map((s) => s.plan.id))
        .catch((e) => setError(String(e)));
  }
  function tunnelRequest(m: TunnelDefinition): Operation {
    return {
      kind: "tunnel-start",
      id: m.id,
      alias: m.alias,
      direction: m.direction,
      listenPort: m.listenPort,
      targetHost: m.targetHost,
      targetPort: m.targetPort,
      reuseConfig: m.reuseConfig,
    };
  }
  function connect(list: TunnelDefinition[]) {
    void task("准备连接", async () => {
      if (!proxy) {
        setProxyOpen(true);
        return;
      }
      const requests: { request: Operation; machineId?: string }[] = [];
      if (
        list.some((m) => m.route === "slai") &&
        snapshot?.tailscale?.state !== "Running"
      )
        requests.push({
          request: { kind: "tailscale", setting: "connected", value: "true" },
        });
      if (
        list.some((m) => m.route === "slai") &&
        snapshot?.tailscale?.acceptRoutes === false
      )
        requests.push({
          request: {
            kind: "tailscale",
            setting: "accept-routes",
            value: "true",
          },
        });
      requests.push({
        request: {
          kind: "gateway-start",
          profileId: proxy.id,
          port: config.controls.gatewayPort,
        },
      });
      for (const m of list) {
        if (runtime.find((r) => r.id === m.id)?.status !== "healthy")
          requests.push({ request: tunnelRequest(m) });
        requests.push({
          request: {
            kind: "remote-check",
            alias: m.alias,
            port: m.listenPort,
            url: proxy.testUrl || "https://example.com/",
          },
          machineId: m.id,
        });
      }
      await prepare(`连接 ${list.length} 台机器`, requests);
    });
  }
  function disconnect(list: TunnelDefinition[]) {
    void task("准备断开", () =>
      prepare(
        `断开 ${list.length} 台机器`,
        list.map((m) => ({ request: { kind: "tunnel-stop", id: m.id } })),
      ),
    );
  }
  async function execute() {
    if (!batch) return;
    const active = batch;
    setBatch(null);
    await task("正在连接", async () => {
      let finished = 0;
      try {
        for (const step of active.steps) {
          setBusy(`${step.plan.title} · ${++finished}/${active.steps.length}`);
          const receipt = await api.execute(step.plan.id);
          if (
            receipt.success &&
            active.proxySignature &&
            step.kind === "gateway-start"
          ) {
            setValidatedProxy({
              signature: active.proxySignature,
              at: Date.now(),
            });
          }
          if (step.machineId)
            setVerified((old) => ({
              ...old,
              [step.machineId!]: {
                at: Date.now(),
                success: receipt.success,
                detail: receipt.detail,
              },
            }));
          if (!receipt.success) {
            await api.discard(
              active.steps.slice(finished).map((s) => s.plan.id),
            );
            await refresh();
            throw new Error(
              `${receipt.title}：${receipt.detail}。后续步骤已停止；已建立的连接保留，可单独断开。`,
            );
          }
        }
        await refresh();
        setNotice(`${active.title}：已完成。`);
      } finally {
        await api.discard(active.steps.map((s) => s.plan.id)).catch(() => {});
        await refresh();
      }
    });
  }
  if (advanced)
    return (
      <>
        <div className="daily-return">
          <Button variant="secondary" onClick={() => setAdvanced(false)}>
            <ArrowLeft size={15} />
            回到机器列表
          </Button>
          <span>高级配置与诊断</span>
        </div>
        <Suspense fallback={<p>加载设置…</p>}>
          <Advanced />
        </Suspense>
      </>
    );
  return (
    <div className="daily-app">
      <header className="daily-header">
        <div className="daily-brand">
          <Waypoints size={23} />
          <strong>NetDeck</strong>
          <span>连接你的工作环境</span>
        </div>
        <div className="row">
          <Button
            variant="ghost"
            disabled={!enabled}
            onClick={() => void task("刷新状态", refresh)}
            aria-label="刷新状态"
          >
            <RefreshCw size={16} />
          </Button>
          <Button
            variant="ghost"
            disabled={!!busy}
            onClick={() => setAdvanced(true)}
          >
            <Settings2 size={16} />
            设置
          </Button>
        </div>
      </header>
      <main className="daily-main">
        <div className="daily-title">
          <div>
            <span className="eyebrow">READY FOR WORK</span>
            <h1>今天，连哪几台？</h1>
            <p>确认 Mac 代理，选好机器，就可以开始工作。</p>
          </div>
          <span className="daily-local">
            <span className="live-dot" />
            本地运行
          </span>
        </div>
        {!native && (
          <div className="notice">
            原生后端未连接。请打开 NetDeck 桌面应用；此处不会模拟连接成功。
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
          <div role="status" className="notice">
            <RefreshCw size={14} className="spin" />
            {busy}…
          </div>
        )}
        <section className="daily-proxy">
          <div className="daily-proxy-icon">
            <Shield size={24} />
          </div>
          <div className="daily-proxy-copy">
            <small>MAC VPN 代理</small>
            <h2>
              {proxy
                ? `${proxy.host}:${proxy.port}`
                : candidates[0]
                  ? `发现端口 ${candidates[0].port}`
                  : "先打开你的 VPN"}
            </h2>
            <p>
              <span className={proxyWorks ? "daily-ok" : ""}>
                {proxyStatus}
              </span>
              {proxy &&
                ` · ${proxy.kind === "socks5-proxy" ? "SOCKS5" : "HTTP"}`}
            </p>
          </div>
          <div className="row">
            <Button
              variant="secondary"
              disabled={!enabled}
              onClick={() => {
                if (!proxy && candidates[0]) {
                  setProxyPort(candidates[0].port);
                  setProxyHost(candidates[0].host);
                  setProxyKind(
                    candidates[0].protocol.toLowerCase().includes("socks")
                      ? "socks5-proxy"
                      : "http-proxy",
                  );
                }
                setProxyOpen(true);
              }}
            >
              {proxy ? "更换端口" : "选择端口"}
            </Button>
            {proxy && (
              <Button
                disabled={!enabled}
                onClick={() =>
                  void task("检测 Mac 代理", async () => {
                    setValidatedProxy(null);
                    const result = await api.diagnose(proxy.id);
                    setProxyCheck(result[0] ?? null);
                  })
                }
              >
                检测
              </Button>
            )}
          </div>
        </section>
        {pendingPort && (
          <div className="daily-inline-notice">
            系统代理现在指向 {pendingPort.host}:{pendingPort.port}
            ，与已保存端口不同。
            <button
              onClick={() => {
                setProxyHost(pendingPort.host);
                setProxyPort(pendingPort.port);
                setProxyOpen(true);
              }}
            >
              查看并更换
              <ArrowRight size={13} />
            </button>
          </div>
        )}
        {proxyError && (
          <div className="daily-inline-notice">
            {proxyError.summary}
            <button onClick={() => setDetails(matchingCheck)}>查看原因</button>
          </div>
        )}
        <section className="daily-machines">
          <div className="daily-section-heading">
            <div className="row">
              <h2>我的机器</h2>
              <span className="daily-count">{machines.length}</span>
            </div>
            <Button
              variant="ghost"
              disabled={!enabled}
              onClick={() => newMachine()}
            >
              <Plus size={15} />
              添加机器
            </Button>
          </div>
          {machines.length === 0 ? (
            <div className="daily-empty">
              <div className="daily-empty-symbol">
                <Server size={27} />
              </div>
              <h3>把常用机器加进来</h3>
              <p>选一次 SSH 别名，以后开机只需点连接。</p>
              <Button disabled={!enabled} onClick={() => newMachine()}>
                添加第一台机器
              </Button>
              {!!snapshot?.sshAliases.length && (
                <div className="daily-aliases">
                  <small>从本机 SSH 配置发现</small>
                  <div>
                    {snapshot.sshAliases.slice(0, 6).map((a) => (
                      <button key={a} onClick={() => newMachine(a)}>
                        {a}
                        <Plus size={12} />
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="daily-machine-list">
              {machines.map((m) => {
                const r = runtime.find((r) => r.id === m.id);
                const running = r?.status === "healthy";
                const v = verified[m.id];
                const verifiedNow =
                  running &&
                  v &&
                  v.at >= Date.parse(r.startedAt) &&
                  Date.now() - v.at < 120000;
                const status = verifiedNow
                  ? v.success
                    ? "远端网络可用"
                    : "远端出口未通过"
                  : running
                    ? "已连接 · 出口待检查"
                    : r?.status === "down"
                      ? "连接已断开"
                      : "未连接";
                return (
                  <article className="daily-machine" key={m.id}>
                    <input
                      type="checkbox"
                      aria-label={`选择 ${m.label}`}
                      checked={selected.includes(m.id)}
                      onChange={(e) =>
                        setSelected((old) =>
                          e.target.checked
                            ? [...old, m.id]
                            : old.filter((id) => id !== m.id),
                        )
                      }
                    />
                    <div className="daily-server-icon">
                      <Server size={21} />
                    </div>
                    <div className="daily-machine-copy">
                      <div className="row">
                        <h3>{m.label}</h3>
                        <span className="daily-route">
                          {m.route === "slai" ? "SLAI 内网" : "公网"}
                        </span>
                      </div>
                      <code>{m.alias}</code>
                      <p
                        className={
                          verifiedNow && v.success
                            ? "daily-ok"
                            : r?.status === "down" ||
                                (verifiedNow && !v.success)
                              ? "daily-fail"
                              : ""
                        }
                      >
                        {verifiedNow && v.success && <Check size={12} />}{" "}
                        {status}
                      </p>
                    </div>
                    <div className="daily-machine-actions">
                      <Button
                        variant="ghost"
                        disabled={!enabled}
                        onClick={() =>
                          setMachine({ ...m, route: m.route ?? "public" })
                        }
                      >
                        设置
                      </Button>
                      {running ? (
                        <>
                          <Button
                            variant="secondary"
                            disabled={!enabled}
                            onClick={() =>
                              void task("准备出口检查", () =>
                                prepare(`检查 ${m.label} 的远端网络`, [
                                  {
                                    request: {
                                      kind: "remote-check",
                                      alias: m.alias,
                                      port: m.listenPort,
                                      url:
                                        proxy?.testUrl ||
                                        "https://example.com/",
                                    },
                                    machineId: m.id,
                                  },
                                ]),
                              )
                            }
                          >
                            检查出口
                          </Button>
                          <Button
                            variant="secondary"
                            disabled={!enabled}
                            onClick={() => disconnect([m])}
                          >
                            断开
                          </Button>
                        </>
                      ) : (
                        <Button
                          disabled={!enabled}
                          onClick={() => connect([m])}
                        >
                          连接
                          <ArrowRight size={14} />
                        </Button>
                      )}
                    </div>
                    {(running || r?.status === "down" || v) && (
                      <details className="daily-machine-details">
                        <summary>
                          使用与排障
                          <ChevronDown size={12} />
                        </summary>
                        <p>{v?.detail || r?.detail}</p>
                        <div className="row">
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() =>
                              void task("复制连接命令", async () => {
                                await navigator.clipboard.writeText(
                                  `ssh ${m.alias}`,
                                );
                                setNotice("SSH 命令已复制。");
                              })
                            }
                          >
                            复制 SSH 命令
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() =>
                              void task("复制远端代理设置", async () => {
                                await navigator.clipboard.writeText(
                                  `export HTTP_PROXY=http://127.0.0.1:${m.listenPort}\nexport HTTPS_PROXY="$HTTP_PROXY"\nexport http_proxy="$HTTP_PROXY"\nexport https_proxy="$HTTPS_PROXY"`,
                                );
                                setNotice(
                                  "已复制。在远端终端执行，再启动 Codex / Git。",
                                );
                              })
                            }
                          >
                            复制远端代理设置
                          </Button>
                        </div>
                        <small>
                          断开后如需清除远端当前 Shell 设置：unset HTTP_PROXY
                          HTTPS_PROXY http_proxy https_proxy
                        </small>
                      </details>
                    )}
                  </article>
                );
              })}
            </div>
          )}
          {machines.length > 0 && (
            <div className="daily-batch">
              <label>
                <input
                  type="checkbox"
                  aria-label="全选机器"
                  checked={
                    machines.length > 0 &&
                    machines.every((m) => selected.includes(m.id))
                  }
                  onChange={(e) =>
                    setSelected(
                      e.target.checked ? machines.map((m) => m.id) : [],
                    )
                  }
                />
                全选<span>已选 {selectedMachines.length} 台</span>
              </label>
              <div className="row">
                <Button
                  variant="ghost"
                  disabled={
                    !enabled ||
                    !selectedMachines.some((m) =>
                      runtime.some(
                        (r) => r.id === m.id && r.status === "healthy",
                      ),
                    )
                  }
                  onClick={() =>
                    disconnect(
                      selectedMachines.filter((m) =>
                        runtime.some(
                          (r) => r.id === m.id && r.status === "healthy",
                        ),
                      ),
                    )
                  }
                >
                  断开所选
                </Button>
                <Button
                  disabled={!enabled || !selectedMachines.length}
                  onClick={() => connect(selectedMachines)}
                >
                  <Power size={15} />
                  连接所选
                </Button>
              </div>
            </div>
          )}
        </section>
        <div className="daily-bottom">
          <span>
            <Globe2 size={14} />
            公网直连 SSH
          </span>
          <span>
            <Waypoints size={14} />
            SLAI 经 Tailscale ·{" "}
            {snapshot?.tailscale?.state === "Running"
              ? "已开启"
              : (snapshot?.tailscale?.state ?? "尚未发现")}
          </span>
          <span>连接时自动检查代理与远端出口</span>
        </div>
      </main>
      <Sheet
        open={proxyOpen}
        onClose={() => setProxyOpen(false)}
        title="Mac VPN 代理"
        description="选择 VPN 当前的本地代理端口。NetDeck 会把它转发给你选中的机器。"
      >
        <form
          className="profile-form"
          onSubmit={(e) => {
            e.preventDefault();
            void task("保存代理", () => configureProxy());
          }}
        >
          {candidates.length > 0 && (
            <div className="daily-detected">
              <small>系统当前配置（尚未验证）</small>
              {candidates.map((p, i) => (
                <button
                  type="button"
                  key={i}
                  onClick={() => {
                    setProxyHost(p.host);
                    setProxyPort(p.port);
                    setProxyKind(
                      p.protocol.toLowerCase().includes("socks")
                        ? "socks5-proxy"
                        : "http-proxy",
                    );
                  }}
                >
                  {p.protocol} · {p.host}:{p.port}
                </button>
              ))}
            </div>
          )}
          <label>
            代理主机
            <input
              required
              value={proxyHost}
              onChange={(e) => setProxyHost(e.target.value)}
            />
          </label>
          <div className="form-row">
            <label>
              VPN 端口
              <input
                required
                type="number"
                min={1}
                max={65535}
                value={proxyPort}
                onChange={(e) => setProxyPort(Number(e.target.value))}
              />
            </label>
            <label>
              协议
              <select
                aria-label="代理协议"
                value={proxyKind}
                onChange={(e) =>
                  setProxyKind(e.target.value as typeof proxyKind)
                }
              >
                <option value="http-proxy">HTTP</option>
                <option value="socks5-proxy">SOCKS5</option>
              </select>
            </label>
          </div>
          <Button disabled={!enabled} type="submit">
            使用这个代理
          </Button>
          <small>保存后允许检测此代理。不会修改 macOS 系统代理。</small>
          {snapshot?.listeners.length ? (
            <details>
              <summary>没有找到？查看本机监听端口</summary>
              <div className="daily-listeners">
                {snapshot.listeners.map((l, i) => (
                  <p key={i}>
                    <code>{l.address}</code>
                    <small>{l.process}</small>
                  </p>
                ))}
              </div>
              <small>监听端口不一定是代理，请对照 VPN 软件设置确认协议。</small>
            </details>
          ) : null}
        </form>
      </Sheet>
      <Sheet
        open={!!machine}
        onClose={() => setMachine(null)}
        title={
          machine && machines.some((m) => m.id === machine.id)
            ? "机器设置"
            : "添加机器"
        }
        description="只需选 SSH 别名和访问方式。代理转发默认自动配置。"
      >
        {machine && (
          <form
            className="profile-form"
            onSubmit={(e) => {
              e.preventDefault();
              void task("保存机器", async () => {
                await save({
                  ...config,
                  controls: {
                    ...config.controls,
                    tunnels: [
                      ...config.controls.tunnels.filter(
                        (t) => t.id !== machine.id,
                      ),
                      machine,
                    ],
                  },
                });
                setSelected((old) =>
                  old.includes(machine.id) ? old : [...old, machine.id],
                );
                setMachine(null);
                setNotice("机器已保存，点击连接即可。");
              });
            }}
          >
            <label>
              机器名称
              <input
                required
                maxLength={100}
                placeholder="例如：Coder 工作机"
                value={machine.label}
                onChange={(e) =>
                  setMachine({ ...machine, label: e.target.value })
                }
              />
            </label>
            <label>
              SSH 别名
              <input
                required
                list="daily-ssh-aliases"
                placeholder="选择已有 SSH 配置"
                value={machine.alias}
                onChange={(e) =>
                  setMachine({ ...machine, alias: e.target.value })
                }
              />
              <datalist id="daily-ssh-aliases">
                {snapshot?.sshAliases.map((a) => (
                  <option key={a} value={a} />
                ))}
              </datalist>
            </label>
            <label>
              访问方式
              <select
                aria-label="访问方式"
                value={machine.route ?? "public"}
                onChange={(e) =>
                  setMachine({
                    ...machine,
                    route: e.target.value as "public" | "slai",
                  })
                }
              >
                <option value="public">公网 · 直接连接</option>
                <option value="slai">SLAI · 经 Tailscale</option>
              </select>
            </label>
            {machine.route === "slai" && (
              <small>
                连接时会检查
                Tailscale，必要时在确认方案中加入启动。目标地址、跳板和子网路由沿用已有设置；不擅自修改全局出口。
              </small>
            )}
            <details>
              <summary>端口与转发规则</summary>
              <label>
                远端代理端口
                <input
                  required
                  type="number"
                  min={1}
                  max={65535}
                  value={machine.listenPort}
                  onChange={(e) =>
                    setMachine({
                      ...machine,
                      listenPort: Number(e.target.value),
                    })
                  }
                />
              </label>
              <label>
                Mac 转发目标
                <input
                  required
                  value={machine.targetHost}
                  onChange={(e) =>
                    setMachine({ ...machine, targetHost: e.target.value })
                  }
                />
              </label>
              <label>
                Mac 转发端口
                <input
                  required
                  type="number"
                  min={1}
                  max={65535}
                  value={machine.targetPort}
                  onChange={(e) =>
                    setMachine({
                      ...machine,
                      targetPort: Number(e.target.value),
                    })
                  }
                />
              </label>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={machine.reuseConfig}
                  onChange={(e) =>
                    setMachine({ ...machine, reuseConfig: e.target.checked })
                  }
                />
                沿用 SSH Config 转发规则
              </label>
              <small>
                默认由稳定入口 {config.controls.gatewayPort} 转发，VPN
                端口变化时无需更改每台机器。沿用 Config
                时，远端代理端口须与实际规则一致。
              </small>
            </details>
            <div className="row">
              <Button disabled={!enabled} type="submit">
                保存机器
              </Button>
              {machines.some((m) => m.id === machine.id) && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={
                    !enabled ||
                    runtime.some(
                      (r) => r.id === machine.id && r.status === "healthy",
                    )
                  }
                  onClick={() =>
                    void task("删除机器", async () => {
                      await save({
                        ...config,
                        controls: {
                          ...config.controls,
                          tunnels: config.controls.tunnels.filter(
                            (t) => t.id !== machine.id,
                          ),
                        },
                      });
                      setMachine(null);
                    })
                  }
                >
                  删除机器
                </Button>
              )}
            </div>
          </form>
        )}
      </Sheet>
      <Sheet
        open={!!batch}
        onClose={closeBatch}
        title={batch?.title ?? "确认操作"}
        description="确认后按顺序执行；任何一步失败都会停下并说明原因。"
      >
        {batch && (
          <div className="daily-confirm">
            <ol>
              {batch.steps.map((s, i) => (
                <li key={s.plan.id}>
                  <span>{i + 1}</span>
                  {s.plan.title}
                </li>
              ))}
            </ol>
            {[...new Set(batch.steps.flatMap((s) => s.plan.warnings))].map(
              (w) => (
                <p className="daily-warning" key={w}>
                  {w}
                </p>
              ),
            )}
            <details>
              <summary>具体命令与恢复方式</summary>
              {batch.steps.map((s) => (
                <div key={s.plan.id}>
                  <pre>{s.plan.commands.join("\n")}</pre>
                  <p>{s.plan.rollback}</p>
                </div>
              ))}
            </details>
            <div className="row">
              <Button disabled={!enabled} onClick={() => void execute()}>
                确认执行
              </Button>
              <Button variant="secondary" onClick={closeBatch}>
                取消
              </Button>
            </div>
          </div>
        )}
      </Sheet>
      <Sheet
        open={!!details}
        onClose={() => setDetails(null)}
        title="代理检查结果"
      >
        {details && <EvidenceList steps={details.steps} />}
      </Sheet>
    </div>
  );
}
