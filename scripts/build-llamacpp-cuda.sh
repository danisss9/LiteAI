#!/usr/bin/env bash
# Build llama.cpp from source with CUDA enabled and stage it inside a rootfs
# tree, replacing the prebuilt CPU binary the other variants ship.
#
# Usage: scripts/build-llamacpp-cuda.sh <rootfs-dir>
#        scripts/build-llamacpp-cuda.sh --verify <built-rootfs-dir>
#
# Build mode runs as root inside the privileged Arch container that
# build-iso.sh executes in (the workflow upgrades that container before the
# build starts). It installs the CUDA toolkit into the container with pacman
# - build-time only: the toolkit itself never enters the image. The staged
# tree keeps the /opt/llama.cpp/bin layout liteai-llama.service hardcodes,
# and the CUDA runtime libraries cudart does not statically link (cuBLAS,
# cuBLASLt, nvJitLink) are copied out of the toolkit into /opt/llama.cpp/lib.
# libcuda.so.1 comes from the image's nvidia-utils package, which only lands
# during mkarchiso - hence --verify mode, called by build-iso.sh against the
# finished rootfs, where every dependency must resolve and the driver files
# must be present.
#
# LITEAI_LLAMACPP_BUILD overrides the pinned build - the same pin
# fetch-llamacpp.sh uses, so both ISO variants ship the same llama.cpp.
#
# If a future Arch gcc is too new for the CUDA release of the day (nvcc
# refuses it in crt/host_config.h), install 'gcc15' as well and add
# -DCMAKE_CUDA_HOST_COMPILER=gcc-15 to the configure line below.

set -Eeuo pipefail

readonly BUILD="${LITEAI_LLAMACPP_BUILD:-b12017}"
# CUDA 13 supports sm_75 (Turing, 2016) and newer. One cubin per listed
# architecture, plus the compute_90 PTX image, which the driver JIT-compiles
# for anything newer still to come (Blackwell datacenter sm_103 and beyond).
readonly CUDA_ARCHITECTURES="75-real;80-real;86-real;89-real;90-real;100-real;120-real;90-virtual"
readonly SOURCE_URL="https://github.com/ggml-org/llama.cpp/archive/refs/tags/${BUILD}.tar.gz"

readonly CMAKE_FLAGS=(
    -DCMAKE_BUILD_TYPE=Release
    -DCMAKE_INSTALL_LIBDIR=lib
    -DCMAKE_INSTALL_RPATH='$ORIGIN;$ORIGIN/../lib'
    -DCMAKE_CUDA_ARCHITECTURES="${CUDA_ARCHITECTURES}"
    -DCMAKE_CUDA_RUNTIME_LIBRARY=Static
    # Arch installs the toolkit under /opt/cuda, which is neither on the
    # default PATH nor in CMake's search path in a non-login shell.
    -DCUDAToolkit_ROOT=/opt/cuda
    -DGGML_CUDA=ON
    # A fixed baseline CPU build: the GPU is the point of this variant and
    # the CPU side is only its fallback, but it must run on any x86-64 host.
    -DGGML_NATIVE=OFF
    -DLLAMA_CURL=OFF
    -DLLAMA_BUILD_TESTS=OFF
    -DLLAMA_BUILD_EXAMPLES=OFF
)

# Used by check_needed; set at each call site.
SEARCH_DIRS=()
NEED_EXEMPT_RE='^$'

msg() { printf '\e[38;5;39m==>\e[0m %s\n' "$*"; }
die() { printf '\e[38;5;203merror\e[0m %s\n' "$*" >&2; exit 1; }

# check_needed elf... - every DT_NEEDED entry of each real file must exist
# in one of SEARCH_DIRS, unless it matches NEED_EXEMPT_RE.
check_needed() {
    local elf needed dir found rc=0
    for elf in "$@"; do
        [[ -f "${elf}" && ! -L "${elf}" ]] || continue
        while IFS= read -r needed; do
            [[ "${needed}" =~ ${NEED_EXEMPT_RE} ]] && continue
            found=""
            for dir in "${SEARCH_DIRS[@]}"; do
                if [[ -e "${dir}/${needed}" ]]; then found=1; break; fi
            done
            if [[ -z "${found}" ]]; then
                printf '  unresolved: %s (needed by %s)\n' \
                    "${needed}" "$(basename "${elf}")" >&2
                rc=1
            fi
        done < <(readelf -d "${elf}" 2>/dev/null | sed -n 's/.*Shared library: \[\([^]]*\)\].*/\1/p')
    done
    return "${rc}"
}

