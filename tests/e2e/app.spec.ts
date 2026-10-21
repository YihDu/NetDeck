import { test, expect } from "@playwright/test";
import fixture from "../fixtures/live-contract.mock.json" with { type: "json" };
test("browser preview remains read-only and renders all pages", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("原生后端未连接。")).toBeVisible();
  await expect(page.getByRole("button", { name: /诊断全部/ })).toBeDisabled();
  await page.screenshot({
    path: "test-results/overview-preview.png",
    fullPage: true,
  });
  for (const name of [
    "网络拓扑",
    "连接管理",
    "SSH 隧道",
    "诊断中心",
    "活动与日志",
    "设置",
  ]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.locator("h1")).toBeVisible();
  }
  await page.getByRole("button", { name: "浅色", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});
test("Mock native contract: empty Tailscale, profile CRUD, diagnose, details, copy and delete", async ({
  page,
}) => {
  await page.addInitScript(
    ({ fixture }) => {
      const snap = { ...fixture, capturedAt: new Date().toISOString() };
      let config = {
        version: 1,
        profiles: [] as Record<string, unknown>[],
        preferences: {
          theme: "dark",
          refreshSeconds: 15,
          autoDiagnose: false,
          diagnoseSeconds: 60,
        },
      };
      let history: unknown[] = [];
      Object.assign(window, {
        __TAURI_INTERNALS__: {
          invoke: async (cmd: string, args: Record<string, unknown>) => {
            if (cmd === "get_network_snapshot") return snap;
            if (cmd === "load_config") return config;
            if (cmd === "get_history") return history;
            if (cmd === "save_config") {
              config = args.config as typeof config;
              return;
            }
            if (cmd === "run_diagnostics") {
              const p = config.profiles[0];
              const now = new Date().toISOString();
              const result = {
                profileId: p.id,
                label: p.label,
                status: "degraded",
                startedAt: now,
                finishedAt: now,
                cancelled: false,
                steps: [
                  {
                    check: "tcp",
                    status: "healthy",
                    source: "mock",
                    summary: "Mock TCP 已连接",
                    detail: "本步骤为测试夹具",
                    checkedAt: now,
                    latencyMs: 1,
                    errorCode: null,
                  },
                  {
                    check: "proxy-handshake",
                    status: "down",
                    source: "mock",
                    summary: "Mock CONNECT 407",
                    detail: "端口开放不代表代理可用",
                    checkedAt: now,
                    latencyMs: 3,
                    errorCode: "proxy-auth-required",
                  },
                ],
              };
              history = [result];
              return [result];
            }
            if (cmd === "copy_report") {
              document.body.dataset.copied = "true";
              return;
            }
            if (cmd === "cancel_diagnostics") return;
            throw new Error(`Unknown test command ${cmd}`);
          },
        },
      });
    },
    { fixture },
  );
  await page.goto("/");
  await expect(page.getByText("Mock：未找到 Tailscale CLI")).toBeVisible();
  await page.getByRole("button", { name: "连接管理", exact: true }).click();
  await page.getByRole("button", { name: "新增连接", exact: true }).click();
  await page.getByLabel("连接名称").fill("Mock 本地代理");
  await page.getByLabel("检测类型").selectOption("http-proxy");
  await page.getByLabel("主机 / IP").fill("127.0.0.1");
  await page.getByLabel("端口", { exact: true }).fill("7892");
  await page.getByLabel("确认目标并启用主动检测").check();
  await page.getByRole("button", { name: "保存连接", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Mock 本地代理" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "诊断", exact: true }).click();
  await expect(page.getByText("Mock CONNECT 407")).toBeVisible();
  await page.getByText("代理握手", { exact: true }).click();
  await expect(page.getByText("proxy-auth-required")).toBeVisible();
  await expect(page.getByText("Mock", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "复制报告", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-copied", "true");
  await page.screenshot({
    path: "test-results/diagnostics-mock.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "连接管理", exact: true }).click();
  await page.getByRole("button", { name: "删除 Mock 本地代理" }).click();
  await page.getByRole("button", { name: "删除连接", exact: true }).click();
  await expect(page.getByText("让你的连接有一个家")).toBeVisible();
});

test("cancellation preserves partial results and historical import stays disabled", async ({
  page,
}) => {
  await page.addInitScript(
    ({ fixture }) => {
      const p = {
        id: "mock-cancel",
        label: "Mock 取消验证",
        kind: "tcp",
        enabled: true,
        source: "configured",
        host: "127.0.0.1",
        port: 9,
        sshAlias: "",
        testUrl: "",
        expectedCidr: "",
      };
      const config = {
        version: 1,
        profiles: [p],
        preferences: {
          theme: "dark",
          refreshSeconds: 15,
          autoDiagnose: false,
          diagnoseSeconds: 60,
        },
      };
      let complete: ((r: unknown) => void) | undefined;
      Object.assign(window, {
        __TAURI_INTERNALS__: {
          invoke: async (cmd: string) => {
            if (cmd === "get_network_snapshot")
              return { ...fixture, capturedAt: new Date().toISOString() };
            if (cmd === "load_config") return config;
            if (cmd === "get_history") return [];
            if (cmd === "run_diagnostics")
              return new Promise((resolve) => {
                complete = resolve;
              });
            if (cmd === "cancel_diagnostics") {
              const at = new Date().toISOString();
              complete?.([
                {
                  profileId: p.id,
                  label: p.label,
                  status: "unknown",
                  startedAt: at,
                  finishedAt: at,
                  cancelled: true,
                  steps: [
                    {
                      check: "tcp",
                      status: "unknown",
                      source: "mock",
                      summary: "Mock：检测已取消",
                      detail: "保留已完成步骤",
                      checkedAt: at,
                      latencyMs: 2,
                      errorCode: "cancelled",
                    },
                  ],
                },
              ]);
              return;
            }
            throw new Error(cmd);
          },
        },
      });
    },
    { fixture },
  );
  await page.goto("/");
  await expect(page.getByRole("button", { name: /诊断全部/ })).toBeEnabled();
  await page.getByRole("button", { name: /诊断全部/ }).click();
  await page.getByRole("button", { name: "取消诊断", exact: true }).click();
  await expect(page.getByText("已取消 · 已完成步骤仍可查看")).toBeVisible();
  await expect(page.getByText("Mock：检测已取消")).toBeVisible();
  await page.getByRole("button", { name: "连接管理", exact: true }).click();
  await page.getByRole("button", { name: "导入历史线索", exact: true }).click();
  await expect(
    page.getByText(
      "这些地址来自历史记录，可能已失效。导入后保持禁用，编辑确认后才能启用。",
    ),
  ).toBeVisible();
});
