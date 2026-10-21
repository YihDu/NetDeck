import { useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  MarkerType,
  type Node,
  type NodeProps,
  type Edge,
} from "@xyflow/react";
import {
  Laptop,
  Globe2,
  Server,
  Shield,
  Network,
  ArrowUpRight,
} from "lucide-react";
import "@xyflow/react/dist/style.css";
import { Status, SourceBadge } from "./Status";
import {
  isStale,
  type Health,
  type Source,
  type Snapshot,
  type Profile,
  type Diagnostic,
} from "../lib/types";
type DeviceData = {
  label: string;
  sub: string;
  kind: string;
  status: Health;
  source: Source;
  detail: unknown;
};
type DeviceNode = Node<DeviceData, "device">;
const icons: Record<string, typeof Laptop> = {
  mac: Laptop,
  proxy: Shield,
  peer: Server,
  service: Globe2,
  overlay: Network,
};
function Device({ data }: NodeProps<DeviceNode>) {
  const Icon = icons[data.kind] ?? Server;
  return (
    <div className={`map-node node-${data.kind}`}>
      <Handle type="target" position={Position.Left} />
      <div className="node-top">
        <span className="node-icon">
          <Icon size={18} />
        </span>
        <SourceBadge source={data.source} />
      </div>
      <strong>{data.label}</strong>
      <small>{data.sub}</small>
      <div className="node-bottom">
        <Status status={data.status} />
        <ArrowUpRight size={13} />
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { device: Device };
export function NetworkMap({
  snapshot,
  profiles,
  results,
  onInspect,
  compact = false,
}: {
  snapshot: Snapshot | null;
  profiles: Profile[];
  results: Diagnostic[];
  onInspect: (title: string, detail: unknown) => void;
  compact?: boolean;
}) {
  const [filter, setFilter] = useState("all");
  const { nodes, edges } = useMemo(() => {
    const nodes: DeviceNode[] = [];
    const edges: Edge[] = [];
    const add = (
      id: string,
      label: string,
      sub: string,
      kind: string,
      status: Health,
      source: Source,
      x: number,
      y: number,
      detail: unknown,
      parent?: string,
      protocol?: string,
      verified = false,
    ) => {
      nodes.push({
        id,
        type: "device",
        position: { x, y },
        data: { label, sub, kind, status, source, detail },
      });
      if (parent)
        edges.push({
          id: `${parent}-${id}`,
          source: parent,
          target: id,
          label: protocol,
          type: "smoothstep",
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: status === "down" ? "#df7379" : "#657384",
          },
          style: {
            stroke:
              status === "down"
                ? "#df7379"
                : verified && status === "healthy"
                  ? "#69bfa8"
                  : "#657384",
            strokeWidth: 1.5,
            strokeDasharray: verified ? undefined : "5 5",
          },
          data: { title: protocol, detail },
        });
    };
    add(
      "mac",
      "这台 Mac",
      snapshot
        ? `macOS ${snapshot.osVersion} · ${snapshot.arch}`
        : "等待本机发现",
      "mac",
      snapshot && !isStale(snapshot.capturedAt) ? "healthy" : "unknown",
      snapshot ? "observed" : "configured",
      30,
      190,
      snapshot ?? "原生后端尚未连接",
    );
    let row = 0;
    if (filter === "all" || filter === "proxy")
      for (const p of snapshot?.systemProxy.endpoints.filter(
        (p) => p.enabled,
      ) ?? []) {
        const profile = profiles.find(
          (x) => x.host === p.host && x.port === p.port && x.enabled,
        );
        const r = results.find((r) => r.profileId === profile?.id);
        const fresh = r && !isStale(r.finishedAt);
        add(
          `proxy-${p.protocol}`,
          `${p.protocol.toUpperCase()} Proxy`,
          `${p.host}:${p.port}`,
          "proxy",
          fresh ? r.status : "unknown",
          "configured",
          350,
          row++ * 200,
          p,
          "mac",
          p.protocol === "socks5" ? "SOCKS5" : "HTTP Proxy",
          !!fresh,
        );
      }
    if (snapshot?.tailscale && (filter === "all" || filter === "tailscale")) {
      add(
        "tailnet",
        "Tailscale",
        snapshot.tailscale.state,
        "overlay",
        "unknown",
        "configured",
        350,
        row++ * 200,
        snapshot.tailscale,
        "mac",
        "Overlay",
      );
      snapshot.tailscale.peers
        .slice(0, 4)
        .forEach((p, i) =>
          add(
            `peer-${i}`,
            p.name,
            p.ips[0] ?? p.os,
            "peer",
            "unknown",
            "configured",
            690,
            i * 200,
            p,
            "tailnet",
            "Tailscale · 未探测",
          ),
        );
    }
    const visible = profiles.filter(
      (p) => filter === "all" || p.kind.includes(filter),
    );
    visible.forEach((p, i) => {
      const r = results.find((r) => r.profileId === p.id);
      const fresh = r && !isStale(r.finishedAt);
      add(
        p.id,
        p.label,
        p.sshAlias || `${p.host}:${p.port}`,
        p.kind.includes("proxy") ? "proxy" : "service",
        fresh ? r.status : "unknown",
        fresh ? "observed" : p.source,
        1020,
        i * 200,
        r ?? p,
        "mac",
        p.kind,
        !!fresh,
      );
    });
    return { nodes, edges };
  }, [snapshot, profiles, results, filter]);
  return (
    <div className={`network-map ${compact ? "compact" : ""}`}>
      {!compact && (
        <div className="map-toolbar">
          <span className="eyebrow">CONNECTION TOPOLOGY</span>
          <select
            aria-label="拓扑筛选"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">全部连接</option>
            <option value="proxy">代理</option>
            <option value="ssh">SSH</option>
            <option value="tailscale">Tailscale</option>
          </select>
        </div>
      )}
      <ReactFlow
        key={`${compact}-${filter}-${nodes.length}`}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{
          padding: compact ? 0.25 : 0.18,
          maxZoom: compact ? 0.85 : 1,
        }}
        nodesDraggable={false}
        nodesConnectable={false}
        minZoom={0.15}
        maxZoom={1.5}
        onNodeClick={(_, n) => onInspect(n.data.label, n.data.detail)}
        onEdgeClick={(_, e) =>
          onInspect(String(e.data?.title ?? "连接"), e.data?.detail)
        }
        colorMode="dark"
        attributionPosition="bottom-left"
      >
        <Background color="var(--map-dot)" gap={22} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
      <div className="map-legend">
        <span>
          <i className="legend-line" />
          已验证链路
        </span>
        <span>
          <i className="legend-line dashed" />
          已配置 / 未验证
        </span>
      </div>
    </div>
  );
}
