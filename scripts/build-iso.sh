#!/usr/bin/env bash
# Build the LiteAI installation ISO.
#
# Must run as root on Arch Linux (or inside an Arch container) with archiso
# installed. The GitHub Actions workflow does exactly that; see the README for
# the one-liner to reproduce a build locally.
#
# Usage: sudo scripts/build-iso.sh [--variant cpu|cuda] [-o out-dir] [-w work-dir] [-v version]

set -Eeuo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT
readonly PROFILE_SRC="${REPO_ROOT}/archiso"
readonly ROOTFS_COMMON="${REPO_ROOT}/rootfs-common"

OUT_DIR="${REPO_ROOT}/out"
WORK_DIR="${REPO_ROOT}/work"
BUILD_VERSION="${ISO_VERSION:-$(date +%Y.%m.%d)}"
VARIANT="cpu"

msg()  { printf '\e[38;5;39m==>\e[0m %s\n' "$*"; }
die()  { printf '\e[38;5;203merror\e[0m %s\n' "$*" >&2; exit 1; }

while (( $# )); do
    case "$1" in
        -o|--out)     OUT_DIR="$2"; shift 2 ;;
        -w|--work)    WORK_DIR="$2"; shift 2 ;;
        -v|--version) BUILD_VERSION="$2"; shift 2 ;;
        --variant)    VARIANT="$2"; shift 2 ;;
        -h|--help)    sed -n '2,9p' "$0"; exit 0 ;;
        *) die "unknown argument: $1" ;;
    esac
done

OUT_DIR="$(readlink -m -- "${OUT_DIR}")"
WORK_DIR="$(readlink -m -- "${WORK_DIR}")"

case "${VARIANT}" in
    cpu|cuda) ;;
    *) die "unknown variant: ${VARIANT} (use cpu or cuda)" ;;
esac

(( EUID == 0 )) || die "this build must run as root (mkarchiso needs it)"
command -v mkarchiso >/dev/null || die "mkarchiso not found - install the 'archiso' package"

readonly RELENG="/usr/share/archiso/configs/releng"
[[ -f "${RELENG}/grub/grub.cfg" ]] ||
    die "${RELENG}/grub/grub.cfg is missing - this build needs archiso >= 86 (GRUB-based UEFI boot)"

# The profile asks for the 'uefi.grub' boot mode, which archiso 86 introduced in
# place of the uefi-{ia32,x64}.grub.{esp,eltorito} quartet.
grep -q '_validate_requirements_bootmode_uefi\.grub()' "$(command -v mkarchiso)" ||
    die "this mkarchiso does not know the 'uefi.grub' boot mode - update 'archiso' to 86 or newer"

# GRUB is only an optional dependency of archiso, so a host with mkarchiso
# cannot necessarily build the UEFI boot modes. Checking here fails the build in
# seconds instead of after the profile has been staged and the model downloaded.
command -v grub-mkstandalone >/dev/null ||
    die "grub-mkstandalone not found - install the 'grub' package (archiso needs it for UEFI boot)"

# --------------------------------------------------------------------------
# assemble a throwaway copy of the profile
# --------------------------------------------------------------------------

readonly PROFILE="${WORK_DIR}/profile"
msg "staging profile in ${PROFILE}"

# An aborted earlier run can leave mkarchiso's bind mounts behind; drop them
# before deleting anything so rm never recurses into a mounted filesystem.
if [[ -d "${WORK_DIR}" ]]; then
    while read -r mp; do
        [[ -n "${mp}" ]] || continue
        umount -R "${mp}" 2>/dev/null || umount -Rl "${mp}" 2>/dev/null || true
    done < <(findmnt -rno TARGET | awk -v d="${WORK_DIR}/" 'index($0, d) == 1' | sort -r)
fi

# The work directory is frequently a mount point rather than a plain directory -
# the CI job hands the build a volume on the roomy ephemeral disk - and removing
# a mount point fails with EBUSY, so empty it instead of deleting it.
mkdir -p "${WORK_DIR}" "${OUT_DIR}"
find "${WORK_DIR}" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
mkdir -p "${PROFILE}"
cp -a "${PROFILE_SRC}/." "${PROFILE}/"

