# Welcome to LiteAI

This machine boots straight into **pi**, a coding agent, running on a local
Qwen2.5-Coder model served by llama.cpp. There is no desktop: the terminal is
the computer, and pi is the interface.

## First steps

- You are usually talking to pi already. Ask it things: "what hardware is
  this?", "set up a git repo in ~/Projects", "download the 7B model".
- `pi` starts the agent when it is not running (it starts on its own on tty1).
- Wi-Fi: run `nmtui`, or ask pi - it can connect for you.
- `Ctrl+Alt+F2` gives a plain login shell. When pi exits you land in one too;
  start pi again with `pi`.

## Installing to this computer

If you are running from a USB stick or CD, install LiteAI permanently:

```bash
sudo liteai-install
```

The installer copies this exact system to a disk of your choice, so the
installed machine needs no network connection.

## Housekeeping

```bash
sudo pacman -Syu              # update the system
sudo liteai-pi update         # update pi itself
```

## Where things live

| Path | What it is |
| --- | --- |
| `~/.pi/agent/` | pi's configuration, extensions and skills |
| `/etc/liteai/llama.conf` | which model llama-server serves, and its knobs |
| `/var/lib/liteai/models/` | downloaded model files |
| `/opt/llama.cpp/` | llama.cpp itself |

pi can improve this machine and itself - see `~/.pi/agent/AGENTS.md` for the
rules it works under. When pi edits its own configuration, run `/reload`
inside pi to pick the changes up.
