#!/usr/bin/env node
/**
 * stub-codex — deterministic fake `codex exec` for offline bridge tests.
 * Emits the same JSONL shapes codex 0.166 produces: thread.started, turn.started,
 * item.completed (command_execution / file_change / agent_message), turn.completed.
 *
 * Controlled via a JSON control file (survives buildCodexEnv env scrubbing):
 *   ${TMPDIR}/cb-stub-codex-control.json
 *   { "mode": "success"|"fail"|"hang"|"escape"|"empty",
 *     "write": "relpath::content",      — write file inside cwd
 *     "escape_path": "/abs/path",       — write OUTSIDE cwd (escape test)
 *     "delay_ms": 20 }
 * Env STUB_CODEX_MODE still honored as fallback when no control file exists.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync, symlinkSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

export const CONTROL_PATH = join(tmpdir(), "cb-stub-codex-control.json");

function resolveControlPath() {
	// Walk up from CODEX_HOME to find per-test-suite isolated stub-codex-control.json
	let dir = process.env.CODEX_HOME;
	for (let i = 0; i < 5 && dir; i++) {
		const cand = join(dir, "stub-codex-control.json");
		if (existsSync(cand)) return cand;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return CONTROL_PATH;
}

const args = process.argv.slice(2);
const resolvedControl = resolveControlPath();
const ctl = existsSync(resolvedControl) ? JSON.parse(readFileSync(resolvedControl, "utf8")) : {};
const MODE = ctl.mode ?? process.env.STUB_CODEX_MODE ?? "success";
const DELAY = Number(ctl.delay_ms ?? 20);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (o) => process.stdout.write(JSON.stringify(o) + "\n");

if (args.includes("--version")) {
	console.log("codex-cli 0.166.0-stub");
	process.exit(0);
}

if (args[0] === "login" && args[1] === "status") {
	console.log("Logged in using stub");
	process.exit(0);
}

// grants path (cx137): codex mcp list --json — control file can inject a
// server list; default is an empty MCP surface.
if (args[0] === "mcp" && args[1] === "list") {
	process.stdout.write(JSON.stringify(ctl.mcp_servers ?? []) + "\n");
	process.exit(0);
}

const isResume = args[1] === "resume";
const resumeSid = isResume ? args[2] : null;
const oIdx = args.indexOf("-o");
const outFile = oIdx >= 0 ? args[oIdx + 1] : null;
const cIdx = args.indexOf("-C");
const cwd = cIdx >= 0 ? args[cIdx + 1] : process.cwd();
const sid = resumeSid ?? `stub-${randomUUID().slice(0, 8)}`;

let task = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) task += chunk;

const write = (p, content) => {
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, content);
};

if (MODE === "empty") {
	ev({ type: "thread.started", thread_id: sid });
	if (outFile) writeFileSync(outFile, "");
	process.exit(0);
}

ev({ type: "thread.started", thread_id: sid });
await sleep(DELAY);

if (MODE === "hang") {
	ev({ type: "turn.started" });
	if (ctl.stderr_spam) {
		setInterval(() => {
			process.stderr.write("ERROR codex_models_manager::manager: failed to refresh available models: timeout\n");
		}, Number(ctl.stderr_spam_ms ?? 250));
	} else {
		setInterval(() => {}, 60_000);
	}
	await new Promise(() => {});
}

ev({ type: "turn.started" });
await sleep(DELAY);

if (MODE === "fail") {
	ev({ type: "error", message: "stub requested failure" });
	ev({ type: "turn.failed", error: { message: "stub requested failure" } });
	process.exit(1);
}

if (Number(ctl.steps) > 0) {
	const stepDelay = Number(ctl.step_delay_ms ?? 200);
	for (let i = 1; i <= Number(ctl.steps); i++) {
		ev({ type: "item.started", item: { id: `step-${i}`, type: "command_execution", command: `step-${i}` } });
		await sleep(stepDelay);
		ev({ type: "item.completed", item: { id: `step-${i}`, type: "command_execution", command: `step-${i}`, exit_code: 0, status: "completed" } });
	}
}

if (ctl.started_and_completed_cmd) {
	ev({ type: "item.started", item: { id: "dup-1", type: "command_execution", command: "npm test -- --run" } });
	await sleep(DELAY);
	ev({ type: "item.completed", item: { id: "dup-1", type: "command_execution", command: "npm test -- --run", exit_code: 0, status: "completed" } });
	ev({ type: "item.started", item: { id: "fail-cmd", type: "command_execution", command: "lint --check" } });
	await sleep(DELAY);
	ev({ type: "item.completed", item: { id: "fail-cmd", type: "command_execution", command: "lint --check", exit_code: 2, status: "completed" } });
}

if (ctl.repeated_fail_count > 0) {
	for (let i = 1; i <= Number(ctl.repeated_fail_count); i++) {
		ev({ type: "item.started", item: { id: `rf-${i}`, type: "command_execution", command: "pytest -q" } });
		await sleep(30);
		ev({ type: "item.completed", item: { id: `rf-${i}`, type: "command_execution", command: "pytest -q", exit_code: 2, status: "completed" } });
	}
}

if (ctl.write_files && typeof ctl.write_files === "object") {
	for (const [rel, content] of Object.entries(ctl.write_files)) {
		write(join(cwd, rel), String(content));
		ev({ type: "item.completed", item: { id: `wf-${rel}`, type: "file_change", changes: [{ path: rel, kind: "update" }], status: "completed" } });
	}
}

if (ctl.create_symlink && typeof ctl.create_symlink === "object") {
	const { rel, target } = ctl.create_symlink;
	mkdirSync(dirname(join(cwd, rel)), { recursive: true });
	symlinkSync(target, join(cwd, rel));
}

if (ctl.gitignore_append) {
	appendFileSync(join(cwd, ".gitignore"), String(ctl.gitignore_append) + "\n");
}

if (MODE === "escape") {
	const target = ctl.escape_path;
	if (target) {
		write(target, "escaped-by-stub\n");
		ev({ type: "item.completed", item: { id: "i1", type: "command_execution", command: `touch ${target}`, aggregated_output: "", status: "completed" } });
	}
} else if (ctl.write) {
	const [rel, ...rest] = ctl.write.split("::");
	const target = join(cwd, rel);
	write(target, rest.join("::") || "stub\n");
	ev({ type: "item.completed", item: { id: "i1", type: "command_execution", command: `write ${rel}`, aggregated_output: "", status: "completed" } });
	await sleep(DELAY);
	ev({ type: "item.completed", item: { id: "i2", type: "file_change", changes: [{ path: rel, kind: "add" }], status: "completed" } });
}

if (ctl.git_commit) {
	execFileSync("git", ["add", "-A"], { cwd });
	execFileSync("git", ["-c", "user.email=agent@local", "-c", "user.name=agent", "commit", "-qm", "agent self-commit"], { cwd });
}

if (ctl.hang_after_write) {
	setInterval(() => {}, 60_000);
	await new Promise(() => {});
}

await sleep(DELAY);
const finalText = `stub done: ${(task || "").split("\n")[0].slice(0, 80)}`;
ev({ type: "item.completed", item: { id: "i3", type: "agent_message", text: finalText, status: "completed" } });
await sleep(DELAY);
ev({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 50, reasoning_output_tokens: 5 } });
if (outFile) writeFileSync(outFile, finalText + "\n");
process.exit(0);
