# LiteAI - tty1 bootstrap
#
# tty1 is auto-logged in by systemd; that login starts pi, the coding agent,
# which is the entire interface of this machine. Every other tty behaves like
# a normal login shell, and so does tty1 once pi has exited.

[[ -f ~/.bashrc ]] && . ~/.bashrc

if [[ "${XDG_VTNR:-}" == "1" ]] || [[ "$(tty 2>/dev/null)" == "/dev/tty1" ]]; then

    if ! command -v pi >/dev/null 2>&1; then
        printf '\e[38;5;203mpi is not installed on this system\e[0m - dropping to a shell.\n'
        printf 'It ships in /usr/local/lib/node_modules; see /usr/share/liteai/pi-version.\n\n'
    else
        # llama-server loads its weights at boot and usually answers within a
        # few seconds. Wait politely for it, but never forever: pi is useful
        # even when the model server is down - its LiteAI MCP tools can check
        # the service, read logs and restart it.
        if ! curl --silent --fail --max-time 2 http://127.0.0.1:8080/health >/dev/null 2>&1; then
            printf 'Waiting for the local model server (llama-server)'
            llama_up=0
            for _ in $(seq 1 90); do
                if curl --silent --fail --max-time 2 http://127.0.0.1:8080/health >/dev/null 2>&1; then
                    llama_up=1
                    break
                fi
                printf '.'
                sleep 1
            done
            if (( llama_up )); then
                printf ' up\n'
            else
                printf '\n\e[38;5;214mllama-server did not come up within 90s - pi will start anyway.\e[0m\n'
                printf 'Ask pi to diagnose it, or check:  systemctl status liteai-llama\n\n'
            fi
            unset llama_up
        fi

        pi

        # pi exits here. Hand the tty to a real shell rather than respawning
        # the agent: a crash loop on the only interface of the machine would
        # lock the human out, and 'pi' is one keystroke away anyway.
        printf '\npi has exited. Start it again with:  pi\n'
    fi
fi
