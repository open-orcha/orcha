# orcha-cli/orcha_cli/sandbox.py
"""Sandbox wake execution — spec docs/superpowers/specs/2026-07-29-orcha-cloud-remote-runner-design.md.

Pure functions that translate a headless wake's argv/env into `docker run`.
The notifier keeps its Popen contract untouched: the foreground `docker run`
client lives as long as the container and exits with its exit code.

HARD RULE (spec §3.2): if Docker is unavailable the wake FAILS with a visible
reason. There is no fallback to a host process.
"""
from __future__ import annotations

import datetime
import json
import os
import pathlib
import re
import shutil
import subprocess
import uuid
from dataclasses import dataclass
from typing import Optional, Sequence

DEFAULT_IMAGE = "orcha/runner:0.5"
DEFAULT_MEMORY = "4g"
DEFAULT_CPUS = "2"
DEFAULT_PIDS = 512
DEFAULT_MAX_RUNTIME_SECS = 7200
MIN_FREE_DISK_GB = 5
LABEL_MANAGED = "orcha.managed=1"
# Task-5 REQUIREMENT (plan "Tracked follow-ups"): a drain sidecar's sandbox
# container carries this label. Sidecars own NO worker_runs row by design
# (Kedar-locked no-lease invariant), so the reaper's orphan pass must be able
# to tell them apart from a genuinely orphaned run container.
LABEL_SIDECAR = "orcha.sidecar=1"
# C1 (Task-5 review): the PROJECT-identity label key. Every sandbox spawn stamps
# `orcha.cid=<current_container_id>` so a host running several orcha stacks (the
# dev machine runs two!) never lets one daemon's orphan pass stop another
# project's live run containers — managed_containers() filters on it server-side.
LABEL_CID_KEY = "orcha.cid"

# Session-persistence (sandbox continuity fix): the agent CLI's state dir
# (`~/.claude` inside the container — session transcripts, hook state) was
# ephemeral, dying with each container. A resident conversation pinned a
# session id, the next container had no ~/.claude, and every `--resume` failed
# with "No conversation found with session ID: …". Persist it per WORKSPACE on
# the host and bind-mount it into every sandboxed wake. Runner user is `node`
# uid 1000 (Dockerfile `USER node`, HOME=/home/node).
AGENT_HOME_CONTAINER = "/home/node/.claude"
RUNNER_UID = 1000
RUNNER_GID = 1000

# Secrets and identity ride the CLIENT env (docker inherits `-e KEY` values from
# the client process), never argv — `ps` must not show tokens (spec §3.5).
ENV_PASSTHROUGH = (
    "ORCHA_ALIAS", "ORCHA_RUN_TOKEN", "ORCHA_AGENT_RUNTIME",
    "ORCHA_HEADLESS_WORKER", "ORCHA_CONVERSATION_WORKER",
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ORCHA_LLM_API_KEY",
    # Subscription (BYOC) auth: a `claude setup-token` long-lived OAuth token
    # reaches the container exactly like an API key does.
    "CLAUDE_CODE_OAUTH_TOKEN",
)


def _int_field(raw: dict, key: str, default: int) -> int:
    try:
        return int(raw.get(key, default))
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class SandboxConfig:
    enabled: bool = False
    image: str = DEFAULT_IMAGE
    memory: str = DEFAULT_MEMORY
    cpus: str = DEFAULT_CPUS
    pids_limit: int = DEFAULT_PIDS
    network: Optional[str] = None            # explicit override; else derived
    max_runtime_secs: int = DEFAULT_MAX_RUNTIME_SECS

    @staticmethod
    def load(project_dir: str | pathlib.Path) -> "SandboxConfig":
        cfg_path = pathlib.Path(project_dir) / ".claude" / "orcha.json"
        try:
            raw = json.loads(cfg_path.read_text()).get("sandbox") or {}
        except (OSError, ValueError, AttributeError):
            return SandboxConfig()
        if not isinstance(raw, dict):
            return SandboxConfig()
        image = str(raw.get("image", DEFAULT_IMAGE))
        if image.startswith("-"):
            # A leading-dash "image" would be parsed as a docker CLI flag —
            # argument injection from a repo-supplied orcha.json. Ignore it.
            image = DEFAULT_IMAGE
        return SandboxConfig(
            enabled=bool(raw.get("enabled", False)),
            image=image,
            memory=str(raw.get("memory", DEFAULT_MEMORY)),
            cpus=str(raw.get("cpus", DEFAULT_CPUS)),
            pids_limit=_int_field(raw, "pids_limit", DEFAULT_PIDS),
            network=str(raw["network"]) if raw.get("network") else None,
            max_runtime_secs=_int_field(raw, "max_runtime_secs", DEFAULT_MAX_RUNTIME_SECS),
        )


