import { render, screen } from "@testing-library/react";
import { it, expect } from "vitest";
import App from "./App";
it("daily home has just a proxy and machine list, with real actions disabled in browser", () => {
  render(<App />);
  expect(
    screen.getByRole("heading", { name: "今天，连哪几台？" }),
  ).toBeInTheDocument();
  expect(screen.getByText(/原生后端未连接/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "选择端口" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "添加第一台机器" })).toBeDisabled();
  expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
});
it("does not make users read scenario instructions on startup", () => {
  render(<App />);
  expect(screen.queryByText("按场景处理")).not.toBeInTheDocument();
  expect(screen.queryByText("这条路径的检查顺序")).not.toBeInTheDocument();
  expect(screen.queryByText(/Magpie/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "设置" })).toBeEnabled();
});
