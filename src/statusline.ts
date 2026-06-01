import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "fs";
import { homedir } from "os";
import path from "path";
import { isGitRepo, getGitRoot } from "./evidence.js";
import { getLatestRunForProject, readProgress, readRunMeta, readReviewPacket, markWorkerDeadIfNeeded } from "./progress.js";

function getCwd(): string {
  let input = "";
  try {
    if (!process.stdin.isTTY) input = readFileSync(0, "utf8");
  } catch {}
  if (input.trim()) {
    try {
      const p = JSON.parse(input.trim());
      return p.cwd || p.current_dir || p.currentDir
        || p.workspace?.current_dir || p.workspace?.currentDir
        || p.workspace?.project_dir || p.workspace?.projectDir
        || p.workspace?.path || process.cwd();
    } catch {}
  }
  return process.cwd();
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function statusLine() {
  const cwd = getCwd();
  let gitRoot: string | null = null;
  try { if (isGitRepo(cwd)) gitRoot = getGitRoot(cwd); } catch {}
  if (!gitRoot) { process.stdout.write("Codex idle\n"); return; }

  const latest = getLatestRunForProject(gitRoot);
  if (!latest) { process.stdout.write("Codex idle\n"); return; }

  const { runId, runDir } = latest;
  markWorkerDeadIfNeeded(runDir);
  const progress = readProgress(runDir);
  if (!progress) { process.stdout.write("Codex idle\n"); return; }

  const shortId = runId.slice(0, 4);

  if (progress.status === "completed" || progress.status === "failed" || progress.status === "timeout" || progress.status === "cancelled") {
    const review = readReviewPacket(runDir) as Record<string, unknown> | null;
    const elapsed = progress.elapsedMs ? formatElapsed(progress.elapsedMs) : "--:--";
    const effectiveStatus = (review?.status as string) || progress.status;
    const label = effectiveStatus === "completed" ? "done" : effectiveStatus;
    if (review && (review.git_diff as any)?.changed) {
      const gd = review.git_diff as any;
      const summary = gd.summary || `${gd.files?.length || 0} files changed`;
      process.stdout.write(`Codex ${shortId} ${label} ${elapsed}  ${summary}\n`);
    } else {
      process.stdout.write(`Codex ${shortId} ${label} ${elapsed}  ${progress.message || ""}\n`);
    }
    return;
  }

  const meta = readRunMeta(runDir);
  const elapsed = meta ? formatElapsed(Date.now() - new Date(meta.createdAt).getTime()) : "--:--";
  const msg = progress.message || progress.status;
  process.stdout.write(`Codex ${shortId} running ${elapsed}  ${msg}\n`);
}

function installStatusline() {
  const settingsDir = path.join(homedir(), ".claude");
  const settingsPath = path.join(settingsDir, "settings.json");

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, "utf8")); } catch {}
  } else {
    mkdirSync(settingsDir, { recursive: true, mode: 0o700 });
    try { chmodSync(settingsDir, 0o700); } catch {}
  }

  settings.statusLine = {
    type: "command",
    command: "codex-bridge statusline",
    refreshInterval: 2,
  };

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  process.stdout.write(`Wrote statusLine config to ${settingsPath}\n`);
}

const cmd = process.argv[2];
if (cmd === "install") installStatusline();
else statusLine();
