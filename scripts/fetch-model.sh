#!/usr/bin/env bash
# Download the baked Qwen2.5-Coder-1.5B model and stage it into a rootfs tree,
# so the image boots with a working model already in /var/lib/liteai/models.
#
# Usage: scripts/fetch-model.sh <rootfs-dir> [owner/repo] [file.gguf]
#
# The 1.5B q4_k_m quant (~1.1 GB) is the compromise that lets both images ship
# with the AI stack working out of the box: it runs in about 1.5 GB of RAM and
# keeps the ISO near 3 GB. The intended next step is asking pi to download
# something bigger - that is what model_download exists for - so this file is
# a floor, not a ceiling.
#
# LITEAI_MODEL_SRC, when set, is a path to an already-downloaded copy of the
# model (CI caches it between runs) and is copied instead of downloaded.

set -Eeuo pipefail

readonly AIROOTFS="${1:?usage: fetch-model.sh <rootfs-dir> [owner/repo] [file.gguf]}"
readonly REPO="${2:-${LITEAI_MODEL_REPO:-Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF}}"
readonly FILE="${3:-${LITEAI_MODEL_FILE:-qwen2.5-coder-1.5b-instruct-q4_k_m.gguf}}"
readonly URL="https://huggingface.co/${REPO}/resolve/main/${FILE}"

readonly MODELS_DIR="${AIROOTFS}/var/lib/liteai/models"

[[ -d "${AIROOTFS}" ]] || { echo "no such directory: ${AIROOTFS}" >&2; exit 1; }
[[ "${REPO}" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*/[A-Za-z0-9][A-Za-z0-9._-]*$ ]] ||
    { echo "not an owner/repo pair: ${REPO}" >&2; exit 1; }
[[ "${FILE}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*\.gguf$ ]] ||
    { echo "not a .gguf file name: ${FILE}" >&2; exit 1; }

mkdir -p "${MODELS_DIR}"
target="${MODELS_DIR}/${FILE}"

if [[ -n "${LITEAI_MODEL_SRC:-}" ]]; then
    [[ -f "${LITEAI_MODEL_SRC}" ]] || { echo "LITEAI_MODEL_SRC is set but missing: ${LITEAI_MODEL_SRC}" >&2; exit 1; }
    echo "==> copying the model from ${LITEAI_MODEL_SRC}"
    cp "${LITEAI_MODEL_SRC}" "${target}"
else
    echo "==> fetching ${URL}"
    curl --fail --location --retry 5 --retry-delay 3 --retry-connrefused \
        --continue-at - --silent --show-error \
        -o "${target}.part" "${URL}"
    mv "${target}.part" "${target}"
fi

sha="$(sha256sum "${target}" | cut -d' ' -f1)"
bytes="$(stat -c %s "${target}")"

# Same provenance side files the liteai-models helper writes, so a baked model
# and a downloaded one look identical to every tool that inspects them.
printf 'url=%s\nfetched=%s\nbytes=%s\nsha256=%s\n' \
    "${URL}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${bytes}" "${sha}" > "${target}.meta"
printf '%s  %s\n' "${sha}" "${FILE}" > "${MODELS_DIR}/SHA256SUMS"

chown -R 0:0 "${AIROOTFS}/var/lib/liteai" 2>/dev/null || true
chmod 0644 "${target}" "${target}.meta"

echo "==> staged ${FILE} ($(numfmt --to=iec --suffix=B "${bytes}" 2>/dev/null || echo "${bytes} bytes"), sha256 ${sha:0:12}...)"
