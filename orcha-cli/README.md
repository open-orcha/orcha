# orcha-cli

**Human-authoritative multi-agent orchestration as Claude Code slash commands.**

`orcha` bootstraps a per-project Docker stack (Postgres + FastAPI portal) and
installs slash-command skills so multiple Claude Code sessions collaborate on
one objective under standing human authority.

- Source, full README, issues: <https://github.com/open-orcha/orcha>
- Requires Docker Desktop (or OrbStack/Colima).

Quick start:

```bash
orcha init --objective "Build the thing" --as YourName
# then open Claude Code in that directory and use /orcha-* commands
```
