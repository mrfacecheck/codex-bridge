#!/usr/bin/env bash
# Reproducible builder for codex-bridge's private macOS kernel-patched codex suite.
# Never overwrites ~/.local/bin/codex; installs atomically to ${INSTALL_DIR} (default ~/.codex-bridge/bin).
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: Seatbelt kernel deny-exec build is macOS-only (detected $(uname -s))" >&2
  exit 1
fi

TAG="${1:-rust-v0.166.0}"
VER="${TAG#rust-}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PATCH_FILE="${PATCH_FILE:-${REPO_ROOT}/patches/codex-rs-${VER}-darwin-deny-exec.patch}"
BRIDGE_HOME="${CODEX_BRIDGE_HOME:-${HOME}/.codex-bridge}"
BUILD_ROOT="${BUILD_ROOT:-${BRIDGE_HOME}/build/codex-${VER}}"
INSTALL_DIR="${INSTALL_DIR:-${BRIDGE_HOME}/bin}"
INSTALL_BIN="${INSTALL_DIR}/codex"

export PATH="${HOME}/.cargo/bin:${PATH}"

if ! command -v cargo >/dev/null 2>&1; then
  echo "error: cargo not found. Install rustup first: https://rustup.rs" >&2
  exit 1
fi

if [[ ! -f "${PATCH_FILE}" ]]; then
  echo "error: patch file missing: ${PATCH_FILE}" >&2
  exit 1
fi

mkdir -p "$(dirname "${BUILD_ROOT}")" "${INSTALL_DIR}"

if [[ ! -d "${BUILD_ROOT}/.git" ]]; then
  git clone --depth 1 --branch "${TAG}" https://github.com/openai/codex.git "${BUILD_ROOT}"
else
  git -C "${BUILD_ROOT}" reset --hard HEAD
  git -C "${BUILD_ROOT}" clean -fd
fi

git -C "${BUILD_ROOT}" apply --check "${PATCH_FILE}"
git -C "${BUILD_ROOT}" apply "${PATCH_FILE}"

(
  cd "${BUILD_ROOT}/codex-rs"
  cargo test -p codex-sandboxing --lib seatbelt
  cargo build --release -p codex-cli -p codex-exec-server-cli --bin codex --bin codex-exec-server
)

for bin in codex codex-exec-server; do
  src="${BUILD_ROOT}/codex-rs/target/release/${bin}"
  if [[ ! -f "${src}" ]]; then
    echo "error: expected built binary missing: ${src}" >&2
    exit 1
  fi
  tmp="${INSTALL_DIR}/${bin}.tmp.$$"
  cp "${src}" "${tmp}"
  chmod 0755 "${tmp}"
  if command -v strip >/dev/null 2>&1 && command -v codesign >/dev/null 2>&1; then
    strip -x "${tmp}"
    codesign --force --sign - "${tmp}"
  fi
  mv -f "${tmp}" "${INSTALL_DIR}/${bin}"
done

# Copy version-matched sibling codex-code-mode-host (does not link codex-sandboxing;
# links OpenAI's prebuilt rusty_v8 artifact) from the installed standalone package if present.
OFFICIAL_CMH="${HOME}/.codex/packages/standalone/current/bin/codex-code-mode-host"
if [[ -x "${OFFICIAL_CMH}" ]]; then
  tmp="${INSTALL_DIR}/codex-code-mode-host.tmp.$$"
  cp "${OFFICIAL_CMH}" "${tmp}"
  chmod 0755 "${tmp}"
  mv -f "${tmp}" "${INSTALL_DIR}/codex-code-mode-host"
fi

# Live XNU Seatbelt kernel enforcement smoke test (matches src/grants.ts::probeDarwinExecDeny)
verify_seatbelt_exec_deny() {
  local bin="$1"
  local probe_out="" probe_err="" probe_rc=0
  local tmp_err
  tmp_err="$(mktemp)"
  set +e
  probe_out="$(CODEX_BRIDGE_DENY_EXEC_SUBPATHS=/bin/echo "${bin}" sandbox -- /bin/echo __cb_deny_probe__ 2>"${tmp_err}")"
  probe_rc=$?
  set -e
  probe_err="$(cat "${tmp_err}")"
  rm -f "${tmp_err}"

  if [[ "${probe_err}" == *"sandbox-exec: sandbox_apply: Operation not permitted"* ]]; then
    echo "note: nested sandbox prevents live sandbox-exec probe; unit test coverage passed"
    return 0
  fi
  if [[ "${probe_rc}" -eq 0 ]] || [[ "${probe_out}" == *"__cb_deny_probe__"* ]] || ! printf '%s' "${probe_err}" | grep -Eiq 'Operation not permitted|Permission denied|EPERM'; then
    echo "error: live Seatbelt deny-exec probe failed for ${bin} (rc=${probe_rc}, stderr=${probe_err})" >&2
    return 1
  fi
  if ! CODEX_BRIDGE_DENY_EXEC_SUBPATHS=/bin/echo "${bin}" sandbox -- /usr/bin/true >/dev/null 2>&1; then
    echo "error: live Seatbelt control probe (/usr/bin/true) failed for ${bin}" >&2
    return 1
  fi
  echo "verified: live XNU Seatbelt deny process-exec probe passed"
}

verify_seatbelt_exec_deny "${INSTALL_BIN}"

if [[ "${CLEAN_BUILD:-0}" == "1" ]]; then
  rm -rf "${BUILD_ROOT}"
fi

echo "Installed bridge-private codex suite into: ${INSTALL_DIR}"
ls -lh "${INSTALL_DIR}"
"${INSTALL_BIN}" --version
