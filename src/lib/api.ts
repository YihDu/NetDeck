import { invoke } from "@tauri-apps/api/core";
import type {
  Config,
  Diagnostic,
  Snapshot,
  Operation,
  Plan,
  RuntimeItem,
  Receipt,
} from "./types";
export const native =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
async function call<T>(
  name: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!native)
    throw new Error(
      "原生后端未连接，请通过 NetDeck 桌面应用运行。浏览器预览不提供网络检测。",
    );
  return invoke<T>(name, args);
}
export const api = {
  preview: (request: Operation) => call<Plan>("preview_operation", { request }),
  execute: (planId: string) => call<Receipt>("execute_operation", { planId }),
  runtime: () => call<RuntimeItem[]>("runtime_status"),
  operations: () => call<Receipt[]>("operation_history"),
  services: () => call<string[]>("network_services"),
  workflow: (workflowId: string) =>
    call<Diagnostic[]>("run_workflow", { workflowId }),
  snapshot: () => call<Snapshot>("get_network_snapshot"),
  config: () => call<Config>("load_config"),
  save: (config: Config) => call<void>("save_config", { config }),
  diagnose: (profileId?: string) =>
    call<Diagnostic[]>("run_diagnostics", { profileId: profileId ?? null }),
  cancel: () => call<void>("cancel_diagnostics"),
  history: () => call<Diagnostic[]>("get_history"),
  copy: (snapshot: Snapshot | null, results: Diagnostic[]) =>
    call<void>("copy_report", { snapshot, results }),
  export: (snapshot: Snapshot | null, results: Diagnostic[]) =>
    call<string>("export_report", { snapshot, results }),
};