def compose_network(project_dir: str | pathlib.Path) -> Optional[str]:
    """The stack's default network: `<compose name>_default`, read from the
    `name:` line of .orcha/docker-compose.yml (rendered by `orcha init`)."""
    f = pathlib.Path(project_dir) / ".orcha" / "docker-compose.yml"
    try:
        for line in f.read_text().splitlines():
            if line.startswith("name:"):
                return line.split(":", 1)[1].strip() + "_default"
    except OSError:
        pass
    return None


def new_container_name() -> str:
    return "orcha-run-" + uuid.uuid4().hex[:12]


def write_api_config(project_dir: str | pathlib.Path, name: str) -> str:
    """A sandbox-scoped copy of .claude/orcha.json with api_base_url rewritten
    to the in-network portal address. Bind-mounted read-only OVER the workspace
    copy so skills inside the container reach the portal without mutating any
    shared file (the host copy points at the host-published localhost port,
    which is unreachable from inside a container — spec §3.3b)."""
    project_dir = pathlib.Path(project_dir)
    cfg = json.loads((project_dir / ".claude" / "orcha.json").read_text())
    cfg["api_base_url"] = "http://portal:8000"
    out_dir = project_dir / ".orcha" / "sandbox"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{name}.json"
    out.write_text(json.dumps(cfg, indent=2))
    return str(out)


_GITDIR_POINTER_RE = re.compile(r"^gitdir:\s*(.+?)\s*$", re.M)


def workspace_root_for(cwd: str | pathlib.Path) -> pathlib.Path:
    """The workspace ROOT a sandboxed wake must mount PATH-IDENTICALLY.

    A resident/task wake's cwd is usually a git WORKTREE under
    `<root>/.orcha-worktrees/<slug>` whose `.git` is a POINTER FILE
    (`gitdir: <root>/.git/worktrees/<slug>`, host-absolute). Mounting only the
    worktree — or remapping it to a different container path — leaves that
    pointer dangling inside the container: ALL git dead, and the root's
    `.orcha/github-token` invisible. Resolve the pointer's main checkout and
    mount THAT at its real path; the worktree rides along inside it. A normal
    checkout (`.git` is a dir) or a non-git dir is its own root."""
    cwd = pathlib.Path(cwd)
    gitfile = cwd / ".git"
    try:
        if gitfile.is_file():
            m = _GITDIR_POINTER_RE.search(gitfile.read_text())
            if m:
                gitdir = pathlib.Path(m.group(1))
                if not gitdir.is_absolute():
                    gitdir = (cwd / gitdir).resolve()
                # <root>/.git/worktrees/<name> → <root>
                if gitdir.parent.parent.name == ".git":
                    return gitdir.parent.parent.parent
    except OSError:
        pass
    return cwd


def agent_home_dir(workspace: str | pathlib.Path) -> pathlib.Path:
    """Host-side home for the container's `~/.claude` — durable per workspace
    ROOT (worktree wakes share the root's home: same conversation continuity)."""
    return pathlib.Path(workspace) / ".orcha" / "agent-home"


def ensure_agent_home(workspace: str | pathlib.Path) -> str:
    """Create the agent-home dir BEFORE `docker run` mounts it — docker creates a
    missing bind-mount source ROOT-owned, and the non-root runner (uid 1000)
    could then never write its session state, silently re-breaking resumes.

    mkdir failure PROPAGATES (OSError) — same convention as write_api_config:
    the caller fails the wake loudly, never silently skips the mount. The chown
    to the runner uid is best-effort and never raises (it fails EPERM for
    non-root callers on Linux; Docker Desktop maps ownership transparently and
    the BYOC provisioner chowns the whole workspace anyway)."""
    path = agent_home_dir(workspace)
    path.mkdir(parents=True, exist_ok=True)
    try:
        os.chown(path, RUNNER_UID, RUNNER_GID)
    except OSError:
        pass
    return str(path)


