import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const BUILD_SCRIPT = path.join(REPO_ROOT, "scripts", "build-patched-codex.sh");
const INSTALL_SCRIPT = path.join(REPO_ROOT, "scripts", "install-patched-codex.sh");
const WORKFLOW_FILE = path.join(REPO_ROOT, ".github", "workflows", "build-patched-codex.yml");

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function makeFakeRelease({ dir, tag, target, codexScript, symlinkExecServer = false, corruptChecksum = false }) {
  const ver = tag.replace(/^codex-/, "");
  const asset = `codex-bridge-patched-codex-${ver}-${target}.tar.gz`;
  const srcDir = path.join(dir, "src");
  mkdirSync(srcDir, { recursive: true });

  const codexPath = path.join(srcDir, "codex");
  writeFileSync(codexPath, codexScript, "utf8");
  chmodSync(codexPath, 0o755);

  const execServerPath = path.join(srcDir, "codex-exec-server");
  if (symlinkExecServer) {
    symlinkSync("/bin/sh", execServerPath);
  } else {
    writeFileSync(execServerPath, "#!/usr/bin/env bash\necho ok\n", "utf8");
    chmodSync(execServerPath, 0o755);
  }

  const tarPath = path.join(dir, asset);
  const tar = spawnSync("tar", ["-czf", tarPath, "-C", srcDir, "codex", "codex-exec-server"], { encoding: "utf8" });
  assert.equal(tar.status, 0, `tar failed: ${tar.stderr}`);

  const digest = corruptChecksum ? "0".repeat(64) : sha256File(tarPath);
  writeFileSync(path.join(dir, "SHA256SUMS.txt"), `${digest}  ${asset}\n`, "utf8");
  return { asset, digest };
}

test("patched-codex scripts pass bash syntax check and enforce build/release invariants", () => {
  for (const script of [BUILD_SCRIPT, INSTALL_SCRIPT]) {
    const res = spawnSync("bash", ["-n", script], { encoding: "utf8" });
    assert.equal(res.status, 0, `bash -n failed for ${script}: ${res.stderr}`);
  }
  const buildSrc = readFileSync(BUILD_SCRIPT, "utf8");
  assert.match(buildSrc, /--bin codex --bin codex-exec-server/);
  assert.match(buildSrc, /patches\/codex-rs-\$\{VER\}-darwin-deny-exec\.patch/);
  assert.match(buildSrc, /verify_seatbelt_exec_deny/);

  const wf = readFileSync(WORKFLOW_FILE, "utf8");
  assert.match(wf, /workflow_dispatch:/);
  assert.match(wf, /"codex-v\*"/);
  assert.match(wf, /\.\/scripts\/build-patched-codex\.sh/);
  assert.match(wf, /\.\/scripts\/install-patched-codex\.sh/);
});

const isDarwin = process.platform === "darwin";

test("install-patched-codex.sh verifies SHA-256, rejects bad probes/symlinks, and installs atomically", { skip: !isDarwin }, () => {
  const target = process.arch === "arm64" ? "darwin-arm64" : "darwin-x86_64";
  const tag = "codex-v0.166.0";
  const goodStub = `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  echo "codex-cli 0.166.0"
  exit 0
fi
if [[ "\${1:-}" == "sandbox" && "\${3:-}" == "/bin/echo" ]]; then
  if [[ "\${CODEX_BRIDGE_DENY_EXEC_SUBPATHS:-}" == *"/bin/echo"* ]]; then
    echo "sandbox-exec: execvp() of '/bin/echo' failed: Operation not permitted" >&2
    exit 1
  fi
  echo "\${4:-}"
  exit 0
fi
if [[ "\${1:-}" == "sandbox" && "\${3:-}" == "/usr/bin/true" ]]; then
  exit 0
fi
exit 0
`;
  const unpatchedStub = `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  echo "codex-cli 0.166.0"
  exit 0
fi
echo "__cb_deny_probe__"
exit 0
`;

  const root = mkdtempSync(path.join(tmpdir(), "cb-install-test-"));
  try {
    // 1. Corrupt SHA-256 fails closed without touching CODEX_BRIDGE_HOME
    const badShaDir = path.join(root, "rel-bad-sha");
    const badShaHome = path.join(root, "home-bad-sha");
    mkdirSync(badShaDir, { recursive: true });
    makeFakeRelease({ dir: badShaDir, tag, target, codexScript: goodStub, corruptChecksum: true });
    const rBadSha = spawnSync("bash", [INSTALL_SCRIPT, tag], {
      encoding: "utf8",
      env: { ...process.env, CODEX_BRIDGE_HOME: badShaHome, CODEX_BRIDGE_RELEASE_BASE_URL: `file://${badShaDir}` },
    });
    assert.notEqual(rBadSha.status, 0);
    assert.match(rBadSha.stderr, /SHA-256 mismatch/);
    assert.equal(existsSync(path.join(badShaHome, "bin", "codex")), false);

    // 2. Unpatched binary failing Seatbelt deny-exec probe fails closed
    const badProbeDir = path.join(root, "rel-bad-probe");
    const badProbeHome = path.join(root, "home-bad-probe");
    mkdirSync(badProbeDir, { recursive: true });
    makeFakeRelease({ dir: badProbeDir, tag, target, codexScript: unpatchedStub });
    const rBadProbe = spawnSync("bash", [INSTALL_SCRIPT, tag], {
      encoding: "utf8",
      env: { ...process.env, CODEX_BRIDGE_HOME: badProbeHome, CODEX_BRIDGE_RELEASE_BASE_URL: `file://${badProbeDir}` },
    });
    assert.notEqual(rBadProbe.status, 0);
    assert.match(rBadProbe.stderr, /failed live XNU Seatbelt deny-exec probe/);
    assert.equal(existsSync(path.join(badProbeHome, "bin", "codex")), false);

    // 3. Symlinked binary in tarball is rejected fail-closed
    const symDir = path.join(root, "rel-sym");
    const symHome = path.join(root, "home-sym");
    mkdirSync(symDir, { recursive: true });
    makeFakeRelease({ dir: symDir, tag, target, codexScript: goodStub, symlinkExecServer: true });
    const rSym = spawnSync("bash", [INSTALL_SCRIPT, tag], {
      encoding: "utf8",
      env: { ...process.env, CODEX_BRIDGE_HOME: symHome, CODEX_BRIDGE_RELEASE_BASE_URL: `file://${symDir}` },
    });
    assert.notEqual(rSym.status, 0);
    assert.match(rSym.stderr, /symlinks rejected/);
    assert.equal(existsSync(path.join(symHome, "bin", "codex")), false);

    // 4. Valid release passes SHA-256 + live probe and installs atomically
    const goodDir = path.join(root, "rel-good");
    const goodHome = path.join(root, "home-good");
    mkdirSync(goodDir, { recursive: true });
    makeFakeRelease({ dir: goodDir, tag, target, codexScript: goodStub });
    const rGood = spawnSync("bash", [INSTALL_SCRIPT, tag], {
      encoding: "utf8",
      env: { ...process.env, CODEX_BRIDGE_HOME: goodHome, CODEX_BRIDGE_RELEASE_BASE_URL: `file://${goodDir}` },
    });
    assert.equal(rGood.status, 0, `expected success, got stderr: ${rGood.stderr}`);
    assert.match(rGood.stdout, /verified: SHA-256/);
    assert.match(rGood.stdout, /verified: live XNU Seatbelt deny process-exec probe passed/);
    assert.equal(existsSync(path.join(goodHome, "bin", "codex")), true);
    assert.equal(existsSync(path.join(goodHome, "bin", "codex-exec-server")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
