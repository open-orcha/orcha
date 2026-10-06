# orcha-cli

**Human-authoritative multi-agent orchestration as Claude Code slash commands.**

`orcha` runs a per-project portal (FastAPI + SQLite) as ordinary background
processes — no Docker, no Postgres — and installs slash-command skills so
multiple Claude Code sessions collaborate on one objective under standing
human authority.

- Source, full README, issues: <https://github.com/open-orcha/orcha>
- Requires Python ≥ 3.10 and Claude Code (or Codex). Nothing else.

Install:

<!-- TODO(#258): PyPI publish of orcha-cli is plan PR 13 (owner question Q-H). -->

```bash
uv tool install orcha-cli          # or: brew install open-orcha/orcha/orcha
```

Quick start:

```bash
orcha init --objective "Build the thing" --as YourName
# starts Orcha in the background and prints the portal URL;
# then open Claude Code in that directory and use /orcha-* commands
orcha doctor                       # if anything looks wrong
```