def build_docker_argv(inner_argv: "Sequence[str]", *, cfg: SandboxConfig, name: str,
                      workspace: str, network: Optional[str],
                      api_config_mount: str,
                      extra_labels: "Sequence[str]" = (),
                      interactive: bool = False,
                      workdir: Optional[str] = None) -> "list[str]":
    """PATH-IDENTICAL mounting: `workspace` (the ROOT — see workspace_root_for)
    is mounted at its own host path and `-w` is the actual spawn cwd
    (`workdir`, default = root). This keeps git-worktree `.git` pointer files,
    the credential helper, and `.orcha/github-token` paths valid inside the
    container — the old `/workspace` remap broke all three for worktree wakes.
    The container also gets ORCHA_WORKSPACE_ROOT=<root> so the gh wrapper and
    credential helper resolve the token file without hardcoded paths."""
    workdir = str(workdir or workspace)
    argv = ["docker", "run"]
    if interactive:
        # Resident lane: `docker run -i` keeps the CLIENT's stdin piped through to
        # the container, so the notifier's stdin=PIPE Popen contract (the warm
        # stream-json turn feed) survives the docker wrap unchanged. One-shot
        # wakes never pass it (their stdin is DEVNULL).
        argv.append("-i")
    argv += [
        "--name", name,
        "--label", LABEL_MANAGED,
        "--label", f"orcha.container_name={name}",
    ]
    # e.g. LABEL_SIDECAR for a drain sidecar — the reaper's orphan exemption.
    for label in extra_labels:
        argv += ["--label", label]
    argv += [
        "--memory", cfg.memory,
        "--cpus", cfg.cpus,
        "--pids-limit", str(cfg.pids_limit),
        # The workspace ROOT, path-identical (host path == container path).
        "-v", f"{workspace}:{workspace}",
        # The api-base override masks the config the agent actually READS —
        # skills resolve `.claude/orcha.json` relative to their CWD.
        "-v", f"{api_config_mount}:{workdir}/.claude/orcha.json:ro",
    ]
    if workdir != str(workspace):
        # Worktree spawn: ALSO mask the root's copy (the root is visible under
        # path-identical mounting, and its api_base_url points at a host port
        # unreachable from inside the container).
        argv += ["-v", f"{api_config_mount}:{workspace}/.claude/orcha.json:ro"]
        if not pathlib.PurePath(workdir).is_relative_to(workspace):
            # Defensive: a spawn cwd OUTSIDE the root (not the current layout —
            # worktrees live under <root>/.orcha-worktrees) still resolves.
            argv += ["-v", f"{workdir}:{workdir}"]
    argv += [
        # Durable agent home: session transcripts (`--resume`), hook state, and
        # cross-wake context survive the container. One-shot wakes share it per
        # workspace by design — harmless, and hook/session state accretes.
        "-v", f"{agent_home_dir(workspace)}:{AGENT_HOME_CONTAINER}",
        "-w", workdir,
        # Not a secret — ride argv (unlike ENV_PASSTHROUGH's client-env keys).
        "-e", f"ORCHA_WORKSPACE_ROOT={workspace}",
    ]
    if network:
        argv += ["--network", network]
    for key in ENV_PASSTHROUGH:
        argv += ["-e", key]
    argv.append(cfg.image)
    argv.extend(inner_argv)
    return argv


def _free_disk_gb(path: str | pathlib.Path) -> float:
    try:
        usage = shutil.disk_usage(str(path))
    except OSError:
        # A vanished/unstatable workspace reads as 0 GiB free → the preflight
        # disk check fails loudly, which is the correct contract.
        return 0.0
    return usage.free / (1024 ** 3)


