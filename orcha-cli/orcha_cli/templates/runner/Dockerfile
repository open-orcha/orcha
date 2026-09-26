# orcha/runner — the sandbox wake image (spec §3.3a). Version-pinned to the CLI minor.
# Runs as a NON-ROOT user: Claude Code hard-refuses --dangerously-skip-permissions
# under root, and least-privilege is the right default anyway. On Linux hosts the
# bind-mounted workspace must be writable by uid 1000 (see docs/sandbox-mode.md);
# Docker Desktop (macOS/Windows) maps ownership transparently.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
        git curl ripgrep python3 python3-venv jq ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# GitHub CLI from the official apt repo (nothing pinned beyond the repo itself).
# Agents use it to open PRs as the app bot; auth is NOT baked into the image —
# the /usr/local/bin/gh wrapper below injects the workspace's rotating token.
RUN mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code @openai/codex \
    && curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh
# Always-fresh gh auth despite hourly token rotation: this POSIX-sh wrapper
# shadows the real /usr/bin/gh via PATH order (/usr/local/bin precedes /usr/bin
# for the non-root runner user) and re-reads
# $ORCHA_WORKSPACE_ROOT/.orcha/github-token (falling back to a $PWD walk-up) on
# EVERY invocation — a long resident session never holds a stale token.
COPY gh /usr/local/bin/gh
RUN chmod 0755 /usr/local/bin/gh
# node:22 ships a "node" user at uid 1000 — rename semantics matter less than the
# uid; reuse it as the runner identity with a real writable HOME.
ENV HOME=/home/node
USER node
# No baked WORKDIR pointing at a mount: the spawner mounts the workspace
# PATH-IDENTICALLY and always passes `-w <real spawn cwd>` (sandbox.py).
WORKDIR /home/node
