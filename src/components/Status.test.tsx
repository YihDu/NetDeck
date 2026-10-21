import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Status, SourceBadge, EvidenceList } from "./Status";
import { isStale, historical } from "../lib/types";
describe("evidence semantics", () => {
  it("never paints unknown as healthy", () => {
    render(<Status status="unknown" />);
    expect(screen.getByText("未验证")).toHaveClass("status-unknown");
    expect(screen.queryByText("正常")).not.toBeInTheDocument();
  });
  it("replaces expired healthy result with stale", () => {
    render(<Status status="healthy" stale />);
    expect(screen.getByText("已过期")).toHaveClass("status-unknown");
    expect(screen.queryByText("正常")).not.toBeInTheDocument();
  });
  it("marks mock evidence explicitly", () => {
    render(<SourceBadge source="mock" />);
    expect(screen.getByText("Mock")).toHaveClass("source-mock");
  });
  it("shows each failing layer and its evidence", () => {
    render(
      <EvidenceList
        steps={[
          {
            check: "proxy-handshake",
            status: "down",
            source: "mock",
            summary: "CONNECT 返回 407",
            detail: "端口开放不代表代理可用",
            checkedAt: new Date().toISOString(),
            latencyMs: 52,
            errorCode: "proxy-auth-required",
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByText("代理握手"));
    expect(screen.getByText("CONNECT 返回 407")).toBeInTheDocument();
    expect(screen.getByText("proxy-auth-required")).toBeInTheDocument();
    expect(screen.getByText("Mock")).toBeInTheDocument();
  });
  it("historical imports are disabled", () => {
    expect(historical.length).toBeGreaterThan(0);
    expect(
      historical.every((p) => !p.enabled && p.source === "historical"),
    ).toBe(true);
  });
  it("detects stale timestamps", () => {
    expect(isStale(new Date(Date.now() - 121000).toISOString())).toBe(true);
    expect(isStale(new Date().toISOString())).toBe(false);
  });
});