def _docker(args: list[str], timeout: int = 10) -> subprocess.CompletedProcess:
    """Run a docker CLI command; a hung daemon yields a FAILED result, never an
    exception — so `preflight` can only ever return a reason string."""
    try:
        return subprocess.run(["docker", *args], capture_output=True, text=True,
                              timeout=timeout)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(args=["docker", *args], returncode=124,
                                           stdout="", stderr="timed out")
    except OSError as e:
        # docker binary missing/unexecutable. The reaper helpers below (probe /
        # stop / remove / managed_containers) run OUTSIDE preflight's which()
        # guard — every daemon tick, host-mode machines included — and must
        # observe "nothing", never raise.
        return subprocess.CompletedProcess(args=["docker", *args], returncode=127,
                                           stdout="", stderr=str(e))


def preflight(cfg: SandboxConfig, workspace: str) -> Optional[str]:
    """None = good to spawn; otherwise a human-readable reason. The caller
    MUST fail the wake on a reason — de-sandboxing is never an error path."""
    if shutil.which("docker") is None:
        return "docker CLI not installed on this host"
    info = _docker(["info", "--format", "{{.ServerVersion}}"])
    if info.returncode != 0:
        return f"docker daemon unreachable: {(info.stderr or '').strip()[:200]}"
    img = _docker(["image", "inspect", cfg.image, "--format", "ok"], timeout=15)
    if img.returncode == 124:
        # Tracked follow-up (Task 3 review): a HUNG daemon on image inspect is
        # not a missing image — `docker pull` advice would be actively wrong.
        return "docker daemon not responding (image inspect timed out)"
    if img.returncode != 0:
        return (f"runner image {cfg.image} not present — "
                f"run `docker pull {cfg.image}` (or `orcha sandbox build-image`)")
    if _free_disk_gb(workspace) < MIN_FREE_DISK_GB:
        return (f"insufficient disk: less than {MIN_FREE_DISK_GB} GiB free "
                f"on the workspace volume")
    return None


# ---------- Task 5: the reaper's sweep helpers (spec §3.3c + §3.5) ----------
# Containers run detached and OUTLIVE the daemon's Popen handle; these helpers
# are the notifier sweep's only view of them. None of them ever raises — a
# docker hiccup on one container must never abort the sweep for the rest.


@dataclass(frozen=True)
class SandboxState:
    running: bool
    exit_code: Optional[int]
    oom_killed: bool
    started_at: Optional[str]        # RFC3339 from docker inspect


def probe(name: str) -> Optional[SandboxState]:
    """State of one managed container; None if docker errors or it's gone."""
    out = _docker(["inspect", name], timeout=10)
    if out.returncode != 0:
        return None
    try:
        state = json.loads(out.stdout)[0]["State"]
    except (ValueError, KeyError, IndexError, TypeError):
        return None
    if not isinstance(state, dict):
        return None
    return SandboxState(
        running=state.get("Status") == "running",
        exit_code=None if state.get("Status") == "running" else state.get("ExitCode"),
        oom_killed=bool(state.get("OOMKilled")),
        started_at=state.get("StartedAt"),
    )


def _parse_started_at(ts: str) -> Optional[datetime.datetime]:
    """RFC3339 from docker inspect → aware datetime, or None. I3 (Task-5 review):
    docker emits NANOSECOND fractions (9 digits, e.g. .123456789Z); Python ≤3.10's
    fromisoformat accepts only 3/6 digits, so the deadline would silently never
    fire — truncate the fraction to microseconds before parsing."""
    ts = ts.replace("Z", "+00:00")
    m = re.match(r"^(.*T\d{2}:\d{2}:\d{2})\.(\d+)(.*)$", ts)
    if m:
        ts = f"{m.group(1)}.{m.group(2)[:6]}{m.group(3)}"
    try:
        parsed = datetime.datetime.fromisoformat(ts)
    except ValueError:
        return None
    if parsed.tzinfo is None:                    # offset-less input → assume UTC
        parsed = parsed.replace(tzinfo=datetime.timezone.utc)
    return parsed


def past_deadline(state: Optional[SandboxState], *, max_runtime_secs: int) -> bool:
    """Runaway check (spec §3.5): a RUNNING container older than the workspace's
    max-runtime deadline. Exited/gone/unparseable states are never past-deadline
    (there is nothing left to stop)."""
    if state is None or not state.running or not state.started_at:
        return False
    started = _parse_started_at(state.started_at)
    if started is None:
        return False
    age = (datetime.datetime.now(datetime.timezone.utc) - started).total_seconds()
    return age > max_runtime_secs


