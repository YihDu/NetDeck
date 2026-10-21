import { test, expect, type Page } from "@playwright/test";
import fixture from "../fixtures/live-contract.mock.json" with { type: "json" };
async function mock(page: Page) {
  await page.addInitScript(
    ({ fixture }) => {
      const at = () => new Date().toISOString();
      let config = {
        version: 2,
        profiles: [
          {
            id: "proxy",
            label: "Mock 本地代理",
            kind: "http-proxy",
            enabled: true,
            source: "configured",
            host: "127.0.0.1",
            port: 7892,
            sshAlias: "",
            testUrl: "https://example.com/",
            expectedCidr: "",
          },
        ],
        preferences: {
          theme: "dark",
          refreshSeconds: 15,
          autoDiagnose: false,
          diagnoseSeconds: 60,
        },
        controls: {
          tunnels: [],
          workflows: [],
          gatewayProfileId: "proxy",
          gatewayPort: 18080,
        },
      };
      const history: unknown[] = [];
      const receipts: unknown[] = [];
      let count = 0;
      let pending: Record<string, unknown> = {};
      Object.assign(window, {
        __TAURI_INTERNALS__: {
          invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
            if (cmd === "load_config") return config;
            if (cmd === "save_config") {
              config = args.config as typeof config;
              document.body.dataset.saved = JSON.stringify(config);
              return;
            }
            if (cmd === "get_network_snapshot")
              return { ...fixture, capturedAt: at() };
            if (cmd === "get_history") return history;
            if (cmd === "runtime_status") return [];
            if (cmd === "operation_history") return receipts;
            if (cmd === "network_services") return ["Wi-Fi"];
            if (cmd === "preview_operation") {
              pending = args.request as Record<string, unknown>;
              document.body.dataset.preview = JSON.stringify(pending);
              return {
                id: "plan-mock",
                title: "Mock 操作预览",
                commands: ["Mock：仅测试确认流程，不运行系统命令"],
                warnings: ["Mock 影响范围"],
                rollback: "Mock 恢复操作前设置",
              };
            }
            if (cmd === "execute_operation") {
              count++;
              document.body.dataset.executed = String(count);
              const r = {
                id: `mock-${count}`,
                at: at(),
                title: String(pending.kind),
                success: true,
                detail: "Mock 操作已验证",
                reversible: true,
              };
              receipts.push(r);
              return r;
            }
            if (cmd === "run_diagnostics" || cmd === "run_workflow") {
              document.body.dataset.workflow = String(args.workflowId ?? "");
              const result = {
                profileId: "proxy",
                profileSignature: JSON.stringify([
                  "proxy",
                  "Mock 本地代理",
                  "http-proxy",
                  true,
                  "configured",
                  "127.0.0.1",
                  7892,
                  "",
                  "https://example.com/",
                  "",
                ]),
                label: "Mock 本地代理",
                status: "degraded",
                startedAt: at(),
                finishedAt: at(),
                cancelled: false,
                steps: [
                  {
                    check: "tcp",
                    status: "healthy",
                    source: "mock",
                    summary: "Mock TCP 已连接",
                    detail: "测试夹具",
                    checkedAt: at(),
                    latencyMs: 1,
                    errorCode: null,
                  },
                  {
                    check: "proxy-handshake",
                    status: "down",
                    source: "mock",
                    summary: "Mock CONNECT 407",
                    detail: "端口开放不代表代理可用",
                    checkedAt: at(),
                    latencyMs: 1,
                    errorCode: "proxy-auth-required",
                  },
                ],
              };
              history.unshift(result);
              return [result];
            }
            if (cmd === "copy_report") {
              document.body.dataset.copied = "true";
              return;
            }
            if (cmd === "cancel_diagnostics") return;
            throw new Error(`Unmocked: ${cmd}`);
          },
        },
      });
    },
    { fixture },
  );
}
test("browser mode explains missing backend and workflows, including minimum window", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText(/原生后端未连接/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "检查全部连接" }),
  ).toBeDisabled();
  await page.screenshot({
    path: "test-results/dashboard-browser.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: /让远端 Codex/ }).click();
  await expect(page.getByText("新建反向隧道", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "预览启动 / 切换" }),
  ).toBeDisabled();
  await expect(page.getByText(/Magpie/)).toHaveCount(0);
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.screenshot({
    path: "test-results/workflow-minimum.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
test("mock native: profile CRUD, layer evidence, theme and report", async ({
  page,
}) => {
  await mock(page);
  await page.goto("/");
  await expect(
    page.locator("table").getByText("Mock 本地代理", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "添加连接", exact: true }).click();
  await page.getByLabel("连接名称").fill("Mock API");
  await page.getByLabel("检测类型").selectOption("https");
  await page.getByLabel("确认目标并启用主动检测").check();
  await page.getByRole("button", { name: "保存连接", exact: true }).click();
  await expect(
    page.locator("table").getByText("Mock API", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "检查", exact: true }).first().click();
  await expect(
    page.getByRole("dialog").getByText("Mock CONNECT 407"),
  ).toBeVisible();
  await page.getByRole("dialog").getByText("代理握手", { exact: true }).click();
  await expect(page.getByText("proxy-auth-required")).toBeVisible();
  await page.getByRole("button", { name: "关闭面板" }).click();
  await page
    .locator("tr")
    .filter({ hasText: "Mock 本地代理" })
    .getByRole("button", { name: "编辑", exact: true })
    .click();
  await page.getByLabel("端口", { exact: true }).fill("7893");
  await page.getByRole("button", { name: "保存连接", exact: true }).click();
  await expect(
    page.locator("tr").filter({ hasText: "Mock 本地代理" }),
  ).toContainText("未验证");
  await page.screenshot({
    path: "test-results/dashboard-mock.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "配置与记录", exact: true }).click();
  await page
    .getByRole("combobox", { name: "主题", exact: true })
    .selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "复制报告", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-copied", "true");
  await page
    .locator(".config-row")
    .filter({ hasText: "Mock API" })
    .getByRole("button", { name: "删除", exact: true })
    .click();
  await expect(
    page.locator(".config-row").filter({ hasText: "Mock API" }),
  ).toHaveCount(0);
  await page.screenshot({
    path: "test-results/settings-light-mock.png",
    fullPage: true,
  });
});
test("preview and cancellation never execute, confirmation executes once and rollback previews", async ({
  page,
}) => {
  await mock(page);
  await page.goto("/");
  await page.getByRole("button", { name: /日常上网/ }).click();
  await page.getByRole("button", { name: "预览启动 / 切换" }).click();
  await expect(
    page.getByRole("dialog").getByText("Mock 影响范围"),
  ).toBeVisible();
  await expect(page.locator("body")).not.toHaveAttribute("data-executed", /./);
  await page.getByRole("button", { name: "取消，保持现状" }).click();
  await expect(page.locator("body")).not.toHaveAttribute("data-executed", /./);
  await page.getByRole("button", { name: "预览启动 / 切换" }).click();
  await page.screenshot({
    path: "test-results/confirmation-mock.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "确认执行", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-executed", "1");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "配置与记录", exact: true }).click();
  await page.getByRole("button", { name: "预览撤销" }).click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-preview",
    /rollback/,
  );
  await expect(page.locator("body")).toHaveAttribute("data-executed", "1");
});
test("workflow order and tunnel definition persist without connecting", async ({
  page,
}) => {
  await mock(page);
  await page.goto("/");
  await page.getByRole("button", { name: /让远端 Codex/ }).click();
  await page.getByLabel("添加检查步骤").selectOption("proxy");
  await page.getByRole("button", { name: "保存检查顺序" }).click();
  await page.getByRole("button", { name: "检查已保存路径" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-workflow", "remote");
  await page.getByRole("button", { name: "新增隧道", exact: true }).click();
  await page.getByLabel("SSH Host 别名", { exact: true }).fill("mock-coder");
  await page.getByRole("button", { name: "保存定义", exact: true }).click();
  await expect(page.locator(".tunnel-card")).toContainText(
    "127.0.0.1:10073 → 127.0.0.1:18080",
  );
  await expect(page.locator("body")).not.toHaveAttribute("data-executed", /./);
  await page.screenshot({
    path: "test-results/remote-workflow-mock.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "预览启动", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-preview",
    /tunnel-start/,
  );
  await expect(page.locator("body")).not.toHaveAttribute("data-executed", /./);
});
