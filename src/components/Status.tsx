import {
  Check,
  CircleHelp,
  AlertTriangle,
  Loader2,
  X,
  Minus,
} from "lucide-react";
import {
  healthLabels,
  sourceLabels,
  type Health,
  type Source,
  type Evidence,
  stepLabels,
  clockTime,
  isStale,
} from "../lib/types";
export function Status({
  status,
  stale = false,
}: {
  status: Health;
  stale?: boolean;
}) {
  const Icon = stale
    ? CircleHelp
    : {
        healthy: Check,
        degraded: AlertTriangle,
        down: X,
        unknown: CircleHelp,
        checking: Loader2,
        "not-configured": Minus,
      }[status];
  return (
    <span className={`status status-${stale ? "unknown" : status}`}>
      <Icon size={12} className={status === "checking" ? "spin" : ""} />
      {stale ? "已过期" : healthLabels[status]}
    </span>
  );
}
export function SourceBadge({ source }: { source: Source }) {
  return (
    <span className={`source source-${source}`}>{sourceLabels[source]}</span>
  );
}
export function EvidenceList({ steps }: { steps: Evidence[] }) {
  return (
    <div className="evidence-list">
      {steps.map((s, i) => (
        <details key={`${s.check}-${i}`} className="evidence-step">
          <summary>
            <span className={`step-number ${s.status}`}>
              {String(i + 1).padStart(2, "0")}
            </span>
            <span className="step-main">
              <strong>
                <span>{stepLabels[s.check] ?? s.check}</span>{" "}
                <SourceBadge source={s.source} />
              </strong>
              <span>{s.summary}</span>
            </span>
            <Status status={s.status} stale={isStale(s.checkedAt)} />
          </summary>
          <div className="step-detail">
            <div className="inline-meta">
              <span>{clockTime(s.checkedAt)}</span>
              <span>{s.latencyMs} ms</span>
              {s.errorCode && <code>{s.errorCode}</code>}
            </div>
            <pre>{s.detail}</pre>
          </div>
        </details>
      ))}
    </div>
  );
}