def stop(name: str) -> None:
    _docker(["stop", "--time", "20", name], timeout=40)


def remove(name: str, force: bool = False) -> None:
    # NEVER pass -v: workspace volumes are durable state (spec §3.5).
    # `force` → `docker rm -f` (SIGKILL + rm): for callers whose container may
    # still be RUNNING with nothing left to preserve — a killed drain sidecar is
    # row-less AND orphan-exempt, so a plain rm failing there would leak an
    # immortal running container that nothing else ever stops. Only safe
    # post-stamp or for row-less sidecars; the sweep's exited path stays plain.
    _docker(["rm", "-f", name] if force else ["rm", name], timeout=15)


def remove_api_config(project_dir: str | pathlib.Path, name: str) -> None:
    """Reap the per-run api-config file write_api_config left behind (plan
    follow-up: one .orcha/sandbox/<name>.json per wake accretes forever)."""
    try:
        (pathlib.Path(project_dir) / ".orcha" / "sandbox" / f"{name}.json").unlink(missing_ok=True)
    except OSError:
        pass


def daemon_reachable() -> bool:
    """C2 (Task-5 review): the sweep's per-tick docker-daemon gate — one cheap
    `docker info` (mirroring preflight's call). When this is False, a probe's None
    means UNKNOWN, not vanished: the sweep must reconcile nothing that tick, or a
    daemon outage mass-kills every in-flight sandbox run as 'vanished'."""
    return _docker(["info", "--format", "{{.ServerVersion}}"], timeout=10).returncode == 0


def managed_containers(cid: str) -> "list[str]":
    """Names of THIS project's live managed run containers — scoped by the
    `orcha.cid=<cid>` label (C1: a host running several orcha stacks must never
    let one daemon's orphan pass stop another project's runs) and EXCLUDING drain
    sidecars (they own no worker_runs row by design — the Kedar-locked no-lease
    invariant — and must never be treated as orphans). `docker ps` has no negative
    label filter, so list managed+cid containers WITH their labels and drop
    sidecar lines client-side."""
    out = _docker(["ps", "--filter", f"label={LABEL_MANAGED}",
                   "--filter", f"label={LABEL_CID_KEY}={cid}",
                   "--format", "{{.Names}}\t{{.Labels}}"], timeout=10)
    if out.returncode != 0:
        return []
    names: list[str] = []
    for line in out.stdout.splitlines():
        if not line.strip():
            continue
        name, _, labels = line.partition("\t")
        if LABEL_SIDECAR in labels.split(","):
            continue
        if name.strip():
            names.append(name.strip())
    return names


# ---------- Issue #75: the global sandbox concurrency cap (OOM incident F1) ----------
# 2026-08-01 postmortem: six sandbox containers spawned within 11 seconds (one per
# agent with ready tasks — NOTHING bounded cross-agent concurrency), an in-sandbox
# `npm ci` pushed the swapless 3.7 GB box into global OOM (kernel `global_oom` at
# 14:52:56 killing pid 3782130), thrash-to-death, operator power cycle. The fix is a
# BOX-WIDE budget on concurrent managed containers, enforced at the last moment before
# every spawn (both lanes), counting GROUND TRUTH so daemon restarts and multiple
# workspaces on one box share the budget honestly.

ENV_MAX_CONCURRENT = "ORCHA_MAX_CONCURRENT_SANDBOXES"
# Host RAM reserved for portal + db + system before dividing the rest among sandboxes.
BASE_RESERVE_MB = 2048
# Non-Linux hosts have no /proc/meminfo; without a ground-truth memory reading we
# cannot derive a budget, so default to a small sane cap (env-overridable).
DEFAULT_CAP_NO_MEMINFO = 2


