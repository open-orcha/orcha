# Notifier autostart — wakes survive reboots without hand-starting

The wake notifier is a host-side daemon (`orcha notifier`) anchored to a project
checkout. It has always been *ensured* idempotently by `orcha init`, `orcha up`, and
the Claude Code SessionStart hook (`orcha notifier --ensure`) — but nothing covered
the case where **no interactive session is open**: after a laptop reboot, or after
`orcha up --project <name>` restarted a stopped stack from another directory, wakes
were dead until someone typed `orcha notifier --ensure` by hand.

Two mechanisms close that gap. Nothing is required from the user.

## 1. `orcha up` — both paths ensure the daemon

`orcha up` in the project directory has ensured the daemon for a while. Now
`orcha up --project <name>` (run from anywhere) does too: the project checkout is
recovered from the compose containers' `com.docker.compose.project.working_dir`
label, and the notifier + terminal bridge are ensured there. Symmetrically,
`orcha down --project <name>` stops that project's daemon and bridge.

## 2. macOS: a launchd LaunchAgent watchdog (reboot persistence)

Whenever `ensure_daemon` succeeds, the CLI idempotently installs a per-container
LaunchAgent:

```
~/Library/LaunchAgents/io.openorcha.notifier.<container_id>.plist
```

- **What it runs:** the same idempotent `orcha notifier --ensure --quiet`, with
  `WorkingDirectory` set to the project checkout.
- **When:** at login (`RunAtLoad`) and every 60 seconds (`StartInterval`) — so a
  daemon that dies is respawned within a minute, and a fresh login/reboot brings
  it up without any session.
- **Why a watchdog, not `KeepAlive` on the daemon itself:** the ensure path already
  owns the single-instance machinery (per-checkout pidfile + container-global
  claim); handing launchd a foreground daemon to supervise would create a second,
  competing supervisor, and `KeepAlive` on a fast-exiting job makes launchd
  throttle-loop. The cron-style watchdog reuses the guarded path instead.
- **Lifecycle:** installed on every successful ensure (init / up / SessionStart
  hook / manual `--ensure`); removed by `orcha notifier --stop` and `orcha down`
  — an explicit stop stays stopped instead of being resurrected 60s later — and
  when a daemon's container turns out to be deleted (404).
- **Multi-worktree projects:** the agent is keyed by container id. An ensure from
  a second checkout of the same container does not steal the agent while the
  recorded checkout is still valid; if that checkout goes away, the next ensure
  from a live one rewrites and reloads the agent (self-healing).
- **Watchdog log:** `<project>/.claude/.orcha-notifier-autostart.log` (the daemon
  proper still logs to `.claude/.orcha-notifier.log`).

### Opting out

Set `ORCHA_NO_AUTOSTART=1` (in the environment of whatever runs `orcha up` /
`--ensure`) to skip installing the agent. To remove an already-installed one:

```bash
orcha notifier --stop        # unloads + deletes the LaunchAgent, stops the daemon
# or by hand:
launchctl bootout gui/$(id -u)/io.openorcha.notifier.<container_id>
rm ~/Library/LaunchAgents/io.openorcha.notifier.<container_id>.plist
```

## Linux

There is no launchd; the LaunchAgent step is a no-op. `orcha up` and the
SessionStart hook still ensure the daemon at runtime. For reboot parity, install a
systemd **user** unit (survives logout with `loginctl enable-linger $USER`):

```ini
# ~/.config/systemd/user/orcha-notifier@.service
[Unit]
Description=Orcha wake-notifier watchdog (%i)

[Service]
Type=oneshot
WorkingDirectory=/path/to/your/project
ExecStart=/usr/local/bin/orcha notifier --ensure --quiet
```

```ini
# ~/.config/systemd/user/orcha-notifier@.timer
[Unit]
Description=Run the Orcha notifier watchdog every minute

[Timer]
OnBootSec=30
OnUnitActiveSec=60

[Install]
WantedBy=timers.target
```

```bash
systemctl --user enable --now orcha-notifier@myproject.timer
```
