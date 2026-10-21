import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, delimiter } from "node:path";
const root = resolve(import.meta.dirname, "..");
const env = { ...process.env };
if (existsSync(resolve(root, ".tooling/cargo/bin/cargo"))) {
  env.CARGO_HOME = resolve(root, ".tooling/cargo");
  env.RUSTUP_HOME = resolve(root, ".tooling/rustup");
  env.PATH = `${env.CARGO_HOME}/bin${delimiter}${env.PATH}`;
}
const [command, ...args] = process.argv.slice(2);
const exe =
  command === "tauri" ? resolve(root, "node_modules/.bin/tauri") : command;
const child = spawn(exe, args, { cwd: root, env, stdio: "inherit" });
child.on("error", (e) => {
  console.error(e.message);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 1));