def all_managed_containers() -> "list[str]":
    """Names of ALL live managed run containers on the HOST — every workspace, every
    daemon, cid-agnostic (issue #75: the budget is box-wide, not per-project, so
    racing daemons on one machine share one honest count). EXCLUDES drain sidecars
    (label-exempt, no worker_runs row by design). Unlike managed_containers() this is
    NOT filtered by orcha.cid — a host running several stacks must budget them
    together against the same physical RAM. Never raises; a docker hiccup reads as an
    empty list, which fails OPEN (no spurious deferral) — the reaper, not this count,
    is the safety net for a container that outlives its budget."""
    out = _docker(["ps", "--filter", f"label={LABEL_MANAGED}",
                   "--format", "{{.Names}}\t{{.Labels}}"], timeout=10)
    if out.returncode != 0:
        return []
    names: list[str] = []
    for line in out.stdout.splitlines():
        if not line.strip():
            continue
        name, _, labels = line.partition("\t")
        if LABEL_SIDECAR in labels.split(","):
            continue
        if name.strip():
            names.append(name.strip())
    return names


def host_memory_mb() -> Optional[int]:
    """Total host RAM in MiB from /proc/meminfo's MemTotal (kB), or None when it is
    unreadable (non-Linux, or an unexpected format). psutil is NOT a dependency — we
    read /proc directly. None signals the caller to fall back to a fixed default."""
    try:
        with open("/proc/meminfo", "r") as fh:
            for line in fh:
                if line.startswith("MemTotal:"):
                    kb = int(line.split()[1])
                    return kb // 1024
    except (OSError, ValueError, IndexError):
        return None
    return None


def sandbox_mem_mb(cfg: "SandboxConfig") -> int:
    """The per-sandbox memory cap in MiB, parsed from the workspace's configured
    `memory` (docker's `--memory` grammar: a bare byte count, or a k/m/g/b suffix,
    case-insensitive — e.g. '4g', '1536m'). An unparseable value falls back to the
    default image cap so the budget math never divides by a bogus figure."""
    raw = str(cfg.memory or DEFAULT_MEMORY).strip().lower()
    m = re.match(r"^(\d+)\s*([kmgb]?)$", raw)
    if not m:
        raw = DEFAULT_MEMORY.lower()
        m = re.match(r"^(\d+)\s*([kmgb]?)$", raw)
    value, unit = int(m.group(1)), m.group(2)
    if unit == "g":
        mb = value * 1024
    elif unit == "m":
        mb = value
    elif unit == "k":
        mb = value // 1024
    else:                                   # bare bytes or explicit 'b'
        mb = value // (1024 * 1024)
    return max(1, mb)


def concurrency_cap(cfg: "SandboxConfig") -> int:
    """The box-wide ceiling on CONCURRENT managed sandbox containers (issue #75).

    Precedence: an explicit ORCHA_MAX_CONCURRENT_SANDBOXES env override wins (a
    positive int; garbage or <1 is ignored). Otherwise derive it from ground truth:
        max(1, (host_mem_mb - BASE_RESERVE_MB) // sandbox_mem_mb)
    so it self-adjusts to the machine — a 3.7 GB box with a 4 GB per-sandbox cap
    budgets exactly ONE, which is precisely the bound the 6-in-11s herd blew past.
    On a host with no /proc/meminfo (non-Linux dev machines) fall back to a fixed
    sane default. Always ≥ 1 (a machine can always run at least one)."""
    override = os.environ.get(ENV_MAX_CONCURRENT)
    if override is not None:
        try:
            value = int(override)
            if value >= 1:
                return value
        except (TypeError, ValueError):
            pass
    host_mb = host_memory_mb()
    if host_mb is None:
        return DEFAULT_CAP_NO_MEMINFO
    per = sandbox_mem_mb(cfg)
    return max(1, (host_mb - BASE_RESERVE_MB) // per)


def cap_defers_spawn(cfg: "SandboxConfig") -> Optional[str]:
    """The last-moment spawn gate (issue #75): None = under budget, spawn; otherwise a
    one-line human reason to LOG-AND-DEFER (keep the candidate eligible, no spawn this
    tick). Counts ground-truth live managed containers HOST-WIDE (all workspaces/
    daemons) so racing daemons on one box can't double-book past the budget between
    ticks. Fails OPEN: if docker can't be queried the count is empty and we allow the
    spawn (the reaper backstops a genuine runaway) — the cap must never wedge a healthy
    box into never spawning."""
    cap = concurrency_cap(cfg)
    live = len(all_managed_containers())
    if live >= cap:
        return (f"sandbox concurrency cap reached ({live}/{cap} live managed "
                f"containers box-wide) — deferring spawn to a later tick (issue #75)")
    return None