verify_image() {
    local prefix="${AIROOTFS}/opt/llama.cpp" fails=0 entry elf
    msg "verifying the built CUDA image root in ${AIROOTFS}"

    [[ -x "${prefix}/bin/llama-server" ]] || die "missing ${prefix}/bin/llama-server"

    # The driver side of the stack, all of it installed by the image's own
    # packages during mkarchiso.
    for entry in \
        'usr/lib/libcuda.so.*' \
        'usr/lib/libnvidia-ml.so.*' \
        'usr/lib/libnvidia-ptxjitcompiler.so.*' \
        'usr/bin/nvidia-smi' \
        'etc/modules-load.d/liteai-nvidia.conf'; do
        if ! compgen -G "${AIROOTFS}/${entry}" >/dev/null; then
            echo "  missing ${entry}" >&2
            fails=1
        fi
    done

    # GSP firmware ships with nvidia-utils under a versioned directory.
    compgen -G "${AIROOTFS}/usr/lib/firmware/nvidia/*/gsp_*.bin" >/dev/null ||
        { echo "  missing GSP firmware under usr/lib/firmware/nvidia" >&2; fails=1; }

    # The display-only trim must have applied - these are the files the
    # NoExtract lines exclude, and their presence would mean that list
    # rotted and the ISO is carrying dead weight again.
    if compgen -G "${AIROOTFS}/usr/lib/libGLX_nvidia.so*" >/dev/null; then
        echo "  display libraries were not trimmed (libGLX_nvidia present)" >&2
        fails=1
    fi

    SEARCH_DIRS=("${prefix}/bin" "${prefix}/lib" "${AIROOTFS}/usr/lib")
    NEED_EXEMPT_RE='^$'
    check_needed "${prefix}"/bin/llama-* "${prefix}"/lib/*.so* || fails=1

    # ... and the driver libraries' own dependencies: this is what catches,
    # say, a trimmed library that the PTX JIT compiler actually still needed.
    for elf in "${AIROOTFS}"/usr/lib/libcuda.so.* \
               "${AIROOTFS}"/usr/lib/libnvidia-ptxjitcompiler.so.* \
               "${AIROOTFS}"/usr/lib/libnvidia-ml.so.*; do
        check_needed "${elf}" || fails=1
    done

    (( fails == 0 )) || die "CUDA image verification FAILED"
    msg "CUDA image verification passed"
}

mode="build"
if [[ "${1:-}" == "--verify" ]]; then
    mode="verify"
    shift
fi
AIROOTFS="${1:?usage: build-llamacpp-cuda.sh [--verify] <rootfs-dir>}"
readonly AIROOTFS

[[ -d "${AIROOTFS}" ]] || die "no such directory: ${AIROOTFS}"

if [[ "${mode}" == "verify" ]]; then
    command -v readelf >/dev/null || die "readelf not found - install binutils"
    verify_image
    exit 0
fi

(( EUID == 0 )) ||
    die "the build must run as root inside the Arch container (pacman installs the toolkit)"

msg "installing the CUDA toolkit and toolchain (build-time only, ~8 GB in the container)"
pacman -Sy --needed --noconfirm cuda gcc cmake ninja binutils

tmp="$(mktemp -d)"
trap 'rm -rf -- "${tmp}"' EXIT

msg "fetching llama.cpp ${BUILD} source"
curl --fail --location --retry 5 --retry-delay 3 --retry-connrefused \
    --silent --show-error -o "${tmp}/llamacpp.tar.gz" "${SOURCE_URL}"
tarball_sha256="$(sha256sum "${tmp}/llamacpp.tar.gz" | cut -d' ' -f1)"
echo "    sha256: ${tarball_sha256}"

mkdir -p "${tmp}/src"
tar -xzf "${tmp}/llamacpp.tar.gz" -C "${tmp}/src" --strip-components=1

msg "configuring (GGML_CUDA=ON; architectures: ${CUDA_ARCHITECTURES})"
# -G Ninja: the container has ninja but no make, and Unix Makefiles is the
# default generator. nvcc on PATH too: nvcc's host-compiler handling and
# CMake's checks both want to find it as a plain command.
export PATH="/opt/cuda/bin:${PATH}"
cmake -G Ninja -S "${tmp}/src" -B "${tmp}/build" "${CMAKE_FLAGS[@]}"

msg "building (the long step)"
cmake --build "${tmp}/build" -j"$(nproc)"

readonly PREFIX="${AIROOTFS}/opt/llama.cpp"
rm -rf -- "${PREFIX}"

msg "installing into ${PREFIX}"
cmake --install "${tmp}/build" --prefix "${PREFIX}" --strip

# The install rules may drop headers, cmake configs and pkgconfig files that
# nothing on the image consumes; prune them so /opt/llama.cpp stays binaries
# plus libraries.
rm -rf -- "${PREFIX}/include" "${PREFIX}/share" "${PREFIX}/lib/cmake" "${PREFIX}/lib/pkgconfig"

msg "bundling the CUDA runtime libraries (cudart is statically linked)"
# Toolkit copies first: those are the ones this build ran against.
for name in libcublas.so.13 libcublasLt.so.13 libnvJitLink.so.13; do
    src=""
    for dir in /opt/cuda/lib64 /usr/lib; do
        if compgen -G "${dir}/${name}*" >/dev/null; then src="${dir}"; break; fi
    done
    [[ -n "${src}" ]] || die "cannot find ${name} in /opt/cuda/lib64 or /usr/lib"
    cp -a "${src}/${name}"* "${PREFIX}/lib/"
done

install -Dm0644 /dev/stdin "${AIROOTFS}/usr/share/liteai/llama-version" <<EOF
build=${BUILD}
arch=x86_64
backend=cuda
cuda_architectures=${CUDA_ARCHITECTURES}
source=${SOURCE_URL}
sha256=${tarball_sha256}
fetched=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

chown -R 0:0 "${PREFIX}" 2>/dev/null || true

msg "checking staged dependencies against the container"
# Everything resolves here except the driver's libcuda.so.1, which the image
# gets from nvidia-utils during mkarchiso - that one is checked by --verify.
SEARCH_DIRS=("${PREFIX}/bin" "${PREFIX}/lib" /usr/lib)
NEED_EXEMPT_RE='^libcuda\.so'
check_needed "${PREFIX}"/bin/llama-* "${PREFIX}"/lib/*.so* ||
    die "unresolved dependencies in the staged tree"

msg "staged llama.cpp ${BUILD} (CUDA) in ${PREFIX}"
du -sh "${PREFIX}/bin" "${PREFIX}/lib"

msg "removing the CUDA toolkit from the container (it must not leak into the image)"
pacman -Rns --noconfirm cuda ||
    echo "warning: cuda removal failed - continuing (the container is throwaway)" >&2
pacman -Scc --noconfirm >/dev/null 2>&1 || true
