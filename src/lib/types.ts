export type Health =
  "healthy" | "degraded" | "down" | "unknown" | "checking" | "not-configured";
export type Source = "observed" | "configured" | "historical" | "mock";
export type Kind =
  "tcp" | "https" | "http-proxy" | "socks5-proxy" | "ssh" | "tailscale";
export interface Evidence {
  check: string;
  status: Health;
  source: Source;
  summary: string;
  detail: string;
  checkedAt: string;
  latencyMs: number;
  errorCode: string | null;
}
export interface Profile {
  id: string;
  label: string;
  kind: Kind;
  enabled: boolean;
  source: Source;
  host: string;
  port: number;
  sshAlias: string;
  testUrl: string;
  expectedCidr: string;
}
export interface Preferences {
  theme: "dark" | "light";
  refreshSeconds: number;
  autoDiagnose: boolean;
  diagnoseSeconds: number;
}
export interface Config {
  version: number;
  profiles: Profile[];
  preferences: Preferences;
  controls: Controls;
}
export interface Diagnostic {
  profileId: string;
  profileSignature?: string;
  label: string;
  status: Health;
  startedAt: string;
  finishedAt: string;
  cancelled: boolean;
  steps: Evidence[];
}
export interface ProxyEndpoint {
  protocol: string;
  host: string;
  port: number;
  enabled: boolean;
}
export interface Peer {
  name: string;
  ips: string[];
  online: boolean;
  os: string;
  routes: string[];
}
export interface Snapshot {
  capturedAt: string;
  osVersion: string;
  arch: string;
  defaultRoute: Record<string, string>;
  systemProxy: {
    endpoints: ProxyEndpoint[];
    pacEnabled: boolean;
    pacUrl: string | null;
    bypass: string[];
  };
  shellProxy: Record<string, string>;
  listeners: { process: string; pid: number; address: string }[];
  tailscale: {
    state: string;
    selfIps: string[];
    peers: Peer[];
    acceptRoutes: boolean | null;
    exitNode: string | null;
  } | null;
  sshAliases: string[];
  evidence: Evidence[];
}
export const defaultConfig: Config = {
  version: 2,
  controls: {
    tunnels: [],
    workflows: [],
    gatewayProfileId: "",
    gatewayPort: 18080,
  },
  profiles: [],
  preferences: {
    theme: "dark",
    refreshSeconds: 15,
    autoDiagnose: false,
    diagnoseSeconds: 60,
  },
};
export const kindLabels: Record<Kind, string> = {
  tcp: "TCP 服务",
  https: "HTTPS 服务",
  "http-proxy": "HTTP Proxy",
  "socks5-proxy": "SOCKS5 Proxy",
  ssh: "SSH 主机",
  tailscale: "Tailscale Peer",
};
export const stepLabels: Record<string, string> = {
  configured: "配置确认",
  "ssh-config": "SSH 生效配置",
  forwarding: "转发规则",
  dns: "DNS 解析",
  cidr: "子网范围",
  route: "系统路由",
  tcp: "TCP 连接",
  "proxy-handshake": "代理握手",
  https: "HTTPS 出口",
  "ssh-auth": "SSH / 远端应用",
  "tailscale-ping": "Overlay 连通性",
  "system-proxy": "系统代理",
  "default-route": "默认路由",
  listeners: "监听端口",
  tailscale: "Tailscale 状态",
};
export const healthLabels: Record<Health, string> = {
  healthy: "正常",
  degraded: "部分可用",
  down: "检测失败",
  unknown: "未验证",
  checking: "检测中",
  "not-configured": "未配置",
};
export const sourceLabels: Record<Source, string> = {
  observed: "Observed",
  configured: "Configured",
  historical: "Historical",
  mock: "Mock",
};
export function isStale(at?: string, ageSeconds = 120): boolean {
  return !!at && Date.now() - new Date(at).getTime() > ageSeconds * 1000;
}
export function clockTime(at?: string): string {
  return at
    ? new Date(at).toLocaleTimeString("zh-CN", { hour12: false })
    : "尚未检查";
}
export function freshProfile(): Profile {
  return {
    id: crypto.randomUUID(),
    label: "",
    kind: "tcp",
    enabled: false,
    source: "configured",
    host: "",
    port: 443,
    sshAlias: "",
    testUrl: "",
    expectedCidr: "",
  };
}
export const historical: Profile[] = [
  {
    ...freshProfile(),
    id: "slai-windows",
    label: "研究院 Windows",
    kind: "tailscale",
    host: "100.100.169.35",
    port: 22,
    source: "historical",
  },
  {
    ...freshProfile(),
    id: "slai-proxy",
    label: "SLAI 共享代理",
    kind: "http-proxy",
    host: "10.204.100.80",
    port: 16699,
    testUrl: "https://example.com/",
    expectedCidr: "10.204.96.0/21",
    source: "historical",
  },
  {
    ...freshProfile(),
    id: "cci",
    label: "商汤 CCI",
    kind: "ssh",
    sshAlias: "slai-CCI-1",
    source: "historical",
  },
  {
    ...freshProfile(),
    id: "coder",
    label: "Coder Workspace",
    kind: "ssh",
    sshAlias: "main.yihang-wm.yihangcs.coder",
    source: "historical",
  },
];

export interface TunnelDefinition {
  route?: "public" | "slai";
  id: string;
  label: string;
  alias: string;
  direction: "local" | "remote";
  listenPort: number;
  targetHost: string;
  targetPort: number;
  reuseConfig: boolean;
}
export interface Workflow {
  id: string;
  label: string;
  profileIds: string[];
}
export interface Controls {
  tunnels: TunnelDefinition[];
  workflows: Workflow[];
  gatewayProfileId: string;
  gatewayPort: number;
}
export type Operation =
  | ({ kind: "tunnel-start" } & Omit<TunnelDefinition, "label" | "route">)
  | { kind: "tunnel-stop"; id: string }
  | { kind: "ssh-auth"; alias: string }
  | { kind: "remote-check"; alias: string; port: number; url: string }
  | { kind: "gateway-start"; profileId: string; port: number }
  | { kind: "gateway-stop" }
  | {
      kind: "tailscale";
      setting: "connected" | "accept-routes" | "exit-node";
      value: string;
    }
  | {
      kind: "system-proxy";
      service: string;
      protocol: string;
      host: string;
      port: number;
      enabled: boolean;
    }
  | { kind: "rollback"; id: string };
export interface Plan {
  id: string;
  title: string;
  commands: string[];
  warnings: string[];
  rollback: string;
}
export interface RuntimeItem {
  id: string;
  label: string;
  status: Health;
  detail: string;
  startedAt: string;
}
export interface Receipt {
  id: string;
  at: string;
  title: string;
  success: boolean;
  detail: string;
  reversible: boolean;
}

export const profileSignature = (p: Profile) =>
  JSON.stringify([
    p.id,
    p.label,
    p.kind,
    p.enabled,
    p.source,
    p.host,
    p.port,
    p.sshAlias,
    p.testUrl,
    p.expectedCidr,
  ]);
