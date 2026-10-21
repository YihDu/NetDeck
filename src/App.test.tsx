import { render, screen, fireEvent } from "@testing-library/react";
import { it, expect, vi } from "vitest";
vi.mock("./components/NetworkMap", () => ({
  NetworkMap: () => <div>Topology</div>,
}));
import App from "./App";
it("browser preview is explicitly unavailable and disables diagnostics", () => {
  render(<App />);
  expect(screen.getByText("原生后端未连接。")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /诊断全部/ })).toBeDisabled();
});
it("empty connections have an actionable explanation", () => {
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "连接管理" }));
  expect(screen.getByText("让你的连接有一个家")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /添加第一个连接/ })).toBeDisabled();
});