# The system itself is architecture-neutral and shared with the Raspberry Pi
# image; the profile's own airootfs holds only the x86/live-medium extras.
install -d -m 0755 "${PROFILE}/airootfs"
cp -a "${ROOTFS_COMMON}/." "${PROFILE}/airootfs/"

# The CUDA variant layers the NVIDIA stack onto the standard one: extra
# packages, a small overlay (module loading, the loader path for the bundled
# CUDA runtime) and the NoExtract trims below - all applied to the staged
# profile only, so archiso/ stays the shared source of truth.
readonly -a NVIDIA_TRIM=(
    # GLX/EGL/GLES and their engines - there is no graphics stack to feed
    usr/lib/libGLX_nvidia.so*
    usr/lib/libEGL_nvidia.so*
    usr/lib/libGLESv1_CM_nvidia.so*
    usr/lib/libGLESv2_nvidia.so*
    usr/lib/libnvidia-glcore.so*
    usr/lib/libnvidia-eglcore.so*
    usr/lib/libnvidia-glsi.so*
    usr/lib/libnvidia-glvkspirv.so*
    usr/lib/libnvidia-rtcore.so*
    usr/lib/libnvoptix.so*
    # libnvidia-gpucomp stays: it is the driver's shader-compiler core, and
    # keeping it is cheap insurance for the CUDA JIT path the image depends
    # on (verify checks libcuda/ptxjitcompiler's dependencies; a missing one
    # here would fail the build late).
    # GBM/VDPAU display and video-surface paths
    usr/lib/nvidia-drm_gbm.so
    usr/lib/libvdpau_nvidia.so*
    # NVENC/NVDEC - no video pipeline in the image
    usr/lib/libnvidia-encode.so*
    usr/lib/libnvcuvid.so*
    usr/lib/libnvidia-fbc.so*
    usr/lib/libnvidia-opticalflow.so*
    # Vulkan-SC, DLSS/Proton, confidential compute, datacenter fabric
    usr/lib/libnvidia-vksc-core.so*
    usr/lib/libnvidia-pkcs11.so*
    usr/lib/libnvidia-pkcs11-openssl3.so*
    usr/lib/libnvidia-ngx.so*
    usr/lib/libnvidia-imex.so*
    usr/lib/libnvidia-fmdrv.so*
    usr/lib/libnvidia-tileiras.so*
    usr/lib/libnvidia-sandboxutils.so*
    usr/lib/libnvidia-present.so*
    usr/lib/libcudadebugger.so*
    # Xorg module, Wine/Proton shims, the X-only tool
    usr/lib/nvidia/xorg/*
    usr/lib/nvidia/wine/*
    usr/bin/nvidia-xconfig
    # Vulkan ICDs, GL application profiles, docs, Xorg outputclass config
    usr/share/vulkan/*
    usr/share/nvidia/*
    usr/share/X11/xorg.conf.d/nvidia-drm-outputclass.conf
)

if [[ "${VARIANT}" == "cuda" ]]; then
    msg "applying the CUDA variant"
    cp -a "${REPO_ROOT}/archiso/airootfs-cuda/." "${PROFILE}/airootfs/"
    cat "${REPO_ROOT}/archiso/packages-cuda.x86_64" >> "${PROFILE}/packages.x86_64"

    # nvidia-utils is ~950 MB and mostly display stack this image cannot
    # use; NoExtract makes pacstrap skip those files outright. Everything on
    # the CUDA/driver path (libcuda, NVML, the PTX JIT compiler, GSP
    # firmware, nvidia-smi) stays, and build-llamacpp-cuda.sh --verify
    # checks exactly that after the build.
    for pattern in "${NVIDIA_TRIM[@]}"; do
        sed -i "/^\[options\]$/a NoExtract = ${pattern}" "${PROFILE}/pacman.conf"
    done
    grep -q '^NoExtract' "${PROFILE}/pacman.conf" ||
        die "NoExtract trims were not applied to the staged pacman.conf"

    # Same llama.cpp pin, built for CUDA; GPU offload on by default. On a
    # machine without a supported NVIDIA GPU the CUDA backend finds no
    # device, llama.cpp falls back to CPU, and the flag is ignored.
    sed -i 's/^EXTRA_ARGS=$/EXTRA_ARGS=-ngl 99/' "${PROFILE}/airootfs/etc/liteai/llama.conf"

    sed -i \
        -e 's/^iso_name="liteai"$/iso_name="liteai-cuda"/' \
        -e 's/^iso_application="LiteAI Live\/Install Medium"$/iso_application="LiteAI CUDA Live\/Install Medium"/' \
        "${PROFILE}/profiledef.sh"
fi

# Boot menus come from the archiso release we are building against, so they
# always match the tooling's expectations; only the branding is ours.
msg "importing boot loader configuration from archiso ${RELENG##*/}"
cp -a "${RELENG}/syslinux" "${RELENG}/grub" "${PROFILE}/"
if [[ -d "${RELENG}/efiboot" ]]; then cp -a "${RELENG}/efiboot" "${PROFILE}/"; fi

