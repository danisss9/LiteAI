#!/usr/bin/env bash
# shellcheck disable=SC2034

iso_name="liteai"
iso_label="LITEAI_$(date +%Y%m)"
iso_publisher="LiteAI <https://github.com/danisss9/LiteAI>"
iso_application="LiteAI Live/Install Medium"
iso_version="${ISO_VERSION:-$(date +%Y.%m.%d)}"
install_dir="arch"
buildmodes=('iso')
# archiso 86 folded the old '<mode>.esp'/'<mode>.eltorito' pairs into one name
# per boot loader; the split spellings still work but warn on every build.
# 'uefi.grub' writes GRUB to both an ESP and an El Torito image, and on x86_64
# it emits the ia32 binary as well, so 32-bit UEFI firmware still boots.
bootmodes=('bios.syslinux' 'uefi.grub')
arch="x86_64"
pacman_conf="pacman.conf"
airootfs_image_type="squashfs"
airootfs_image_tool_options=('-comp' 'xz' '-Xbcj' 'x86' '-b' '1M' '-Xdict-size' '1M')
bootstrap_tarball_compression=('zstd' '-c' '-T0' '--auto-threads=logical' '--long' '-19')
# build-iso.sh appends an entry for every executable in the staged airootfs.
file_permissions=(
  ["/etc/gshadow"]="0:0:0400"
  ["/etc/shadow"]="0:0:0400"
  ["/root"]="0:0:750"
  ["/usr/local/bin/liteai-install"]="0:0:755"
  # These four are load-bearing for security, not just for tidiness: polkit
  # grants `pkexec` on each of them without a password, so a copy the liteai
  # user could write to would be a one-line path to root.
  ["/usr/local/bin/liteai-llama"]="0:0:755"
  ["/usr/local/bin/liteai-models"]="0:0:755"
  ["/usr/local/bin/liteai-pi"]="0:0:755"
  ["/usr/local/bin/liteai-update"]="0:0:755"
  ["/etc/sudoers.d/liteai"]="0:0:0440"
)
