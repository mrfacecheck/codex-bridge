#!/usr/bin/env node
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, "..", "dist");
const srcDir = path.join(__dirname, "..", "src");

// Prefer compiled dist/ if available; fall back to src/ via tsx for development
const useCompiled = existsSync(path.join(distDir, "index.js"));

function resolveTsx() {
  const localTsx = path.join(__dirname, "..", "node_modules", ".bin", "tsx");
  return existsSync(localTsx) ? localTsx : "tsx";
}

function resolve(script) {
  if (useCompiled) return { cmd: process.execPath, entry: path.join(distDir, script.replace(".ts", ".js")) };
  return { cmd: resolveTsx(), entry: path.join(srcDir, script) };
}

function run(script, extraArgs = []) {
  const { cmd, entry } = resolve(script);
  const r = spawnSync(cmd, [entry, ...extraArgs], { stdio: "inherit", env: process.env });
  process.exit(r.status ?? 1);
}

function runOnce(script, extraArgs = []) {
  const { cmd, entry } = resolve(script);
  return spawnSync(cmd, [entry, ...extraArgs], { stdio: ["ignore", "inherit", "inherit"], env: process.env, timeout: 5000 });
}

const cmd = process.argv[2];

switch (cmd) {
  case "statusline":
    run("statusline.ts");
    break;

  case "install-statusline":
    run("statusline.ts", ["install"]);
    break;

  case "watch": {
    const tick = () => { try { runOnce("statusline.ts"); } catch {} };
    tick();
    setInterval(tick, 2000);
    break;
  }

  default:
    run("index.ts");
    break;
}
