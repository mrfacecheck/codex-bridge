/** Test helpers: MCP JSON-RPC client over newline stdio + tmp git repo factory. */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
export const BRIDGE = join(HERE, "..", "dist", "index.js");
export const STUB_CODEX = join(HERE, "stub-codex.mjs");

export function spawnBridge(extraEnv = {}) {
	const proc = spawn("node", [BRIDGE], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, CODEX_BINARY: STUB_CODEX, ...extraEnv },
	});
	const pending = new Map();
	let nextId = 10;
	let buf = "";
	let stderr = "";
	proc.stderr.on("data", (d) => { stderr += d.toString(); });
	proc.stdout.on("data", (d) => {
		buf += d.toString();
		const lines = buf.split("\n");
		buf = lines.pop();
		for (const line of lines) {
			if (!line.trim()) continue;
			let msg;
			try { msg = JSON.parse(line); } catch { continue; }
			if (msg.id != null && pending.has(msg.id)) {
				const p = pending.get(msg.id);
				pending.delete(msg.id);
				msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
			}
		}
	});
	const rpc = (method, params, timeoutMs = 60_000) => new Promise((resolve, reject) => {
		const id = nextId++;
		pending.set(id, { resolve, reject });
		proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
		setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method} timeout`)); }, timeoutMs);
	});
	return {
		proc,
		get stderr() { return stderr; },
		async init() {
			await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } });
			proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
		},
		async call(name, args) {
			const r = await rpc("tools/call", { name, arguments: args }, 120_000);
			const text = r?.content?.[0]?.text;
			try { return JSON.parse(text); } catch { return { raw: text }; }
		},
		close() { try { proc.kill("SIGKILL"); } catch {} },
	};
}

export function makeRepo() {
	const dir = mkdtempSync(join(tmpdir(), "cb-test-"));
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: dir });
	writeFileSync(join(dir, "README.md"), "# test\n");
	execFileSync("git", ["add", "README.md"], { cwd: dir });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
	return dir;
}

export const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" });

const CONTROL_PATH = join(tmpdir(), "cb-stub-codex-control.json");
/** Write stub-codex control file; empty object resets to defaults. */
export function setStubControl(ctl) {
	writeFileSync(CONTROL_PATH, JSON.stringify(ctl));
}

export async function waitFor(fn, timeoutMs = 30_000, step = 100) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		const v = await fn();
		if (v) return v;
		await new Promise((r) => setTimeout(r, step));
	}
	throw new Error("waitFor timed out");
}
