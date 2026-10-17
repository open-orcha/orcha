# Legacy Docker runtime (one release only)

> **Orcha no longer needs Docker or Postgres.** New projects run as ordinary
> background processes with a single SQLite file at `<project>/.orcha/orcha.db`
> — see the [Installation section of the README](../README.md#installation).
>
> This page keeps the Docker-era instructions for **one release** so that
> projects created before the switch keep working until they move. It is
> deleted in the cleanup release (GH #258, plan PR 20).

## Who this page is for

You have a project whose `.orcha/` folder contains `docker-compose.yml` (its
`.claude/orcha.json` has no `"runtime": "native"` entry; only projects with that
entry run natively). That project still runs its Postgres database and web
portal as Docker containers, and keeps doing so — untouched — until you move it.

## Moving a project off Docker

<!-- TODO(#258): `orcha migrate-runtime` lands in plan PR 8; confirm flags with its author before release. -->

```bash
cd ~/projects/your-project
orcha migrate-runtime            # Docker must be running this one time, to read the data out
```

This copies every agent, task, thread and request out of the project's Postgres
into `.orcha/orcha.db`, switches the project to the native runtime and starts
it. The old Docker containers and the `pgdata` volume are **kept** as your
rollback. Nothing deletes them for you; when you are sure you no longer need
them:

```bash
orcha migrate-runtime --purge-docker
```

Until a project is moved, `orcha up` and `orcha update` print that instruction
instead of rebuilding the Docker image.

## Prerequisites (Docker projects only)

| Tool | Why |
|---|---|
| **Docker** (Desktop / OrbStack / Colima) | runs Postgres + the portal |
| **Python ≥ 3.10** | runs the `orcha` CLI |
| **Claude Code** | where the slash commands run |

## Docker stack lifecycle

```bash
# from the project's directory:
orcha up                  # bring the stack up (after orcha down)
orcha down                # stop, KEEP volume (data persists)
orcha down -v             # stop + drop the Postgres volume (re-runs migrations on next up)
orcha status              # show config + `docker compose ps` for THIS project

# from anywhere (no cd required):
orcha ls                                   # list ALL running orcha Docker stacks across
                                           # projects, with their API ports + db ports
orcha down --project <name> [-v]           # stop a specific project's stack from any dir
orcha up   --project <name>                # bring it back up (see caveat below)
```

`<name>` is whatever `orcha ls` shows in the PROJECT column (e.g. `news1`,
`movies`, `orcha-demo`). The CLI prepends `orcha-` internally to match the
actual docker compose project name.

**Caveat — `up --project` only works on stopped (not down-ed) stacks.** `down`
removes containers and breaks the link to the compose file's location, so a
fresh `up` needs the project directory. Use `orcha up` from inside the project
dir to bootstrap after a full `down`.

### Force-kill a stack by port (when you're not in the project dir)

If you've lost track of which directory owns a stack (e.g. an old project on
port 8001 that you can't `cd` to anymore), this one-liner finds the compose
project from the port and tears it down with its volume:

```bash
docker compose -p $(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' $(docker ps -q --filter publish=8001)) down -v
```

Swap `8001` for whichever port is in use. Use this when `orcha down` isn't an
option (no `.orcha/` dir on hand).

## ⚠️ Wiping a Docker project's data

**These erase the project's Postgres data (agents, tasks, runs, threads). NEVER run
them in a project whose state you want to keep** (e.g., a live multi-agent workspace) —
there is no undo.

- **`orcha down -v`** — stops the stack **and drops the `pgdata` volume** → full DB wipe.
  (`orcha down` without `-v` keeps the volume; data survives a plain `up` again.)
- **`orcha init --force`** does **NOT** wipe data. It only overwrites `.orcha/` config +
  recreates the container; it **reuses the existing `pgdata` volume**, so the old DB
  (agents, tasks) **survives**. To truly start fresh you must drop the **volume**.
- **`orcha init --force --reset-data`** **DOES** wipe: it drops this project's Postgres
  volume before starting so the DB comes up empty (the one in-place way to get a
  genuinely pristine re-init without the manual `docker volume rm` dance below).

**Reliable full reset of the *current* project** (only when you really mean it):
```bash
orcha down -v                                  # stop stack + drop the pgdata volume
docker volume ls | grep "$(basename "$PWD")"   # CONFIRM the pgdata volume is gone…
docker volume rm orcha-<project-name>_pgdata   # …if it's still listed, force-remove it
orcha up                                        # brings up a fresh, empty DB
```
The volume is project-scoped: `orcha-<project-name>_pgdata` (project name = the
`name:` in `.orcha/docker-compose.yml`, derived from the directory).

**Tip:** to test a *first-run / empty* experience, don't wipe an existing project —
just `orcha init` in a **brand-new empty directory** (new project name → new volume →
guaranteed clean), and `orcha down -v` that throwaway dir when finished.

## Docker Desktop on macOS — the gotcha that cost us an hour

If you've never installed Docker Desktop before, **install Docker.app into the
system-wide `/Applications/` folder, not `~/Applications` or `~/Downloads`.**
This one detail prevents a cascade of confusing failures.

### Why this matters (the AppTranslocation story)

macOS Gatekeeper sets the `com.apple.quarantine` extended attribute on any app
downloaded from the internet. When you run a quarantined app from **anywhere
other than `/Applications/`** (e.g. `~/Downloads`, `~/Applications`), Gatekeeper
runs it from a read-only translocated copy at:

```
/private/var/folders/.../T/AppTranslocation/<random-uuid>/d/Docker.app
```

**The random UUID changes every launch.** Docker Desktop's first-launch
installer creates symlinks like `/usr/local/bin/docker` →
`<AppTranslocation>/Docker.app/Contents/Resources/bin/docker`. Those symlinks
go stale the moment you quit and relaunch the app.

### Symptoms

- `zsh: command not found: docker` (despite Docker Desktop running)
- `docker compose build` fails with:
  `error getting credentials - err: exec: "docker-credential-desktop": executable file not found in $PATH`
- `ls -la /usr/local/bin/docker` shows a symlink to an
  `AppTranslocation/<uuid>/...` path that doesn't exist anymore

### Fix (one-time)

1. **Quit Docker Desktop** from the menu-bar whale icon → *Quit Docker Desktop*.
2. **Move `Docker.app` into `/Applications/`** (drag in Finder).
3. **Relaunch** from `/Applications/Docker.app`.
4. **Repoint the CLI symlinks** if they're still broken. All five may need it
   — the `docker-credential-*` ones are easy to forget but builds fail without
   them:
   ```bash
   sudo ln -sf /Applications/Docker.app/Contents/Resources/bin/docker                /usr/local/bin/docker
   sudo ln -sf /Applications/Docker.app/Contents/Resources/cli-plugins/docker-compose /usr/local/bin/docker-compose
   sudo ln -sf /Applications/Docker.app/Contents/Resources/bin/docker-credential-desktop     /usr/local/bin/docker-credential-desktop
   sudo ln -sf /Applications/Docker.app/Contents/Resources/bin/docker-credential-osxkeychain /usr/local/bin/docker-credential-osxkeychain
   sudo ln -sf /Applications/Docker.app/Contents/Resources/bin/docker-credential-ecr-login   /usr/local/bin/docker-credential-ecr-login
   ```
5. **Apple Silicon only:** confirm `/usr/local/bin` is on your `$PATH`. The
   default zsh PATH on M-series Macs leans on `/opt/homebrew/bin` and may omit
   `/usr/local/bin`. Add to `~/.zshrc` if missing:
   `export PATH="/usr/local/bin:$PATH"`.
6. Verify: `docker version` shows BOTH Client and Server.

### Diagnostic one-liner

```bash
ls -la /usr/local/bin/docker /usr/local/bin/docker-compose /usr/local/bin/docker-credential-* 2>&1
pgrep -fl "Docker Desktop" | head -1   # confirm it's running from /Applications/
```

A symlink target starting with `/private/var/folders/.../AppTranslocation/` is
the smoking gun.

## Troubleshooting (Docker projects)

| Symptom | Cause | Fix |
|---|---|---|
| `command not found: docker` | broken AppTranslocation symlinks | move Docker.app to `/Applications/`, repoint symlinks |
| `error getting credentials: docker-credential-desktop ... not found` | `docker-credential-*` symlinks stale | repoint all three cred-helper symlinks |
| `orcha init` says "no free port in range" | host ports 8000..8099 / 5432..5531 all in use | `--api-port` / `--db-port` to pick explicitly |
| `Bind for 0.0.0.0:5432 failed` | a host Postgres is bound there | `orcha init` should auto-skip; if not, `--db-port 5433` |
| `psycopg.OperationalError: connection refused` from a skill | stack down or wrong port | `orcha status`; `orcha up` |
| Edited `001_init.sql` template, schema didn't change in a live project | `initdb.d` only runs on first boot | `orcha down -v && orcha up` |
