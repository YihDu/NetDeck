import { useState } from "react";
import { Save, Info } from "lucide-react";
import { Button } from "./ui/button";
import { kindLabels, type Profile, type Kind } from "../lib/types";
export function ProfileForm({
  initial,
  aliases,
  onSave,
}: {
  initial: Profile;
  aliases: string[];
  onSave: (p: Profile) => Promise<void>;
}) {
  const [p, setP] = useState(initial);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const change = <K extends keyof Profile>(key: K, value: Profile[K]) =>
    setP((old) => ({ ...old, [key]: value }));
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const target = p.kind === "https" ? new URL(p.testUrl) : null;
      await onSave({
        ...p,
        ...(target
          ? {
              host: target.hostname.replace(/^\[|\]$/g, ""),
              port: Number(target.port || 443),
            }
          : {}),
        source: p.enabled ? "configured" : p.source,
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <form className="profile-form" onSubmit={submit}>
      {p.source === "historical" && (
        <div className="notice">
          <Info size={16} />
          历史线索尚未验证。请检查地址，再决定是否启用。
        </div>
      )}
      <label>
        连接名称
        <input
          required
          maxLength={100}
          value={p.label}
          onChange={(e) => change("label", e.target.value)}
          placeholder="例如：Coder Workspace"
        />
      </label>
      <label>
        检测类型
        <select
          value={p.kind}
          onChange={(e) => {
            const kind = e.target.value as Kind;
            setP({
              ...p,
              kind,
              testUrl: ["https", "http-proxy", "socks5-proxy"].includes(kind)
                ? p.testUrl || "https://example.com/"
                : "",
              port: kind === "ssh" ? 22 : kind === "https" ? 443 : p.port,
            });
          }}
        >
          {Object.entries(kindLabels).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      {p.kind === "ssh" ? (
        <label>
          SSH Host 别名
          <input
            required
            list="ssh-aliases"
            value={p.sshAlias}
            onChange={(e) => change("sshAlias", e.target.value)}
            placeholder="从 ~/.ssh/config 发现的明确别名"
          />
          <datalist id="ssh-aliases">
            {aliases.map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
          <small>只读解析生效配置；不会登录或创建转发。</small>
        </label>
      ) : p.kind !== "https" ? (
        <div className="form-row">
          <label>
            主机 / IP
            <input
              required
              value={p.host}
              onChange={(e) => change("host", e.target.value)}
              placeholder="127.0.0.1"
            />
          </label>
          <label>
            端口
            <input
              required
              type="number"
              min={1}
              max={65535}
              value={p.port}
              onChange={(e) => change("port", Number(e.target.value))}
            />
          </label>
        </div>
      ) : null}
      {["https", "http-proxy", "socks5-proxy"].includes(p.kind) && (
        <label>
          HTTPS 测试地址
          <input
            required
            type="url"
            value={p.testUrl}
            onChange={(e) => change("testUrl", e.target.value)}
            placeholder="https://example.com/"
          />
          <small>
            启用检测后会向此地址发送无认证 GET 请求；不跟随重定向。HTTPS
            类型以此 URL 为实际检测目标。
          </small>
        </label>
      )}
      {p.kind !== "tailscale" && (
        <label>
          预期子网（可选）
          <input
            value={p.expectedCidr}
            onChange={(e) => change("expectedCidr", e.target.value)}
            placeholder="例如：10.204.96.0/21"
          />
        </label>
      )}
      <label className="check-label">
        <input
          type="checkbox"
          checked={p.enabled}
          onChange={(e) => change("enabled", e.target.checked)}
        />
        <span>
          <strong>确认目标并启用主动检测</strong>
          <small>
            允许手动诊断以及设置中开启的定时检查，仅检测此 Profile。
          </small>
        </span>
      </label>
      {error && (
        <div role="alert" className="notice error">
          {error}
        </div>
      )}
      <Button type="submit" disabled={saving}>
        <Save size={15} />
        {saving ? "保存中…" : "保存连接"}
      </Button>
    </form>
  );
}
