import { render, screen, fireEvent } from "@testing-library/react";
import { it, expect, vi } from "vitest";
vi.mock("./components/NetworkMap", () => ({
  NetworkMap: () => <div>Topology</div>,
}));
import App from "./App";
it("browser preview clearly disables real actions", () => {
  render(<App />);
  expect(screen.getByText(/原生后端未连接/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "检查全部连接" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "添加第一个连接" })).toBeDisabled();
});
it("workflow guide explains reverse forwarding without pretending to connect", () => {
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: /让远端 Codex/ }));
  expect(screen.getByText("新建反向隧道")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "预览启动 / 切换" }),
  ).toBeDisabled();
  expect(screen.queryByText(/Magpie/)).not.toBeInTheDocument();
});
