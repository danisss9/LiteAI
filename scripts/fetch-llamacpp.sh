#!/usr/bin/env bash
# Download the prebuilt llama.cpp binaries and stage them inside a rootfs tree,
# so the image ships a ready-to-run llama-server with no network access and no
# compiler needed at install time.
#
# Usage: scripts/fetch-llamacpp.sh <rootfs-dir> [x64|arm64]
#
# Why a prebuilt binary and not a package: llama.cpp lives in the AUR (a build
# from source at image-build time would add an hour to every CI run and a
# toolchain to the container), and Arch ships nothing official. Upstream
# publishes ready-made builds for both of our architectures with every
# nightly, so pinning one of those is reproducible, verifiable and small.
#
# x64 takes the Vulkan build: one binary offloads to AMD (RADV) and Intel
# (ANV) GPUs through the Mesa ICDs the standard ISO ships, and falls back to
# CPU inference when there is no Vulkan device - which is why it can be the
# standard image's only binary. NVIDIA cards are the CUDA ISO's job (that
# build is compiled from source in build-llamacpp-cuda.sh). The Raspberry Pi
# keeps the plain CPU build: its v3dv Vulkan driver gains nothing worth the
# bytes. Rebuilding with other backends on the installed machine is the
# documented upgrade path - base-devel, cmake and python ship in the image
# for exactly that.
#
# LITEAI_LLAMACPP_BUILD overrides the pinned build (e.g. b12017).

set -Eeuo pipefail

readonly AIROOTFS="${1:?usage: fetch-llamacpp.sh <rootfs-dir> [x64|arm64]}"
readonly BUILD="${LITEAI_LLAMACPP_BUILD:-b12017}"

case "${2:-x64}" in
    x64|x86_64|amd64)   readonly ARCH_SLUG="x64";   readonly FLAVOR="vulkan" ;;
    arm64|aarch64)      readonly ARCH_SLUG="arm64"; readonly FLAVOR="" ;;
    *) echo "unsupported architecture: $2" >&2; exit 1 ;;
esac

readonly URL="https://github.com/ggml-org/llama.cpp/releases/download/${BUILD}/llama-${BUILD}-bin-ubuntu-${FLAVOR:+${FLAVOR}-}${ARCH_SLUG}.tar.gz"
readonly PREFIX="${AIROOTFS}/opt/llama.cpp"

[[ -d "${AIROOTFS}" ]] || { echo "no such directory: ${AIROOTFS}" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

echo "==> fetching llama.cpp ${BUILD} (${FLAVOR:+${FLAVOR} }${ARCH_SLUG})"
curl --fail --location --retry 5 --retry-delay 3 --retry-connrefused \
    --silent --show-error -o "${tmp}/llamacpp.tar.gz" "${URL}"

echo "==> sha256: $(sha256sum "${tmp}/llamacpp.tar.gz" | cut -d' ' -f1)"

rm -rf "${PREFIX}"

# Extract into the temp dir and find the binary there: the archives have
# changed their internal layout more than once (flat, inside one wrapper
# directory, or split into bin/ + lib/), and staging into the same directory
# that is being searched is how off-by-one trees get shipped.
mkdir -p "${tmp}/extract"
tar -xzf "${tmp}/llamacpp.tar.gz" -C "${tmp}/extract"

server="$(find "${tmp}/extract" -type f -name llama-server | head -1)"
[[ -n "${server}" ]] || { echo "archive has no llama-server binary" >&2; exit 1; }
server_dir="$(dirname "${server}")"
archive_root="$(dirname "${server_dir}")"

# Stage the directory that holds the binary into /opt/llama.cpp/bin - the
# layout liteai-llama.service hardcodes. In the flat layouts the shared
# libraries sit beside the binary and its $ORIGIN rpath finds them there; in
# the bin/lib split a sibling lib/ directory is carried along too.
mkdir -p "${PREFIX}/bin"
cp -a "${server_dir}/." "${PREFIX}/bin/"
for d in lib lib64; do
    if [[ -d "${archive_root}/${d}" && "${archive_root}/${d}" != "${server_dir}" ]]; then
        mkdir -p "${PREFIX}/${d}"
        cp -aT "${archive_root}/${d}" "${PREFIX}/${d}"
    fi
done

[[ -x "${PREFIX}/bin/llama-server" ]] || { echo "llama-server is not executable after staging" >&2; exit 1; }
chmod 0755 "${PREFIX}"/bin/llama-* 2>/dev/null || true

# Record what went in, so the running system can report its own provenance and
# the liteai-pi/llama tooling can name the build it is running.
install -Dm0644 /dev/stdin "${AIROOTFS}/usr/share/liteai/llama-version" <<EOF
build=${BUILD}
arch=${ARCH_SLUG}
backend=${FLAVOR:-cpu}
source=${URL}
sha256=$(sha256sum "${tmp}/llamacpp.tar.gz" | cut -d' ' -f1)
fetched=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

chown -R 0:0 "${PREFIX}" 2>/dev/null || true
echo "==> staged llama.cpp ${BUILD} (${FLAVOR:+${FLAVOR} }${ARCH_SLUG}) in ${PREFIX}"
