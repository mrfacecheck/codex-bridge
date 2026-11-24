#!/usr/bin/env bash
# Fast, fail-closed installer for prebuilt macOS kernel-patched codex binaries from GitHub Releases.
# Verifies SHA-256 + Mach-O execution + live XNU Seatbelt deny-exec probe BEFORE touching ~/.codex-bridge/bin.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: patched codex Seatbelt suite is macOS-only (detected $(uname -s))" >&2
  exit 1
fi

ARCH="$(uname -m)"
case "${ARCH}" in
  arm64) TARGET="darwin-arm64" ;;
  x86_64) TARGET="darwin-x86_64" ;;
  *)
    echo "error: unsupported macOS architecture: ${ARCH}" >&2
    exit 1
    ;;
esac

REPO="${CODEX_BRIDGE_REPO:-mrfacecheck/codex-bridge}"
RELEASE_TAG="${1:-codex-v0.166.0}"
BRIDGE_HOME="${CODEX_BRIDGE_HOME:-${HOME}/.codex-bridge}"
INSTALL_DIR="${INSTALL_DIR:-${BRIDGE_HOME}/bin}"

curl_fetch() {
  local url="$1" dest="$2"
  local -a hdrs=()
  local token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
  if [[ -n "${token}" ]] && [[ "${url}" == https://github.com/* || "${url}" == https://api.github.com/* ]]; then
    hdrs+=(-H "Authorization: Bearer ${token}")
  fi
  if [[ "${#hdrs[@]}" -gt 0 ]]; then
    curl -fsSL --retry 3 --retry-delay 2 "${hdrs[@]}" -o "${dest}" "${url}"
  else
    curl -fsSL --retry 3 --retry-delay 2 -o "${dest}" "${url}"
  fi
}

if [[ "${RELEASE_TAG}" == "latest" ]]; then
  api_json="$(mktemp)"
  trap 'rm -f "${api_json}"' EXIT
  curl_fetch "https://api.github.com/repos/${REPO}/releases?per_page=20" "${api_json}"
  RELEASE_TAG="$(python3 - "${api_json}" <<'PY'
import json, sys
for r in json.load(open(sys.argv[1])):
    if not r.get("draft") and str(r.get("tag_name", "")).startswith("codex-v"):
        print(r["tag_name"])
        raise SystemExit(0)
raise SystemExit(1)
PY
  )" || {
    echo "error: no published codex-v* release found in ${REPO}" >&2
    exit 1
  }
  rm -f "${api_json}"
fi

VER="${RELEASE_TAG#codex-}"
ASSET="codex-bridge-patched-codex-${VER}-${TARGET}.tar.gz"
BASE_URL="${CODEX_BRIDGE_RELEASE_BASE_URL:-https://github.com/${REPO}/releases/download/${RELEASE_TAG}}"

STAGE="$(mktemp -d)"
trap 'rm -rf "${STAGE}"' EXIT

echo "Downloading ${ASSET} from ${RELEASE_TAG}..."
if ! curl_fetch "${BASE_URL}/${ASSET}" "${STAGE}/${ASSET}"; then
  echo "error: failed to download ${BASE_URL}/${ASSET}" >&2
  echo "hint: if no prebuilt release exists for ${TARGET}, build locally with ./scripts/build-patched-codex.sh" >&2
  exit 1
fi
curl_fetch "${BASE_URL}/SHA256SUMS.txt" "${STAGE}/SHA256SUMS.txt"

expected_sha="$(awk -v f="${ASSET}" '$2 == f || $2 == ("*" f) { print $1; exit }' "${STAGE}/SHA256SUMS.txt")"
if [[ -z "${expected_sha}" ]]; then
  echo "error: ${ASSET} not listed in SHA256SUMS.txt" >&2
  exit 1
fi

actual_sha="$(shasum -a 256 "${STAGE}/${ASSET}" | awk '{print $1}')"
if [[ "${actual_sha}" != "${expected_sha}" ]]; then
  echo "error: SHA-256 mismatch for ${ASSET}" >&2
  echo "  expected: ${expected_sha}" >&2
  echo "  actual:   ${actual_sha}" >&2
  exit 1
fi
echo "verified: SHA-256 ${actual_sha}"

mkdir -p "${STAGE}/extract"
tar -xzf "${STAGE}/${ASSET}" -C "${STAGE}/extract"

for bin in codex codex-exec-server; do
  p="${STAGE}/extract/${bin}"
  if [[ -L "${p}" || ! -f "${p}" ]]; then
    echo "error: archive missing regular file '${bin}' (symlinks rejected)" >&2
    exit 1
  fi
  chmod 0755 "${p}"
  xattr -d com.apple.quarantine "${p}" 2>/dev/null || true
done

# Pre-install live XNU Seatbelt verification (fail-closed before modifying INSTALL_DIR)
STAGED_BIN="${STAGE}/extract/codex"
VERSION_OUT="$("${STAGED_BIN}" --version)"

probe_err_file="${STAGE}/probe.err"
set +e
probe_out="$(CODEX_BRIDGE_DENY_EXEC_SUBPATHS=/bin/echo "${STAGED_BIN}" sandbox -- /bin/echo __cb_deny_probe__ 2>"${probe_err_file}")"
probe_rc=$?
set -e
probe_err="$(cat "${probe_err_file}")"

if [[ "${probe_err}" == *"sandbox-exec: sandbox_apply: Operation not permitted"* ]]; then
  echo "note: nested sandbox prevents live sandbox-exec probe; continuing after SHA-256 verification"
else
  if [[ "${probe_rc}" -eq 0 ]] || [[ "${probe_out}" == *"__cb_deny_probe__"* ]] || ! printf '%s' "${probe_err}" | grep -Eiq 'Operation not permitted|Permission denied|EPERM'; then
    echo "error: staged binary failed live XNU Seatbelt deny-exec probe (rc=${probe_rc}, stderr=${probe_err})" >&2
    exit 1
  fi
  if ! CODEX_BRIDGE_DENY_EXEC_SUBPATHS=/bin/echo "${STAGED_BIN}" sandbox -- /usr/bin/true >/dev/null 2>&1; then
    echo "error: staged binary failed live Seatbelt control probe (/usr/bin/true)" >&2
    exit 1
  fi
  echo "verified: live XNU Seatbelt deny process-exec probe passed"
fi

mkdir -p "${INSTALL_DIR}"
for bin in codex codex-exec-server; do
  tmp="${INSTALL_DIR}/${bin}.tmp.$$"
  cp "${STAGE}/extract/${bin}" "${tmp}"
  chmod 0755 "${tmp}"
  mv -f "${tmp}" "${INSTALL_DIR}/${bin}"
done

# Preserve sibling codex-code-mode-host when installed standalone locally
OFFICIAL_CMH="${HOME}/.codex/packages/standalone/current/bin/codex-code-mode-host"
if [[ -x "${OFFICIAL_CMH}" ]]; then
  tmp="${INSTALL_DIR}/codex-code-mode-host.tmp.$$"
  cp "${OFFICIAL_CMH}" "${tmp}"
  chmod 0755 "${tmp}"
  mv -f "${tmp}" "${INSTALL_DIR}/codex-code-mode-host"
fi

echo "Installed bridge-private codex suite (${VERSION_OUT}) into: ${INSTALL_DIR}"
ls -lh "${INSTALL_DIR}"
