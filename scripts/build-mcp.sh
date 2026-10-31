#!/usr/bin/env bash
# Build the LiteAI MCP server and stage it into a rootfs tree.
#
# The server is a single self-contained bundle - the MCP SDK and zod are
# compiled in - so the image ships exactly one file,
# /usr/share/liteai/mcp/server.cjs, run by the system node with no
# node_modules anywhere. Architecture-neutral JavaScript, so CI builds it once
# and hands the same bytes to both image jobs (LITEAI_MCP_PREBUILT).
#
# Usage: scripts/build-mcp.sh -o <staging-dir>
#   Copies the built server to <staging-dir>/usr/share/liteai/mcp/server.cjs

set -Eeuo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT
readonly MCP_DIR="${REPO_ROOT}/mcp"

STAGE=""
while (( $# )); do
    case "$1" in
        -o|--out) STAGE="$2"; shift 2 ;;
        -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 1 ;;
    esac
done
[[ -n "${STAGE}" ]] || { echo "usage: build-mcp.sh -o <staging-dir>" >&2; exit 1; }

if [[ -n "${LITEAI_MCP_PREBUILT:-}" ]]; then
    # CI hand-off: the mcp job already built and tested this exact tree. Accept
    # the file itself, a directory holding it at its root, or the staged tree
    # layout this script produces (usr/share/liteai/mcp/server.cjs).
    echo "==> using prebuilt MCP server from ${LITEAI_MCP_PREBUILT}"
    src=""
    if [[ -f "${LITEAI_MCP_PREBUILT}" ]]; then
        src="${LITEAI_MCP_PREBUILT}"
    elif [[ -f "${LITEAI_MCP_PREBUILT}/server.cjs" ]]; then
        src="${LITEAI_MCP_PREBUILT}/server.cjs"
    else
        src="$(find "${LITEAI_MCP_PREBUILT}" -type f -name server.cjs -print -quit 2>/dev/null || true)"
    fi
    [[ -n "${src}" ]] || { echo "no server.cjs found under ${LITEAI_MCP_PREBUILT}" >&2; exit 1; }
    install -Dm0644 "${src}" "${STAGE}/usr/share/liteai/mcp/server.cjs"
    exit 0
fi

echo "==> building the LiteAI MCP server"
(
    cd "${MCP_DIR}"
    if [[ ! -d node_modules ]]; then
        npm ci --no-audit --no-fund
    fi
    # Tests before bundling: the bundle is what ships, the tests are what
    # make shipping it reasonable.
    npm test
    npm run build
)

install -Dm0644 "${MCP_DIR}/out/server.cjs" "${STAGE}/usr/share/liteai/mcp/server.cjs"
echo "==> staged ${STAGE}/usr/share/liteai/mcp/server.cjs ($(du -h "${MCP_DIR}/out/server.cjs" | cut -f1))"
