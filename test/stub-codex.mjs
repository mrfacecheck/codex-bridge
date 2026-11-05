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
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

export const CONTROL_PATH = join(tmpdir(), "cb-stub-codex-control.json");

const args = process.argv.slice(2);
const ctl = existsSync(CONTROL_PATH) ? JSON.parse(readFileSync(CONTROL_PATH, "utf8")) : {};
const MODE = ctl.mode ?? process.env.STUB_CODEX_MODE ?? "success";
const DELAY = Number(ctl.delay_ms ?? 20);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (o) => process.stdout.write(JSON.stringify(o) + "\n");

if (args.includes("--version")) {
	console.log("codex-cli 0.166.0-stub");
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
	await new Promise(() => {});
}

ev({ type: "turn.started" });
await sleep(DELAY);

if (MODE === "fail") {
	ev({ type: "error", message: "stub requested failure" });
	ev({ type: "turn.failed", error: { message: "stub requested failure" } });
	process.exit(1);
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

await sleep(DELAY);
const finalText = `stub done: ${(task || "").split("\n")[0].slice(0, 80)}`;
ev({ type: "item.completed", item: { id: "i3", type: "agent_message", text: finalText, status: "completed" } });
await sleep(DELAY);
ev({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 50, reasoning_output_tokens: 5 } });
if (outFile) writeFileSync(outFile, finalText + "\n");
process.exit(0);
