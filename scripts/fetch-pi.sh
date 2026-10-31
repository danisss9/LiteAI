#!/usr/bin/env bash
# Stage pi, the coding agent this machine boots into, inside a rootfs tree -
# a real npm global install aimed at the image's /usr/local, so the shipped
# system has /usr/local/bin/pi working with no network and no node_modules of
# its own to resolve (npm lays out the dependency tree under lib/node_modules).
#
# Usage: scripts/fetch-pi.sh <rootfs-dir> [version]
#
#   version defaults to the pin below; override to track a newer release
#   (the installed machine updates itself the same way, through liteai-pi).
#
# --ignore-scripts here and in liteai-pi alike: the package is pure JavaScript
# and needs no postinstall, and skipped lifecycle scripts are one less
# supply-chain surface on a machine whose whole point is that it can install
# software on its own.

set -Eeuo pipefail

readonly AIROOTFS="${1:?usage: fetch-pi.sh <rootfs-dir> [version]}"
readonly VERSION="${2:-${LITEAI_PI_VERSION:-1.4.0}}"
readonly PACKAGE="@earendil-works/pi-coding-agent"
readonly URL="https://www.npmjs.com/package/${PACKAGE}"

[[ -d "${AIROOTFS}" ]] || { echo "no such directory: ${AIROOTFS}" >&2; exit 1; }
command -v npm >/dev/null || { echo "npm is required on the build host" >&2; exit 1; }

echo "==> installing ${PACKAGE}@${VERSION} into ${AIROOTFS}/usr/local"
npm install --global --prefix "${AIROOTFS}/usr/local" \
    --ignore-scripts --no-audit --no-fund --loglevel=error \
    "${PACKAGE}@${VERSION}"

pi_bin="${AIROOTFS}/usr/local/bin/pi"
[[ -e "${pi_bin}" ]] || { echo "npm did not produce ${pi_bin}" >&2; exit 1; }
# npm makes the bin a symlink into lib/node_modules; a plain file wrapper would
# also be fine, but it must at least be reachable, and root-owned either way.
chown -R 0:0 "${AIROOTFS}/usr/local/lib/node_modules" "${pi_bin}" 2>/dev/null || true
chmod 0755 "${pi_bin}" 2>/dev/null || true

installed_version="$(node -p "require('${AIROOTFS}/usr/local/lib/node_modules/${PACKAGE}/package.json').version" 2>/dev/null || echo unknown)"

install -Dm0644 /dev/stdin "${AIROOTFS}/usr/share/liteai/pi-version" <<EOF
version=${installed_version}
package=${PACKAGE}
source=${URL}
fetched=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

echo "==> staged pi ${installed_version} (${pi_bin})"
