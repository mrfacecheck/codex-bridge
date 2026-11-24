#!/usr/bin/env bash
# Reproducible builder for codex-bridge's private macOS kernel-patched codex binary.
# Never overwrites ~/.local/bin/codex; installs atomically to ~/.codex-bridge/bin/codex.
set -euo pipefail

TAG="${1:-rust-v0.166.0}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PATCH_FILE="${REPO_ROOT}/patches/codex-rs-v0.166.0-darwin-deny-exec.patch"
BUILD_ROOT="${HOME}/.codex-bridge/build/codex-${TAG#rust-}"
INSTALL_DIR="${HOME}/.codex-bridge/bin"
INSTALL_BIN="${INSTALL_DIR}/codex"

export PATH="${HOME}/.cargo/bin:${PATH}"

if ! command -v cargo >/dev/null 2>&1; then
  echo "error: cargo not found. Install rustup first: https://rustup.rs" >&2
  exit 1
fi

if [ ! -f "${PATCH_FILE}" ]; then
  echo "error: patch file missing: ${PATCH_FILE}" >&2
  exit 1
fi

mkdir -p "$(dirname "${BUILD_ROOT}")" "${INSTALL_DIR}"

if [ ! -d "${BUILD_ROOT}/.git" ]; then
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
  cargo build --release -p codex-cli --bin codex -p codex-exec-server-cli
)

for bin in codex codex-exec-server; do
  cp "${BUILD_ROOT}/codex-rs/target/release/${bin}" "${INSTALL_DIR}/${bin}.tmp.$$"
  chmod 0755 "${INSTALL_DIR}/${bin}.tmp.$$"
  mv -f "${INSTALL_DIR}/${bin}.tmp.$$" "${INSTALL_DIR}/${bin}"
done

# Copy version-matched sibling codex-code-mode-host (does not link codex-sandboxing;
# links OpenAI's prebuilt rusty_v8 artifact) from the installed standalone package if present.
OFFICIAL_CMH="${HOME}/.codex/packages/standalone/current/bin/codex-code-mode-host"
if [ -x "${OFFICIAL_CMH}" ]; then
  cp "${OFFICIAL_CMH}" "${INSTALL_DIR}/codex-code-mode-host.tmp.$$"
  chmod 0755 "${INSTALL_DIR}/codex-code-mode-host.tmp.$$"
  mv -f "${INSTALL_DIR}/codex-code-mode-host.tmp.$$" "${INSTALL_DIR}/codex-code-mode-host"
fi

echo "Installed bridge-private codex suite into: ${INSTALL_DIR}"
ls -lh "${INSTALL_DIR}"
"${INSTALL_BIN}" --version