find "${PROFILE}"/{syslinux,grub,efiboot} -type f \( -name '*.cfg' -o -name '*.conf' \) -print0 2>/dev/null |
    xargs -0 --no-run-if-empty sed -i \
        -e 's/Arch Linux install medium/LiteAI/g' \
        -e 's/Arch Linux/LiteAI/g' \
        -e 's/Arch menu/LiteAI menu/g'

if [[ "${VARIANT}" == "cuda" ]]; then
    find "${PROFILE}"/{syslinux,grub,efiboot} -type f \( -name '*.cfg' -o -name '*.conf' \) -print0 2>/dev/null |
        xargs -0 --no-run-if-empty sed -i 's/LiteAI/LiteAI CUDA/g'
fi

# --------------------------------------------------------------------------
# make the enablement symlinks real
# --------------------------------------------------------------------------

# The repository is edited on machines whose filesystems cannot hold symlinks
# (Windows), where each entry in a .wants directory degrades into a plain file
# containing the target path. systemd follows only symlinks there, so rebuild
# every such entry - and the default.target link - for real on this host.
normalize_symlink_stubs() {
    local dir="$1" name target
    while IFS= read -r -d '' entry; do
        name="$(basename "${entry}")"
        [[ -f "${entry}" && ! -L "${entry}" ]] || continue
        target="$(cat "${entry}")"
        # A real enablement entry is one line naming a unit under /usr/lib or
        # /etc; anything else is just a file that happens to live there.
        [[ "${target}" == /* && ! "${target}" == *$'\n'* ]] || continue
        rm -f "${entry}"
        ln -s "${target}" "${entry}"
        msg "  relinked ${name} -> ${target}"
    done < <(find "${dir}" -type f -print0)
}

msg "normalising systemd enablement symlinks"
normalize_symlink_stubs "${PROFILE}/airootfs/etc/systemd/system"

# The model server is the reason this image exists; enable it here, where a
# real ln -s is guaranteed, rather than hoping the source tree survived whatever
# filesystem carried it.
mkdir -p "${PROFILE}/airootfs/etc/systemd/system/multi-user.target.wants"
ln -sfn /usr/lib/systemd/system/liteai-llama.service \
    "${PROFILE}/airootfs/etc/systemd/system/multi-user.target.wants/liteai-llama.service"

# --------------------------------------------------------------------------
# stage the AI stack: llama.cpp, the model, pi and the MCP server
# --------------------------------------------------------------------------

msg "staging llama.cpp (${VARIANT})"
if [[ "${VARIANT}" == "cuda" ]]; then
    "${REPO_ROOT}/scripts/build-llamacpp-cuda.sh" "${PROFILE}/airootfs"
    # No ldconfig here: the loader cache is regenerated by pacstrap's glibc
    # hook after mkarchiso copies this tree in - with the overlay's
    # /etc/ld.so.conf.d/liteai-llamacpp.conf already in place.
else
    "${REPO_ROOT}/scripts/fetch-llamacpp.sh" "${PROFILE}/airootfs" x64
fi

msg "staging the local model"
"${REPO_ROOT}/scripts/fetch-model.sh" "${PROFILE}/airootfs"

msg "staging pi"
"${REPO_ROOT}/scripts/fetch-pi.sh" "${PROFILE}/airootfs"

msg "staging the LiteAI MCP server"
"${REPO_ROOT}/scripts/build-mcp.sh" -o "${PROFILE}/airootfs"
chown -R 0:0 "${PROFILE}/airootfs/usr/share/liteai" 2>/dev/null || true

# --------------------------------------------------------------------------
# materialise the liteai account's home from /etc/skel
# --------------------------------------------------------------------------

# mkarchiso does not run useradd, so the account's dotfiles - including the
# preseeded pi configuration in .pi/agent - have to exist in the image already.
msg "materialising /home/liteai from /etc/skel"
install -d -m 0755 "${PROFILE}/airootfs/home"
cp -a "${PROFILE}/airootfs/etc/skel" "${PROFILE}/airootfs/home/liteai"
chown -R 1000:1000 "${PROFILE}/airootfs/home/liteai"
chmod 0750 "${PROFILE}/airootfs/home/liteai"

# The live user's sudoers entry is 0440 root-owned (profiledef.sh enforces it),
# and the helper scripts must be root-owned 0755 because polkit grants pkexec
# on each of them by exact path.
chmod 0755 "${PROFILE}/airootfs/usr/local/bin/"liteai-*

# Record the build so the running system can identify itself.
llama_build="$(sed -n 's/^build=//p' "${PROFILE}/airootfs/usr/share/liteai/llama-version")"
pi_version="$(sed -n 's/^version=//p' "${PROFILE}/airootfs/usr/share/liteai/pi-version")"
model_file="$(sed -n 's/^MODEL=//p' "${PROFILE}/airootfs/etc/liteai/llama.conf")"
os_name="LiteAI"
[[ "${VARIANT}" == "cuda" ]] && os_name="LiteAI CUDA"
install -Dm0644 /dev/stdin "${PROFILE}/airootfs/etc/os-release" <<EOF
NAME="${os_name}"
PRETTY_NAME="${os_name} ${BUILD_VERSION}"
ID=liteai
ID_LIKE=arch
BUILD_ID=${BUILD_VERSION}
VERSION_ID=${BUILD_VERSION}
VARIANT_ID=${VARIANT}
ANSI_COLOR="38;5;39"
HOME_URL="https://github.com/danisss9/LiteAI"
SUPPORT_URL="https://github.com/danisss9/LiteAI/issues"
BUG_REPORT_URL="https://github.com/danisss9/LiteAI/issues"
EOF
install -Dm0644 /dev/stdin "${PROFILE}/airootfs/usr/share/liteai/build-info" <<EOF
build_version=${BUILD_VERSION}
variant=${VARIANT}
llama_build=${llama_build}
pi_version=${pi_version}
model=${model_file}
built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
git_commit=$(git -C "${REPO_ROOT}" rev-parse --short HEAD 2>/dev/null || echo unknown)
EOF

# --------------------------------------------------------------------------
# build
# --------------------------------------------------------------------------

# mkarchiso copies the profile's airootfs with --no-preserve=mode, so anything
# file_permissions does not name lands as 0644 - which strips the exec bit from
# whatever the staging above produced (llama-server, pi's entry point, ...).
# Name every executable rather than keep a list that rots with each pin bump.
find "${PROFILE}/airootfs" -type f -perm /111 -printf '/%P\0' |
    while IFS= read -r -d '' path; do
        printf 'file_permissions[%q]=0:0:755\n' "${path}"
    done >> "${PROFILE}/profiledef.sh"

msg "building ${VARIANT} ISO ${BUILD_VERSION} (llama.cpp ${llama_build}, pi ${pi_version})"
export ISO_VERSION="${BUILD_VERSION}"
mkarchiso -v -w "${WORK_DIR}/mkarchiso" -o "${OUT_DIR}" "${PROFILE}"

# The staged tree could not be checked against the driver before pacstrap
# ran (nvidia-utils only lands inside mkarchiso); verify the finished root
# while it is still on disk.
if [[ "${VARIANT}" == "cuda" ]]; then
    # The pacman database marks the finished root; %p (not %h) is the match
    # itself, and the image root is that path minus the db suffix.
    pkgdb="$(find "${WORK_DIR}" -type d -path '*/airootfs/var/lib/pacman' -print -quit)"
    image_root="${pkgdb%/var/lib/pacman}"
    if [[ -n "${pkgdb}" ]]; then
        "${REPO_ROOT}/scripts/build-llamacpp-cuda.sh" --verify "${image_root}"
    else
        msg "warning: could not locate the built airootfs - skipping CUDA verification"
    fi
fi

# --------------------------------------------------------------------------
# publish artefacts
# --------------------------------------------------------------------------

iso="$(find "${OUT_DIR}" -maxdepth 1 -name '*.iso' -printf '%T@ %p\n' | sort -rn | head -1 | cut -d' ' -f2-)"
[[ -n "${iso}" ]] || die "mkarchiso produced no ISO"

iso_suffix=""
[[ "${VARIANT}" == "cuda" ]] && iso_suffix="-cuda"

target="${OUT_DIR}/LiteAI-${BUILD_VERSION}-x86_64${iso_suffix}.iso"
if [[ "${iso}" != "${target}" ]]; then mv -- "${iso}" "${target}"; fi

( cd "${OUT_DIR}" && sha256sum "${target##*/}" > "${target##*/}.sha256" )

# --------------------------------------------------------------------------
# package manifest
# --------------------------------------------------------------------------

# Nothing in the profile pins a version - pacstrap installs whatever the
# mirrors were serving during this run - so the only record of what shipped is
# the one written here, in the 'name version' form `pacman -Q` prints. The ISO
# already went out above, so a manifest that cannot be produced is a missing
# nicety rather than a failed build: none of this is allowed to be fatal.
manifest="${OUT_DIR}/LiteAI-${BUILD_VERSION}-x86_64${iso_suffix}.packages.txt"
rm -f "${manifest}"

# The image's own package database is the authority on what it contains.
pkgdb="$(find "${WORK_DIR}" -type d -path '*/airootfs/var/lib/pacman' -print -quit)"
if [[ -n "${pkgdb}" ]]; then
    pacman -Q --dbpath "${pkgdb}" 2>/dev/null | sort -u > "${manifest}" || true
fi

# Failing that, the list mkarchiso puts on the medium as /arch/pkglist.*.txt,
# whose lines read 'repo/name-pkgver-pkgrel'. Neither a pkgver nor a pkgrel may
# contain a hyphen, so the name is everything before the last two
# dash-separated fields - which is the only way to split it, since plenty of
# names (linux-firmware-intel) contain hyphens themselves.
if [[ ! -s "${manifest}" ]]; then
    pkglist="$(find "${WORK_DIR}" -type f -name 'pkglist.*.txt' -print -quit)"
    if [[ -n "${pkglist}" ]]; then
        sed 's|^[^/]*/||' "${pkglist}" | awk '
            {
                n = split($0, f, "-")
                if (n < 3) { print $0; next }
                version = f[n - 1] "-" f[n]
                print substr($0, 1, length($0) - length(version) - 1), version
            }' | sort -u > "${manifest}" || true
    fi
fi

if [[ ! -s "${manifest}" ]]; then
    rm -f "${manifest}"
    msg "warning: no package database or list left in ${WORK_DIR} - no manifest written"
fi

msg "done"
printf '    %s\n    %s\n' "${target}" "$(du -h "${target}" | cut -f1)"
if [[ -s "${manifest}" ]]; then
    printf '    %s package versions shipped\n' "$(wc -l < "${manifest}")"
    "${REPO_ROOT}/scripts/pkg-versions.sh" "${manifest}"
fi
