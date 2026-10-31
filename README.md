# LiteAI

A minimal Arch Linux system that boots straight into [pi](https://pi.dev), the
coding agent, running on a **local** Qwen2.5-Coder model served by llama.cpp.

There is no desktop and no GUI. The machine boots, logs in on tty1, waits a
few seconds for the model server to load its weights, and puts pi on screen -
and that is the whole system. The terminal is the computer, and pi is the
interface.

```
systemd → autologin on tty1 → .bash_profile → wait for llama-server → pi
                                                      ↑
                                    llama-server (127.0.0.1:8080, baked model)
```

pi is preconfigured to talk to that local server through an OpenAI-compatible
endpoint (`~/.pi/agent/models.json`), so the machine is fully functional with
no internet connection: it thinks with the model it shipped with.

## What makes it different

pi is not just installed on this machine - it can *run* it. A bundled MCP
server (`/usr/share/liteai/mcp/server.cjs`, wired up in `~/.pi/agent/mcp.json`)
exposes the machine to the model as twenty-four tools:

- **llama.cpp and its models** - status, restart, configuration, and the model
  library in `/var/lib/liteai/models`: list it, download a bigger model from
  Hugging Face, switch the served model, remove old ones.
- **pi itself** - read and rewrite `models.json`, `mcp.json`, `settings.json`
  and `AGENTS.md`, and create, edit and delete pi's own extensions and skills
  (pi picks the changes up when you run `/reload`).
- **the base system** - hardware and memory summary, Wi-Fi scan and connect,
  power off / reboot / suspend, service status, journal logs, pacman queries
  and full system updates.

Read-only tools are annotated as such; anything destructive goes through pi's
permission flow and asks the human first. So "improve yourself" is a normal
request here: ask pi to download Qwen2.5-Coder-7B, switch to it, tune its own
system prompt, write itself a new skill - then run `/reload` and talk to the
result.

## What is inside

- **Arch Linux** (x86_64) or **Arch Linux ARM** (Raspberry Pi), trimmed to a
  console system: no Xorg, no desktop, no fonts, no audio stack.
- **llama.cpp** - a pinned, prebuilt upstream CPU binary in `/opt/llama.cpp`,
  run by `liteai-llama.service` on `127.0.0.1:8080` with the model's own chat
  template (`--jinja`), which is what gives pi tool calling on Qwen. The x86_64
  CUDA ISO ships the same llama.cpp, compiled from the same pin with CUDA
  enabled instead (see below).
- **Qwen2.5-Coder-1.5B-Instruct, q4_k_m** (~1.1 GB) baked into the image at
  `/var/lib/liteai/models/`. Small enough to bake and to run in ~1.5 GB of
  RAM; the first thing pi can do for you is download a better one.
- **pi** (`@earendil-works/pi-coding-agent`), staged as an npm global install
  with its configuration preseeded in `/etc/skel/.pi/agent/`.
- **the LiteAI MCP server**, a single-file bundle with no runtime dependencies,
  plus four fixed-argument privileged helpers - `liteai-llama`, `liteai-models`,
  `liteai-pi`, `liteai-update` - that polkit grants to the session without a
  password, each validating a fixed vocabulary of arguments and never accepting
  a command line.
- Developer tools: git, nodejs/npm, base-devel, cmake, python, ripgrep, fd,
  htop, fastfetch, vim/nano. Go, Rust and the JDK are one `pacman -S` away.

## The three images

| Artifact | For | Boot |
| --- | --- | --- |
| `LiteAI-<version>-x86_64.iso` | PCs (UEFI x64/ia32, legacy BIOS) | live medium; `sudo liteai-install` puts the same system on a disk, offline |
| `LiteAI-<version>-x86_64-cuda.iso` | PCs with an NVIDIA Turing (2016) or newer GPU | same live/install medium, plus the NVIDIA driver and a CUDA llama.cpp |
| `LiteAI-<version>-aarch64-rpi.img.xz` | Raspberry Pi 5/4/400/CM4/3/Zero 2 W | the flashed card *is* the system; rootfs expands on first boot |

All three bake the same model and ship the same AI stack. The standard ISO
and the compressed Pi image come in just under GitHub's 2 GiB per-file
release-asset limit - the firmware subpackage list is trimmed to make room
for the model - so both attach to the release directly. The Pi image unpacks
to 8 GiB: use a 16 GB card or larger.

### The CUDA variant

The CUDA ISO is the standard image plus `nvidia-open` (the open kernel
modules built for the stock `linux` kernel), `nvidia-utils` and
`linux-firmware-nvidia`, with llama.cpp compiled from the same pinned source
with `-DGGML_CUDA=ON` for sm_75 through sm_120 (Turing GTX 16xx/RTX 20xx up
through RTX 50xx) plus a compute_90 PTX image the driver JIT-compiles for
newer hardware. `EXTRA_ARGS` in `/etc/liteai/llama.conf` defaults to
`-ngl 99`, so the model runs on the GPU out of the box; on a machine without
a supported NVIDIA GPU the same binary falls back to CPU and the flag is
ignored.

Three things to know:

- It is large (~3 GiB) and therefore over GitHub's release-asset cap: it
  ships as a workflow artifact - Actions -> Build images -> the build run ->
  Artifacts - rather than as a release download.
- The display-only part of `nvidia-utils` (GLX/EGL/Vulkan, NVENC/NVDEC, the
  Xorg module, OptiX, the DLSS/Proton shims) is trimmed at build time; a
  console-only image has no consumer for it. Everything the driver and CUDA
  need - `libcuda`, NVML, the PTX JIT compiler, GSP firmware, `nvidia-smi` -
  ships.
- Secure Boot must be disabled (or the module enrolled): the NVIDIA kernel
  module is not signed for your machine's keys.

Default credentials: the PC live medium autologins as `liteai` with no
password (root is likewise passwordless, like the official Arch medium) and
the installer tightens sudo on the installed system. The Pi image logs in as
`liteai` / `liteai` - change it with `passwd`.

## Using the machine

Boot it and pi starts on its own. Useful things to know:

- When pi exits (or crashes), you land in a normal shell; `pi` starts it
  again. Ctrl+Alt+F2 gives a second, plain login shell. This is deliberate:
  the agent respawning itself in a loop on the only interface would lock the
  human out.
- If the model server is slow to come up, the boot waits up to 90 s and then
  starts pi anyway - pi can diagnose its own backend (`systemctl status
  liteai-llama`, journal logs) through the MCP tools.
- Wi-Fi: `nmtui`, or ask pi (`wifi_connect`).
- The knobs live in `/etc/liteai/llama.conf` (model file, alias, context
  size, threads, extra llama-server flags). Change them with
  `pkexec liteai-llama set KEY VALUE` - or just ask pi.

### Getting a better model

This is the intended rite of passage, and pi can do every step:

```text
you:  download Qwen/Qwen2.5-Coder-7B-Instruct-GGUF
      qwen2.5-coder-7b-instruct-q4_k_m.gguf, then switch to it
```

pi runs `model_download` (4.7 GB), `model_default` (which rewrites
`llama.conf` and restarts llama-server), updates its own `models.json`
through `pi_config_set`, and asks you to run `/model`. A 7B q4 model wants
about 6 GB of free memory - `system_info` checks that first. The 1.5B baked
model stays in the library as a fallback; `model_remove` refuses to delete
whatever is currently being served.

### Improving pi itself

pi's configuration, extensions and skills live in `~/.pi/agent/`, and the
`pi_config_*` / `pi_extension_*` tools let the model edit them with path
scoping, size caps and JSON validation. After any change, run `/reload`
inside pi (pi asks you to). `AGENTS.md` ships with the house rules - what
pi may do unasked, what needs a human, and how to upgrade the model - and
is itself one of the files pi can rewrite.

## Rebuilding llama.cpp with GPU support

The CPU and RPi images ship the upstream CPU build. On a machine with a
proper GPU, rebuild from source in the image - which is why `base-devel`,
`cmake` and `python` are in the package set:

```bash
sudo pacman -S ninja opencl-clhpp clblast   # or the cuda/rocm equivalents
git clone https://github.com/ggml-org/llama.cpp /tmp/llama.cpp
cmake -S /tmp/llama.cpp -B /tmp/llama.cpp/build -DGGML_CUDA=ON
cmake --build /tmp/llama.cpp/build --config Release -j$(nproc)
sudo cp /tmp/llama.cpp/build/bin/llama-* /opt/llama.cpp/bin/
sudo systemctl restart liteai-llama
```

(The x86_64 CUDA ISO already ships exactly this build, made at image-build
time by `scripts/build-llamacpp-cuda.sh`.)

## Building the images

The x86_64 ISO builds in an Arch container; the Pi image builds on an aarch64
host (or x86_64 with qemu binfmt). Locally:

```bash
# x86_64 ISO (needs root, archiso, grub)
sudo ./scripts/build-iso.sh -v 2026.10.31 -o out -w work

# x86_64 CUDA ISO - same container plus the CUDA toolkit, which the build
# script installs and removes itself (~1 h: seven CUDA architectures)
sudo ./scripts/build-iso.sh --variant cuda -v 2026.10.31 -o out -w work

# Raspberry Pi (needs root, aarch64 or binfmt)
sudo ./rpi/build-image.sh -v 2026.10.31 -o out -w work-rpi
```

CI builds all three on tags (`git tag v2026.10.31 && git push --tags`). The
pieces each build stages: `fetch-llamacpp.sh` (pinned upstream llama.cpp
build; the CUDA variant runs `build-llamacpp-cuda.sh` instead, compiling the
same pin from source), `fetch-model.sh` (the baked GGUF, cacheable),
`fetch-pi.sh` (pinned pi release) and `build-mcp.sh` (the MCP server, built
and unit-tested once and shared by all targets).

## Repository layout

```
archiso/            x86_64 live/install medium (archiso profile)
  packages-cuda.x86_64    extra packages for the CUDA variant
  airootfs-cuda/    CUDA-variant overlay (module loading, loader path)
  airootfs/usr/local/bin/liteai-install   the offline installer
rootfs-common/      everything both images share: AI stack plumbing,
                    systemd units, polkit rules, pkexec helpers, /etc/skel
mcp/                the LiteAI MCP server (TypeScript, esbuild-bundled)
rpi/                Raspberry Pi image builder, boot files, overlay
scripts/            build + fetch scripts
.github/workflows/  CI: mcp job, three image jobs, release
```

## Details worth knowing if you are modifying it

- The kiosk-era security model survives intact: polkit grants `pkexec` for
  exactly four root-owned, unwritable-by-user scripts (`49-liteai.rules` +
  `profiledef.sh` file_permissions), each taking a fixed vocabulary. The MCP
  server is just a convenience layer over them; every helper re-validates on
  the root side.
- The systemd `.wants` entries in this tree are plain files containing their
  target path, because the repo is edited on filesystems without symlinks.
  Both build scripts rebuild them as real symlinks (and enable
  `liteai-llama.service` themselves), so a checkout on Windows cannot silently
  produce an image with no services enabled.
- The `.pi/agent` preseed in `/etc/skel` is materialised into `/home/liteai`
  at build time and copied for the Pi's `useradd`. Changing `models.json` or
  `AGENTS.md` upstream means changing the skel copies.
- The MCP server bundle is self-contained (SDK + zod compiled in, ~750 KB);
  the image never ships node_modules. Its tool names appear to pi as
  `mcp__liteai__<tool>`.
- Nothing pins an Arch package version - the rolling release is the point -
  but llama.cpp (`LITEAI_LLAMACPP_BUILD`), pi (`LITEAI_PI_VERSION`) and the
  model (`LITEAI_MODEL_REPO`/`LITEAI_MODEL_FILE`) are pinned in their fetch
  scripts and recorded in `/usr/share/liteai/*-version` inside the image.
- The CUDA ISO trims `nvidia-utils` with `NoExtract` lines injected into the
  staged pacman.conf (a console box has no Xorg/Vulkan/NVENC consumer), and
  `build-llamacpp-cuda.sh --verify` re-checks the finished rootfs after
  mkarchiso: every `/opt/llama.cpp` dependency must resolve against the
  image, and the driver files and GSP firmware must be present.
- Recovery: GRUB keeps a recovery entry (PC), serial console is enabled on
  the Pi, and every non-tty1 login is a plain shell. `systemd.unit=
  multi-user.target` at the boot prompt boots without starting pi.

## License

MIT - see [LICENSE](LICENSE).
