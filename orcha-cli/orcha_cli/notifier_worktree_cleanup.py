"""Inspect, capture, and safely retire notifier-managed Git worktrees."""

from __future__ import annotations

import hashlib
import json
import os
import pathlib
import secrets
import stat
import tempfile
import time
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from typing import Any

NESTED_WORKTREES_PREFIX = ".orcha-worktrees/"
HANDOFF_MAX_PATHS = 5_000
HANDOFF_MAX_PATCH_BYTES = 64 * 1024 * 1024

# These ignored paths are runtime caches or container-wide records, not a
# logical stream's portable checkout state. They remain untouched at their
# source and are inventoried separately; attempting to encode them into every
# stopped-run patch would copy node_modules/venvs/logs (often tens of thousands
# of files) and would incorrectly assign shared deliverables to one stream.
NON_PORTABLE_IGNORED_PREFIXES = (
    ".claude/.orcha-attachments/",
    ".claude/.orcha-wakes/",
    ".claude/orcha-tabs/",
    ".orcha/conversation-logs/",
    ".orcha/logs/",
    ".orcha/migrations/",
    ".orcha/outputs/",
    ".orcha/portal/",
    ".orcha/orcha.db",
    ".orcha/resident-logs/",
    ".orcha/saved-output/",
    ".orcha-worktrees/",
    ".venv/",
    ".venv-test/",
    "android/.gradle/",
    "android/.idea/",
    "android/.kotlin/",
    "android/app/build/",
    "desktop/dist/",
    "desktop/out/",
    "desktop/resources/orcha-templates/",
    "ios/build/",
)
NON_PORTABLE_IGNORED_NAMES = frozenset(
    {"__pycache__", ".pytest_cache", "node_modules", ".DS_Store", "xcuserdata"}
)
NON_PORTABLE_IGNORED_FILES = frozenset(
    {
        ".DS_Store",
        ".orcha/.env",
        ".orcha/docker-compose.yml",
        ".orcha/orcha.json.docker",
        ".orcha/state.json",
        "android/local.properties",
        ".claude/.orcha-notifier.hb",
        ".claude/.orcha-notifier.log",
        ".claude/.orcha-notifier.pid",
        ".claude/.orcha-terminal-bridge.log",
        ".claude/.orcha-terminal-bridge.pid",
    }
)

DIFF_EXCLUDES = (
    ".",
    ":(exclude).claude/orcha.json",
    ":(exclude).claude/orcha-tabs",
    ":(exclude).claude/settings.json",
    ":(exclude).claude/commands/orcha-*.md",
    ":(exclude).agents/skills/orcha-*",
)


@dataclass(frozen=True)
class HandoffResult:
    """Machine-readable outcome for checkout inspection and reconciliation."""

    ok: bool
    code: str
    phase: str
    source: str | None = None
    destination: str | None = None
    requested_owner: str | None = None
    observed_owner: str | None = None
    patch_sha256: str | None = None
    guidance: str = ""
    mutated: bool = False
    details: dict[str, Any] = field(default_factory=dict)

    def __bool__(self) -> bool:
        """Keep compatibility with legacy callers while they adopt ``.ok``."""
        return self.ok

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class CheckoutActivityReservation:
    """Process-held proof that one worker may write one checkout.

    The lock file lives in Git-private metadata.  The notifier keeps its
    descriptor locked while the worker is tracked; after a notifier restart the
    unlocked record remains a fail-closed ``pending_snapshot`` barrier until the
    orphan-recovery path validates the stopped run and archives it.  Metadata
    deliberately excludes tokens, prompts, output, and file data.
    """

    checkout: str
    owner_key: str
    reservation_id: str
    path: pathlib.Path
    handle: Any
    created_at: float
    phase: str = "routing"
    before_fingerprint: dict[str, Any] | None = None
    routed_fingerprint: dict[str, Any] | None = None
    routing_source: str | None = None
    routing_patch_sha256: str | None = None
    run_id: str | None = None
    pid: int | None = None
    sandbox_container_id: str | None = None

    @property
    def ok(self) -> bool:
        return True

    @property
    def code(self) -> str:
        return "checkout_activity_reserved"

    def fileno(self) -> int:
        return self.handle.fileno()


def _result(
    ok: bool,
    code: str,
    phase: str,
    *,
    source=None,
    destination=None,
    owner_key=None,
    observed_owner=None,
    patch=None,
    guidance="",
    mutated=False,
    details=None,
):
    return HandoffResult(
        ok=ok,
        code=code,
        phase=phase,
        source=str(source) if source is not None else None,
        destination=str(destination) if destination is not None else None,
        requested_owner=owner_key,
        observed_owner=observed_owner,
        patch_sha256=_patch_digest(patch) if patch is not None else None,
        guidance=guidance,
        mutated=mutated,
        details=details or {},
    )


def _patch_bytes(patch: str) -> bytes:
    return patch.encode("utf-8", "surrogateescape")


def _patch_digest(patch: str) -> str:
    return hashlib.sha256(_patch_bytes(patch)).hexdigest()


def _non_portable_ignored_path(relative_path: str) -> bool:
    """Return whether an ignored path is preserved in place, not handed off."""
    normalized = relative_path.replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    if normalized in NON_PORTABLE_IGNORED_FILES:
        return True
    if any(
        normalized == prefix.rstrip("/") or normalized.startswith(prefix)
        for prefix in NON_PORTABLE_IGNORED_PREFIXES
    ):
        return True
    return any(
        part in NON_PORTABLE_IGNORED_NAMES or part.endswith(".xcuserdatad")
        for part in normalized.split("/")
    )


def _full_patch(
    cwd,
    services: Any,
    *,
    include_ignored: bool = False,
    base_ref: str = "origin/main",
    max_paths: int | None = None,
    max_bytes: int | None = None,
    diagnostics: dict | None = None,
):
    """Return the complete binary-safe patch without changing the checkout index."""
    return_code, tracked = services._run_git(
        ["diff", "--binary", "--full-index", base_ref, "--", *DIFF_EXCLUDES],
        cwd=cwd,
        timeout=60,
    )
    if return_code != 0:
        if diagnostics is not None:
            diagnostics["code"] = "git_diff_failed"
        return None
    captured_bytes = len(_patch_bytes(tracked))
    if max_bytes is not None and captured_bytes > max_bytes:
        if diagnostics is not None:
            diagnostics.update(code="patch_bytes_exceeded", bytes=captured_bytes)
        return None

    # ``git diff`` deliberately omits ordinary untracked files.  Diff each one
    # against /dev/null rather than using ``git add -N``: intent-to-add mutates
    # the real index and made even a rejected handoff observably change a human
    # checkout.  NUL separation preserves unusual but valid path names.
    untracked_commands = [
        ["ls-files", "--others", "--exclude-standard", "-z", "--", *DIFF_EXCLUDES]
    ]
    if include_ignored:
        untracked_commands.append(
            [
                "ls-files",
                "--others",
                "--ignored",
                "--exclude-standard",
                "-z",
                "--",
                *DIFF_EXCLUDES,
            ]
        )

    patches = [tracked]
    untracked_paths = []
    seen_paths = set()
    skipped_non_portable = 0
    for command_index, command in enumerate(untracked_commands):
        untracked_code, untracked = services._run_git(
            command, cwd=cwd, timeout=60
        )
        if untracked_code != 0:
            if diagnostics is not None:
                diagnostics["code"] = "git_file_list_failed"
            return None
        for relative_path in filter(None, untracked.split("\0")):
            if command_index > 0 and _non_portable_ignored_path(relative_path):
                skipped_non_portable += 1
                continue
            if relative_path not in seen_paths:
                seen_paths.add(relative_path)
                untracked_paths.append(relative_path)
                if max_paths is not None and len(untracked_paths) > max_paths:
                    if diagnostics is not None:
                        diagnostics.update(
                            code="patch_paths_exceeded", paths=len(untracked_paths)
                        )
                    return None

    if diagnostics is not None and skipped_non_portable:
        diagnostics["ignored_nonportable_skipped"] = skipped_non_portable

    for relative_path in untracked_paths:
        if max_bytes is not None:
            try:
                apparent_size = os.lstat(
                    pathlib.Path(cwd) / relative_path
                ).st_size
            except OSError:
                if diagnostics is not None:
                    diagnostics["code"] = "untracked_file_stat_failed"
                return None
            if apparent_size > max_bytes - captured_bytes:
                if diagnostics is not None:
                    diagnostics.update(
                        code="patch_bytes_exceeded",
                        bytes=captured_bytes + apparent_size,
                        oversized_path=relative_path,
                    )
                return None
        file_code, file_patch = services._run_git(
            [
                "diff",
                "--no-index",
                "--binary",
                "--full-index",
                "--",
                "/dev/null",
                relative_path,
            ],
            cwd=cwd,
            timeout=60,
        )
        # --no-index uses 1 for the expected "files differ" result.
        if file_code not in (0, 1):
            if diagnostics is not None:
                diagnostics["code"] = "git_file_diff_failed"
            return None
        captured_bytes += len(_patch_bytes(file_patch))
        if max_bytes is not None and captured_bytes > max_bytes:
            if diagnostics is not None:
                diagnostics.update(code="patch_bytes_exceeded", bytes=captured_bytes)
            return None
        patches.append(file_patch)
    return "".join(patches)


def _handoff_patch(cwd, services: Any, *, base_ref: str = "origin/main"):
    """Capture a bounded full view, including ignored files, for safe handoff."""
    diagnostics = {}
    patch = _full_patch(
        cwd,
        services,
        include_ignored=True,
        base_ref=base_ref,
        max_paths=HANDOFF_MAX_PATHS,
        max_bytes=HANDOFF_MAX_PATCH_BYTES,
        diagnostics=diagnostics,
    )
    return patch, diagnostics


def _branch_patch(base_cwd, branch: str, services: Any):
    """Return committed branch state relative to main without a checked-out tree."""
    if not branch or not branch.startswith("orcha/"):
        return None
    ref = f"refs/heads/{branch}"
    verify_code, _ = services._run_git(
        ["show-ref", "--verify", "--quiet", ref], cwd=base_cwd, timeout=60
    )
    if verify_code != 0:
        return None
    return_code, patch = services._run_git(
        [
            "diff",
            "--binary",
            "--full-index",
            "origin/main",
            ref,
            "--",
            *DIFF_EXCLUDES,
        ],
        cwd=base_cwd,
        timeout=60,
    )
    return patch if return_code == 0 else None


def _apply_patch(cwd, patch: str, services: Any, *, reverse: bool = False) -> bool:
    """Apply a patch only after Git confirms the complete operation is safe."""
    patch_path = None
    try:
        fd, patch_path = tempfile.mkstemp(
            prefix="orcha-checkout-handoff-", suffix=".patch"
        )
        os.close(fd)
        pathlib.Path(patch_path).write_text(
            patch, encoding="utf-8", errors="surrogateescape"
        )
        arguments = ["apply", "--check"]
        if reverse:
            arguments.append("--reverse")
        arguments.append(patch_path)
        check_code, _ = services._run_git(arguments, cwd=cwd, timeout=60)
        if check_code != 0:
            return False
        arguments.remove("--check")
        apply_code, _ = services._run_git(arguments, cwd=cwd, timeout=60)
        return apply_code == 0
    except OSError:
        return False
    finally:
        if patch_path:
            try:
                pathlib.Path(patch_path).unlink()
            except OSError:
                pass


def _replace_patch(cwd, current: str, desired: str, services: Any) -> bool:
    """Replace one complete checkout patch with another, restoring on failure."""
    if current.strip() and not _apply_patch(cwd, current, services, reverse=True):
        return False

    desired_applied = False
    if desired.strip():
        desired_applied = _apply_patch(cwd, desired, services)
        if not desired_applied:
            if current.strip():
                _apply_patch(cwd, current, services)
            return False

    reconciled = _full_patch(cwd, services, include_ignored=True)
    if reconciled == desired:
        return True

    if desired_applied:
        _apply_patch(cwd, desired, services, reverse=True)
    if current.strip():
        _apply_patch(cwd, current, services)
    return False


def _git_common_path(cwd, services: Any):
    """Return the repository's private common Git directory."""
    return_code, common_dir = services._run_git(
        ["rev-parse", "--git-common-dir"], cwd=cwd
    )
    if return_code != 0 or not common_dir.strip():
        return None
    common_path = pathlib.Path(common_dir.strip())
    if not common_path.is_absolute():
        common_path = pathlib.Path(cwd) / common_path
    return common_path.resolve()


def _outside_git(cwd, services: Any) -> bool:
    """Return True only when ``cwd`` provably has no Git metadata to protect.

    That is a path that does not exist, or one Git itself reports as "not a
    repository" (exit 128).  Any other failure (git missing, timeout) is not
    proof, so callers keep failing closed.
    """
    checkout = pathlib.Path(cwd)
    if not checkout.exists():
        return True
    return checkout.is_dir() and services._run_git(
        ["rev-parse", "--git-dir"], cwd=cwd
    )[0] == 128


def _checkout_metadata_key(cwd) -> str:
    return hashlib.sha256(
        str(pathlib.Path(cwd).resolve()).encode("utf-8")
    ).hexdigest()


def _handoff_record_path(cwd, services: Any):
    """Return a checkout-specific record stored inside Git's private metadata."""
    common_path = _git_common_path(cwd, services)
    if common_path is None:
        return None
    return (
        common_path
        / "orcha"
        / "handoffs"
        / f"{_checkout_metadata_key(cwd)}.patch"
    )


def _retirement_record_path(base_cwd, checkout, services: Any):
    """Private proof that Orcha itself safely retired one exact checkout path."""
    common_path = _git_common_path(base_cwd, services)
    if common_path is None:
        return None
    return (
        common_path
        / "orcha"
        / "handoffs"
        / "retired"
        / f"{_checkout_metadata_key(checkout)}.json"
    )


def _runtime_overlay_manifest(root):
    """Hash runtime-overlay files separately without exposing their contents."""
    root = pathlib.Path(root)
    candidates = []
    for relative in (".claude/orcha.json", ".claude/settings.json"):
        path = root / relative
        if path.exists() or path.is_symlink():
            candidates.append(path)
    for directory in (root / ".claude" / "orcha-tabs",):
        if directory.is_dir():
            candidates.extend(path for path in directory.rglob("*") if path.is_file() or path.is_symlink())
    commands = root / ".claude" / "commands"
    if commands.is_dir():
        candidates.extend(path for path in commands.glob("orcha-*.md") if path.is_file() or path.is_symlink())
    skills = root / ".agents" / "skills"
    if skills.is_dir():
        for entry in skills.glob("orcha-*"):
            if entry.is_dir():
                candidates.extend(path for path in entry.rglob("*") if path.is_file() or path.is_symlink())
            elif entry.is_file() or entry.is_symlink():
                candidates.append(entry)
    manifest = {}
    try:
        for path in sorted(set(candidates)):
            relative = path.relative_to(root).as_posix()
            if path.is_symlink():
                payload = os.readlink(path).encode("utf-8", "surrogateescape")
                kind = "symlink"
            else:
                payload = path.read_bytes()
                kind = "file"
            manifest[relative] = {
                "kind": kind,
                "bytes": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest(),
            }
        return manifest
    except (OSError, UnicodeError, ValueError):
        return None


def _write_retirement_record(
    base_cwd,
    checkout,
    branch,
    services: Any,
    *,
    disposition,
    patch,
    runtime_manifest,
) -> bool:
    temporary = None
    try:
        path = _retirement_record_path(base_cwd, checkout, services)
        base_oid = _origin_main_oid(base_cwd, services)
        if path is None or base_oid is None or runtime_manifest is None:
            return False
        owner_raw = handoff_record_bytes(checkout, services)
        head_code, head_output = services._run_git(
            ["rev-parse", "HEAD"], cwd=checkout
        )
        record = {
            "version": 2,
            "kind": "checkout_retirement",
            # A prepared record is deliberately not sufficient recovery proof.
            # It is promoted only after the checkout path is confirmed absent.
            "state": "prepared",
            "disposition": disposition,
            "checkout": str(pathlib.Path(checkout).resolve()),
            "base_cwd": str(pathlib.Path(base_cwd).resolve()),
            "branch": branch,
            "origin_main_oid": base_oid,
            "checkout_head_oid": (
                head_output.strip() if head_code == 0 and head_output.strip() else None
            ),
            "patch_sha256": _patch_digest(patch),
            "patch_bytes": len(_patch_bytes(patch)),
            "runtime_manifest": runtime_manifest,
            "owner_record_sha256": (
                hashlib.sha256(owner_raw).hexdigest() if owner_raw is not None else None
            ),
            "recorded_at": time.time(),
        }
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        os.close(fd)
        pathlib.Path(temporary).write_text(json.dumps(record, separators=(",", ":")))
        os.replace(temporary, path)
        temporary = None
        return True
    except (OSError, UnicodeError, ValueError, TypeError):
        return False
    finally:
        if temporary:
            try:
                pathlib.Path(temporary).unlink()
            except OSError:
                pass


def _finalize_retirement_record(base_cwd, checkout, branch, services: Any) -> bool:
    """Promote prepared retirement evidence after removal is observable.

    The two-phase state prevents a daemon crash between proof creation and
    worktree deletion from making a still-present (or later reused) checkout
    look safely retired.
    """
    temporary = None
    try:
        path = _retirement_record_path(base_cwd, checkout, services)
        if path is None or not path.is_file() or pathlib.Path(checkout).exists():
            return False
        record = json.loads(path.read_text())
        if not (
            isinstance(record, dict)
            and record.get("version") == 2
            and record.get("kind") == "checkout_retirement"
            and record.get("state") == "prepared"
            and record.get("checkout") == str(pathlib.Path(checkout).resolve())
            and record.get("base_cwd") == str(pathlib.Path(base_cwd).resolve())
            and record.get("branch") == branch
        ):
            return False
        finalized = {
            **record,
            "state": "finalized",
            "finalized_at": time.time(),
        }
        fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        os.close(fd)
        pathlib.Path(temporary).write_text(
            json.dumps(finalized, separators=(",", ":"))
        )
        os.replace(temporary, path)
        temporary = None
        return True
    except (OSError, UnicodeError, ValueError, TypeError):
        return False
    finally:
        if temporary:
            try:
                pathlib.Path(temporary).unlink()
            except OSError:
                pass


def retirement_record_status(base_cwd, checkout, branch, services: Any):
    """Validate durable clean/discard proof for a now-missing checkout."""
    try:
        path = _retirement_record_path(base_cwd, checkout, services)
        if path is None or not path.is_file():
            return "missing", None
        record = json.loads(path.read_text())
        legacy_finalized = record.get("version") == 1
        current_finalized = bool(
            record.get("version") == 2 and record.get("state") == "finalized"
        )
        valid = bool(
            isinstance(record, dict)
            and (legacy_finalized or current_finalized)
            and record.get("kind") == "checkout_retirement"
            and record.get("disposition") in {"clean", "human_discarded"}
            and record.get("checkout") == str(pathlib.Path(checkout).resolve())
            and record.get("base_cwd") == str(pathlib.Path(base_cwd).resolve())
            and record.get("branch") == branch
            and isinstance(record.get("origin_main_oid"), str)
            and (
                record.get("checkout_head_oid") is None
                or isinstance(record.get("checkout_head_oid"), str)
            )
            and isinstance(record.get("patch_sha256"), str)
            and isinstance(record.get("patch_bytes"), int)
            and isinstance(record.get("runtime_manifest"), dict)
        )
        return ("match", record) if valid else ("invalid", None)
    except (OSError, UnicodeError, ValueError, TypeError):
        return "invalid", None


def clear_retirement_record(base_cwd, checkout, services: Any) -> bool:
    """Archive and invalidate proof before a checkout path is reused.

    Stable worktree paths are deterministic. Keeping an old retirement marker
    beside a newly provisioned generation would let a later missing checkout be
    mistaken for the older clean retirement.
    """
    temporary = None
    try:
        path = _retirement_record_path(base_cwd, checkout, services)
        if path is None or not path.exists():
            return True
        raw = path.read_bytes()
        common_path = _git_common_path(base_cwd, services)
        if common_path is None:
            return False
        digest = hashlib.sha256(raw).hexdigest()
        archive = (
            common_path
            / "orcha"
            / "handoffs"
            / "archive"
            / "retired"
            / _checkout_metadata_key(checkout)
            / f"{digest}.json"
        )
        if archive.exists():
            if archive.read_bytes() != raw:
                return False
        else:
            archive.parent.mkdir(parents=True, exist_ok=True)
            fd, temporary = tempfile.mkstemp(
                prefix=f".{archive.name}.", dir=archive.parent
            )
            os.close(fd)
            pathlib.Path(temporary).write_bytes(raw)
            os.replace(temporary, archive)
            temporary = None
        path.unlink()
        return not path.exists()
    except (OSError, UnicodeError, ValueError, TypeError):
        return False
    finally:
        if temporary:
            try:
                pathlib.Path(temporary).unlink()
            except OSError:
                pass


def _stream_snapshot_dir(cwd, owner_key: str, services: Any):
    """Return the immutable snapshot directory for one logical stream."""
    common_path = _git_common_path(cwd, services)
    if common_path is None:
        return None
    owner_hash = hashlib.sha256(owner_key.encode("utf-8")).hexdigest()
    return (
        common_path
        / "orcha"
        / "handoffs"
        / "streams"
        / _checkout_metadata_key(cwd)
        / owner_hash
    )


def _stream_snapshot_path(cwd, owner_key: str, run_id, services: Any):
    directory = _stream_snapshot_dir(cwd, owner_key, services)
    if directory is None or not run_id:
        return None
    run_hash = hashlib.sha256(str(run_id).encode("utf-8")).hexdigest()
    return directory / f"{run_hash}.json"


def _origin_main_oid(cwd, services: Any):
    return_code, output = services._run_git(
        ["rev-parse", "origin/main"], cwd=cwd, timeout=60
    )
    return output.strip() if return_code == 0 and output.strip() else None


def _write_stream_snapshot(
    cwd,
    owner_key: str,
    patch: str,
    services: Any,
    *,
    run_id=None,
    base_oid=None,
) -> bool:
    """Persist immutable, run-bound proof for one stopped stream and file view."""
    temporary = None
    try:
        if not run_id:
            return False
        base_oid = base_oid or _origin_main_oid(cwd, services)
        path = _stream_snapshot_path(cwd, owner_key, run_id, services)
        if path is None or base_oid is None:
            return False
        if path.is_file():
            record = json.loads(path.read_text())
            return bool(
                isinstance(record, dict)
                and record.get("version") == 2
                and record.get("kind") == "checkout_stream_snapshot"
                and record.get("capture_phase") == "stopped_run"
                and record.get("authoritative") is True
                and record.get("owner_key") == owner_key
                and record.get("run_id") == str(run_id)
                and record.get("checkout") == str(pathlib.Path(cwd).resolve())
                and record.get("origin_main_oid") == base_oid
                and record.get("patch_sha256") == _patch_digest(patch)
                and record.get("patch_bytes") == len(_patch_bytes(patch))
                and record.get("patch") == patch
            )
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        os.close(fd)
        pathlib.Path(temporary).write_text(
            json.dumps(
                {
                    "version": 2,
                    "kind": "checkout_stream_snapshot",
                    "capture_phase": "stopped_run",
                    "owner_key": owner_key,
                    "checkout": str(pathlib.Path(cwd).resolve()),
                    "origin_main_oid": base_oid,
                    "patch_sha256": _patch_digest(patch),
                    "patch_bytes": len(_patch_bytes(patch)),
                    "patch": patch,
                    "run_id": str(run_id),
                    "captured_at": time.time(),
                    "authoritative": True,
                },
                separators=(",", ":"),
            )
        )
        os.replace(temporary, path)
        temporary = None
        return True
    except (OSError, UnicodeError, ValueError, TypeError):
        return False
    finally:
        if temporary:
            try:
                pathlib.Path(temporary).unlink()
            except OSError:
                pass


def _stream_snapshot_status(cwd, owner_key: str, run_id, services: Any):
    """Load and validate one immutable run-bound snapshot."""
    try:
        path = _stream_snapshot_path(cwd, owner_key, run_id, services)
        if path is None:
            return "unreadable", None
        if not path.is_file():
            return "missing", None
        record = json.loads(path.read_text())
        patch = record.get("patch") if isinstance(record, dict) else None
        valid = bool(
            isinstance(record, dict)
            and record.get("version") == 2
            and record.get("kind") == "checkout_stream_snapshot"
            and record.get("capture_phase") == "stopped_run"
            and record.get("authoritative") is True
            and record.get("owner_key") == owner_key
            and record.get("run_id") == str(run_id)
            and record.get("checkout") == str(pathlib.Path(cwd).resolve())
            and isinstance(record.get("origin_main_oid"), str)
            and isinstance(patch, str)
            and record.get("patch_sha256") == _patch_digest(patch)
            and record.get("patch_bytes") == len(_patch_bytes(patch))
        )
        if valid:
            object_code, _ = services._run_git(
                ["cat-file", "-e", f"{record['origin_main_oid']}^{{commit}}"],
                cwd=cwd,
                timeout=60,
            )
            valid = object_code == 0
        return ("match", record) if valid else ("unreadable", None)
    except (OSError, UnicodeError, ValueError, TypeError):
        return "unreadable", None


def _overlap_evidence_dir(cwd, services: Any):
    """Return the append-only ambiguity-proof directory for one checkout."""
    common_path = _git_common_path(cwd, services)
    if common_path is None:
        return None
    return (
        common_path
        / "orcha"
        / "handoffs"
        / "overlaps"
        / _checkout_metadata_key(cwd)
    )


def _overlap_evidence_core(record: dict) -> dict:
    return {
        "version": record.get("version"),
        "kind": record.get("kind"),
        "checkout": record.get("checkout"),
        "authoritative": record.get("authoritative"),
        "reason": record.get("reason"),
        "owner_key": record.get("owner_key"),
        "run_id": record.get("run_id"),
        "agent_id": record.get("agent_id"),
        "unknown_checkout_user": record.get("unknown_checkout_user"),
        "other_streams": record.get("other_streams"),
    }


def _overlap_evidence_digest(core: dict) -> str:
    raw = json.dumps(core, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(raw).hexdigest()


def checkout_overlap_evidence(cwd, services: Any) -> dict:
    """Inspect durable stopped-checkout ambiguity proof without changing it."""
    try:
        directory = _overlap_evidence_dir(cwd, services)
        if directory is None:
            return {"status": "unreadable", "evidence_count": 0}
        if not directory.exists():
            return {"status": "none", "evidence_count": 0}
        records = []
        for path in sorted(directory.glob("*.json")):
            record = json.loads(path.read_text())
            core = _overlap_evidence_core(record) if isinstance(record, dict) else {}
            reason = core.get("reason")
            kind = core.get("kind")
            valid = bool(
                isinstance(record, dict)
                and core.get("version") == 1
                and kind in {
                    "checkout_shared_overlap",
                    "checkout_snapshot_failure",
                }
                and core.get("checkout") == str(pathlib.Path(cwd).resolve())
                and core.get("authoritative") is False
                and isinstance(reason, str)
                and (
                    (
                        reason == "concurrent_or_unidentified_checkout_user"
                        and kind == "checkout_shared_overlap"
                    )
                    or (
                        reason.startswith("snapshot_failure:")
                        # Version-one records written before the distinction used
                        # the overlap kind for every durable ambiguity marker.
                        and kind
                        in {
                            "checkout_shared_overlap",
                            "checkout_snapshot_failure",
                        }
                    )
                )
                and isinstance(core.get("owner_key"), str)
                and isinstance(core.get("run_id"), str)
                and isinstance(core.get("unknown_checkout_user"), bool)
                and isinstance(core.get("other_streams"), list)
                and path.stem == _overlap_evidence_digest(core)
            )
            if not valid:
                return {"status": "unreadable", "evidence_count": len(records)}
            records.append(record)
        if not records:
            return {"status": "none", "evidence_count": 0}
        return {
            "status": "present",
            "evidence_count": len(records),
            "reasons": sorted({record["reason"] for record in records}),
            "first_recorded_at": min(
                float(record.get("recorded_at") or 0) for record in records
            ),
        }
    except (OSError, UnicodeError, ValueError, TypeError):
        return {"status": "unreadable", "evidence_count": 0}


def record_checkout_overlap_evidence(
    cwd,
    owner_key: str,
    services: Any,
    *,
    run_id,
    agent_id=None,
    other_rows=(),
    unknown_checkout_user=False,
    reason="concurrent_or_unidentified_checkout_user",
) -> HandoffResult:
    """Append immutable proof that checkout state cannot be attributed safely.

    The proof intentionally contains no patch and assigns no file state.  It
    survives daemon restart so the last stopped row cannot later claim the
    combined checkout merely because earlier overlapping rows were finalized.
    """
    temporary = None
    try:
        directory = _overlap_evidence_dir(cwd, services)
        if (
            directory is None
            or not cwd
            or not owner_key
            or not run_id
            or not isinstance(reason, str)
            or not reason
        ):
            raise OSError("overlap evidence path or identity unavailable")
        streams = []
        for row in other_rows or ():
            if not isinstance(row, dict):
                continue
            streams.append(
                {
                    key: (str(row.get(key)) if row.get(key) is not None else None)
                    for key in (
                        "run_id",
                        "agent_id",
                        "task_id",
                        "conversation_id",
                        "wake_kind",
                        "lane",
                    )
                }
            )
        streams.sort(
            key=lambda item: tuple(
                item.get(key) or ""
                for key in ("run_id", "agent_id", "task_id", "conversation_id")
            )
        )
        is_overlap = reason == "concurrent_or_unidentified_checkout_user"
        core = {
            "version": 1,
            "kind": (
                "checkout_shared_overlap"
                if is_overlap
                else "checkout_snapshot_failure"
            ),
            "checkout": str(pathlib.Path(cwd).resolve()),
            "authoritative": False,
            "reason": reason,
            "owner_key": str(owner_key),
            "run_id": str(run_id),
            "agent_id": str(agent_id) if agent_id is not None else None,
            "unknown_checkout_user": bool(unknown_checkout_user),
            "other_streams": streams,
        }
        digest = _overlap_evidence_digest(core)
        path = directory / f"{digest}.json"
        if path.is_file():
            existing = json.loads(path.read_text())
            if _overlap_evidence_core(existing) != core:
                raise OSError("overlap evidence digest collision")
        else:
            directory.mkdir(parents=True, exist_ok=True)
            fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=directory)
            os.close(fd)
            pathlib.Path(temporary).write_text(
                json.dumps(
                    {**core, "recorded_at": time.time()},
                    separators=(",", ":"),
                )
            )
            os.replace(temporary, path)
            temporary = None
        status = checkout_overlap_evidence(cwd, services)
        if status.get("status") != "present":
            raise OSError("overlap evidence could not be revalidated")
        return _result(
            True,
            "snapshot_overlap_evidence_recorded",
            "source_snapshot",
            source=cwd,
            owner_key=owner_key,
            guidance=(
                "Orcha preserved immutable proof that this checkout was shared; "
                "no stream was assigned the combined files."
                if is_overlap
                else "Orcha preserved immutable proof of the exact snapshot failure; no stream was assigned the checkout files."
            ),
            mutated=True,
            details={"evidence_count": status.get("evidence_count", 0)},
        )
    except (OSError, UnicodeError, ValueError, TypeError):
        return _result(
            False,
            "snapshot_overlap_evidence_write_failed",
            "source_snapshot",
            source=cwd,
            owner_key=owner_key,
            guidance=(
                "Orcha could not preserve durable proof of overlapping checkout "
                "users, so it kept the stopped run for a safe retry."
            ),
        )
    finally:
        if temporary:
            try:
                pathlib.Path(temporary).unlink()
            except OSError:
                pass


@contextmanager
def _handoff_mutation_lock(cwd, services: Any):
    """Serialize checkout handoffs across notifier processes in one repository."""
    handle = None
    locked = False
    try:
        common_path = _git_common_path(cwd, services)
        if common_path is None:
            yield False
            return
        lock_path = common_path / "orcha" / "handoffs" / "mutation.lock"
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        handle = lock_path.open("a+b")
        try:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            locked = True
        except (ImportError, BlockingIOError, OSError):
            yield False
            return
        yield True
    except OSError:
        yield False
    finally:
        if locked and handle is not None:
            try:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            except (ImportError, OSError):
                pass
        if handle is not None:
            try:
                handle.close()
            except OSError:
                pass


def _checkout_activity_path(cwd, services: Any):
    """Return the single-writer reservation path for ``cwd``."""
    common_path = _git_common_path(cwd, services)
    if common_path is None:
        return None
    return (
        common_path
        / "orcha"
        / "handoffs"
        / "activity"
        / f"{_checkout_metadata_key(cwd)}.json"
    )


def checkout_state_fingerprint(cwd, services: Any):
    """Return an exact digest of the checkout state routing is allowed to touch.

    The handoff patch includes tracked, staged, untracked, and portable ignored
    files.  The ownership record is fingerprinted separately because changing
    provenance without changing files is still a material routing mutation.
    """
    try:
        base_oid = _origin_main_oid(cwd, services)
        if base_oid is None:
            return None
        patch, diagnostics = _handoff_patch(cwd, services, base_ref=base_oid)
        if patch is None:
            return None
        owner_record = handoff_record_bytes(cwd, services)
        return {
            "origin_main_oid": base_oid,
            "patch_sha256": _patch_digest(patch),
            "patch_bytes": len(_patch_bytes(patch)),
            "owner_record_sha256": (
                hashlib.sha256(owner_record).hexdigest()
                if owner_record is not None
                else None
            ),
            "owner_record_bytes": (
                len(owner_record) if owner_record is not None else None
            ),
            "capture": diagnostics,
        }
    except (OSError, TypeError, ValueError):
        return None


def _activity_fingerprint_matches(cwd, expected, services: Any) -> bool:
    """Revalidate a phase boundary before an unstarted writer is released."""
    if not isinstance(expected, dict):
        return False
    observed = checkout_state_fingerprint(cwd, services)
    if observed is None:
        return False
    return all(
        observed.get(key) == expected.get(key)
        for key in (
            "origin_main_oid",
            "patch_sha256",
            "patch_bytes",
            "owner_record_sha256",
            "owner_record_bytes",
        )
    )


def _activity_payload(activity: CheckoutActivityReservation) -> bytes:
    payload = {
        # Version three makes the pre-writer routing phases explicit.  Recovery
        # must never mistake an interrupted handoff for a stopped worker owned
        # by the stream that was only trying to start.
        "version": 3,
        "checkout": activity.checkout,
        "owner_key": activity.owner_key,
        "reservation_id": activity.reservation_id,
        "created_at": activity.created_at,
        "phase": activity.phase,
        "before_fingerprint": activity.before_fingerprint,
        "routed_fingerprint": activity.routed_fingerprint,
        "routing_source": activity.routing_source,
        "routing_patch_sha256": activity.routing_patch_sha256,
        "run_id": activity.run_id,
        "pid": activity.pid,
        "sandbox_container_id": activity.sandbox_container_id,
    }
    return json.dumps(payload, separators=(",", ":"), sort_keys=True).encode(
        "utf-8"
    )


def _write_activity_handle(activity: CheckoutActivityReservation) -> bool:
    """Append one durable phase record without destroying the prior valid phase.

    The activity file's inode is also the process-held lock, so replacing it
    would silently detach the lock.  An append-only JSON-lines journal keeps the
    inode stable and makes a crash during a later phase write recoverable from
    the preceding complete line.
    """
    try:
        descriptor = activity.handle.fileno()
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            return False
        payload = _activity_payload(activity) + b"\n"
        os.lseek(descriptor, 0, os.SEEK_END)
        written = 0
        while written < len(payload):
            written += os.write(descriptor, payload[written:])
        os.fsync(descriptor)
        return True
    except (OSError, ValueError):
        return False


def _read_activity_record(path: pathlib.Path):
    """Read a reservation through a no-follow descriptor."""
    descriptor = None
    try:
        flags = os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            return None, None
        raw = b""
        while True:
            chunk = os.read(descriptor, 64 * 1024)
            if not chunk:
                break
            raw += chunk
            if len(raw) > 1024 * 1024:
                return None, None
        decoded = raw.decode("utf-8")
        record = None
        # Version-three files are append-only journals.  Ignore at most a
        # trailing partial/corrupt line and recover the newest complete phase.
        for line in reversed(decoded.splitlines()):
            if not line.strip():
                continue
            try:
                candidate = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(candidate, dict):
                record = candidate
                break
        if record is None:
            # Compatibility with a legacy JSON file containing surrounding
            # whitespace but no line-oriented phase history.
            record = json.loads(decoded)
        if (
            not isinstance(record, dict)
            or record.get("version") not in {1, 2, 3}
            or not isinstance(record.get("checkout"), str)
            or not isinstance(record.get("owner_key"), str)
            or not isinstance(record.get("reservation_id"), str)
        ):
            return None, None
        if record.get("version") == 3 and record.get("phase") not in {
            "routing",
            "routed",
            "writer_started",
            "run_bound",
        }:
            return None, None
        return descriptor, record
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError):
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
        return None, None


def checkout_activity_status(
    cwd,
    services: Any,
    *,
    ignore_reservation_id=None,
    ignore_run_id=None,
) -> dict:
    """Inspect process-held checkout activity without changing its metadata.

    An unlocked record is still pending stopped-state reconciliation, not stale:
    only the snapshot/reaper path may archive and remove it.
    """
    path = _checkout_activity_path(cwd, services)
    if path is None:
        # Reservations live in Git's private metadata; a checkout outside Git
        # can hold none.  Any other unreadable state fails closed.
        if _outside_git(cwd, services):
            return {"status": "none", "records": []}
        return {"status": "unreadable", "records": []}
    if not path.exists():
        return {"status": "none", "records": []}
    descriptor, record = _read_activity_record(path)
    if descriptor is None or record is None:
        return {"status": "unreadable", "records": []}
    try:
        if (
            ignore_reservation_id is not None
            and record.get("reservation_id") == str(ignore_reservation_id)
        ) or (
            ignore_run_id is not None
            and record.get("run_id") is not None
            and str(record.get("run_id")) == str(ignore_run_id)
        ):
            return {"status": "ignored", "records": [record]}
        try:
            import fcntl

            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(descriptor, fcntl.LOCK_UN)
            state = "pending_snapshot"
        except BlockingIOError:
            state = "active"
        except (ImportError, OSError):
            state = "unreadable"
        return {"status": state, "records": [record]}
    finally:
        try:
            os.close(descriptor)
        except OSError:
            pass


def reserve_checkout_activity(
    cwd,
    owner_key: str,
    services: Any,
    *,
    checkout_guard=None,
):
    """Reserve ``cwd`` before spawning any process that may write there."""
    if not cwd or not owner_key:
        return _result(
            False,
            "checkout_activity_identity_missing",
            "activity_reservation",
            destination=cwd,
            owner_key=owner_key,
            guidance="The checkout or logical stream identity is missing; no worker was started.",
        )
    with _handoff_mutation_lock(cwd, services) as acquired:
        if not acquired:
            return _result(
                False,
                "handoff_lock_unavailable",
                "activity_reservation",
                destination=cwd,
                owner_key=owner_key,
                guidance="Another checkout operation is active; no worker was started.",
            )
        existing = checkout_activity_status(cwd, services)
        if existing.get("status") != "none":
            return _result(
                False,
                (
                    "checkout_activity_unreadable"
                    if existing.get("status") == "unreadable"
                    else "checkout_activity_in_use"
                    if existing.get("status") == "active"
                    else "checkout_activity_pending_snapshot"
                ),
                "activity_reservation",
                destination=cwd,
                owner_key=owner_key,
                observed_owner=(existing.get("records") or [{}])[0].get(
                    "owner_key"
                ),
                guidance=(
                    "A worker is using this checkout, or its stopped state still "
                    "needs an exact snapshot. Orcha preserved the checkout and did "
                    "not start another writer."
                ),
                details={"activity_status": existing.get("status")},
            )
        if checkout_guard is not None:
            guarded = checkout_guard(cwd, cwd)
            if guarded is not None and not guarded.ok:
                return guarded
        before_fingerprint = checkout_state_fingerprint(cwd, services)
        if before_fingerprint is None:
            return _result(
                False,
                "checkout_activity_fingerprint_failed",
                "activity_reservation",
                destination=cwd,
                owner_key=owner_key,
                guidance=(
                    "Orcha could not fingerprint the checkout before routing, so "
                    "it did not start a worker or change ownership proof."
                ),
            )
        path = _checkout_activity_path(cwd, services)
        if path is None:
            return _result(
                False,
                "checkout_activity_path_unavailable",
                "activity_reservation",
                destination=cwd,
                owner_key=owner_key,
                guidance="Git-private reservation storage is unavailable; no worker was started.",
            )
        descriptor = None
        handle = None
        created = False
        try:
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            try:
                path.parent.chmod(0o700)
            except OSError:
                pass
            flags = (
                os.O_CREAT
                | os.O_EXCL
                | os.O_RDWR
                | getattr(os, "O_NOFOLLOW", 0)
            )
            descriptor = os.open(path, flags, 0o600)
            created = True
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode):
                raise OSError("checkout activity record is not a regular file")
            import fcntl

            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            handle = os.fdopen(descriptor, "r+b", buffering=0)
            descriptor = None
            activity = CheckoutActivityReservation(
                checkout=str(pathlib.Path(cwd).resolve()),
                owner_key=owner_key,
                reservation_id=secrets.token_hex(16),
                path=path,
                handle=handle,
                created_at=time.time(),
                phase="routing",
                before_fingerprint=before_fingerprint,
            )
            if not _write_activity_handle(activity):
                raise OSError("could not persist checkout activity record")
            return activity
        except (ImportError, OSError, ValueError):
            if handle is not None:
                try:
                    handle.close()
                except OSError:
                    pass
            if descriptor is not None:
                try:
                    os.close(descriptor)
                except OSError:
                    pass
            if created:
                try:
                    path.unlink()
                except OSError:
                    pass
            return _result(
                False,
                "checkout_activity_reservation_failed",
                "activity_reservation",
                destination=cwd,
                owner_key=owner_key,
                guidance="Orcha could not create durable checkout-use proof; no worker was started.",
            )


def bind_checkout_activity(
    activity,
    *,
    run_id=None,
    pid=None,
    sandbox_container_id=None,
) -> bool:
    """Add non-secret process/run identity while the reservation is held."""
    if not isinstance(activity, CheckoutActivityReservation):
        return activity is None
    previous = (
        activity.phase,
        activity.run_id,
        activity.pid,
        activity.sandbox_container_id,
    )
    if run_id is not None:
        activity.run_id = str(run_id)
        activity.phase = "run_bound"
    if pid is not None:
        activity.pid = int(pid)
        if run_id is None:
            activity.phase = "writer_started"
    if sandbox_container_id is not None:
        activity.sandbox_container_id = str(sandbox_container_id)
    if _write_activity_handle(activity):
        return True
    (
        activity.phase,
        activity.run_id,
        activity.pid,
        activity.sandbox_container_id,
    ) = previous
    return False


def mark_checkout_activity_routed(
    activity,
    services: Any,
    *,
    source=None,
    patch_sha256=None,
) -> bool:
    """Persist the exact post-handoff boundary before any writer is spawned."""
    if not isinstance(activity, CheckoutActivityReservation):
        return activity is None
    if activity.phase != "routing":
        return False
    routed = checkout_state_fingerprint(activity.checkout, services)
    if routed is None:
        return False
    previous = (
        activity.phase,
        activity.routed_fingerprint,
        activity.routing_source,
        activity.routing_patch_sha256,
    )
    activity.phase = "routed"
    activity.routed_fingerprint = routed
    activity.routing_source = str(source) if source is not None else None
    activity.routing_patch_sha256 = (
        str(patch_sha256) if patch_sha256 is not None else None
    )
    if _write_activity_handle(activity):
        return True
    (
        activity.phase,
        activity.routed_fingerprint,
        activity.routing_source,
        activity.routing_patch_sha256,
    ) = previous
    return False


def _archive_activity_record(path: pathlib.Path, raw: bytes) -> bool:
    temporary = None
    try:
        checkout_key = path.stem
        digest = hashlib.sha256(raw).hexdigest()
        archive = (
            path.parent.parent
            / "archive"
            / "activity"
            / checkout_key
            / f"{digest}.json"
        )
        if archive.is_file():
            return archive.read_bytes() == raw
        archive.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            archive.parent.chmod(0o700)
        except OSError:
            pass
        fd, temporary = tempfile.mkstemp(prefix=f".{archive.name}.", dir=archive.parent)
        os.close(fd)
        pathlib.Path(temporary).write_bytes(raw)
        os.replace(temporary, archive)
        temporary = None
        return archive.read_bytes() == raw
    except OSError:
        return False
    finally:
        if temporary:
            try:
                pathlib.Path(temporary).unlink()
            except OSError:
                pass


def _release_checkout_activity_locked(
    cwd,
    services: Any,
    *,
    activity=None,
    reservation_id=None,
    run_id=None,
) -> HandoffResult:
    """Archive and remove a stopped reservation while holding the repo barrier."""
    path = _checkout_activity_path(cwd, services)
    if path is None:
        return _result(
            False,
            "checkout_activity_path_unavailable",
            "activity_release",
            source=cwd,
            guidance="Reservation storage is unavailable; stopped-state proof was retained for retry.",
        )
    if isinstance(activity, CheckoutActivityReservation):
        reservation_id = activity.reservation_id
        try:
            activity.handle.close()
        except (OSError, ValueError):
            pass
    if not path.exists():
        return _result(
            True,
            "checkout_activity_absent",
            "activity_release",
            source=cwd,
            guidance="No checkout activity reservation remains.",
        )
    descriptor, record = _read_activity_record(path)
    if descriptor is None or record is None:
        return _result(
            False,
            "checkout_activity_unreadable",
            "activity_release",
            source=cwd,
            guidance="The checkout activity proof is unreadable and was preserved for review.",
        )
    try:
        matches = (
            reservation_id is not None
            and record.get("reservation_id") == str(reservation_id)
        ) or (
            run_id is not None
            and record.get("run_id") is not None
            and str(record.get("run_id")) == str(run_id)
        )
        if not matches:
            return _result(
                False,
                "checkout_activity_identity_conflict",
                "activity_release",
                source=cwd,
                observed_owner=record.get("owner_key"),
                guidance="A different activity owns this checkout proof; it was left untouched.",
            )
        try:
            import fcntl

            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (ImportError, BlockingIOError, OSError):
            return _result(
                False,
                "checkout_activity_still_live",
                "activity_release",
                source=cwd,
                observed_owner=record.get("owner_key"),
                guidance="The worker still holds its checkout reservation; snapshot finalization will retry.",
            )
        phase = record.get("phase")
        if phase in {"routing", "routed"}:
            expected = (
                record.get("before_fingerprint")
                if phase == "routing"
                else record.get("routed_fingerprint")
            )
            if not _activity_fingerprint_matches(cwd, expected, services):
                return _result(
                    False,
                    (
                        "checkout_routing_interrupted"
                        if phase == "routing"
                        else "checkout_routed_state_changed"
                    ),
                    "activity_release",
                    source=cwd,
                    observed_owner=record.get("owner_key"),
                    guidance=(
                        "The checkout no longer matches the exact state recorded "
                        "at this start phase. Orcha preserved the reservation, "
                        "files, and ownership proof for project-owner review."
                    ),
                    details={"activity_phase": phase},
                )
        os.lseek(descriptor, 0, os.SEEK_SET)
        raw = b""
        while True:
            chunk = os.read(descriptor, 64 * 1024)
            if not chunk:
                break
            raw += chunk
        if not _archive_activity_record(path, raw):
            return _result(
                False,
                "checkout_activity_archive_failed",
                "activity_release",
                source=cwd,
                guidance="The reservation could not be archived, so it remains in place.",
            )
        current = os.stat(path, follow_symlinks=False)
        opened = os.fstat(descriptor)
        if (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino):
            return _result(
                False,
                "checkout_activity_changed",
                "activity_release",
                source=cwd,
                guidance="The reservation changed during finalization and was preserved.",
            )
        path.unlink()
        return _result(
            True,
            "checkout_activity_released",
            "activity_release",
            source=cwd,
            observed_owner=record.get("owner_key"),
            guidance="The stopped checkout reservation was archived and released.",
            mutated=True,
        )
    except OSError:
        return _result(
            False,
            "checkout_activity_release_failed",
            "activity_release",
            source=cwd,
            guidance="The stopped checkout reservation was preserved for retry.",
        )
    finally:
        try:
            os.close(descriptor)
        except OSError:
            pass


def release_checkout_activity(
    cwd,
    services: Any,
    *,
    activity=None,
    reservation_id=None,
    run_id=None,
) -> HandoffResult:
    """Release only after the worker is stopped and state is preserved."""
    with _handoff_mutation_lock(cwd, services) as acquired:
        if not acquired:
            return _result(
                False,
                "handoff_lock_unavailable",
                "activity_release",
                source=cwd,
                guidance="Another checkout operation is active; reservation release will retry.",
            )
        return _release_checkout_activity_locked(
            cwd,
            services,
            activity=activity,
            reservation_id=reservation_id,
            run_id=run_id,
        )


def _snapshot_matches_checkout(cwd, record: dict, services: Any):
    """Re-read a snapshot's source and prove that its exact view still exists."""
    base_oid = _origin_main_oid(cwd, services)
    diagnostics = {}
    patch = None
    if base_oid is not None:
        patch = _full_patch(
            cwd,
            services,
            include_ignored=True,
            base_ref=base_oid,
            max_paths=HANDOFF_MAX_PATHS,
            max_bytes=HANDOFF_MAX_PATCH_BYTES,
            diagnostics=diagnostics,
        )
    if base_oid is None or patch is None:
        return "unreadable", patch, base_oid, diagnostics
    if (
        base_oid != record.get("origin_main_oid")
        or patch != record.get("patch")
        or _patch_digest(patch) != record.get("patch_sha256")
        or len(_patch_bytes(patch)) != record.get("patch_bytes")
    ):
        return "mismatch", patch, base_oid, diagnostics
    return "match", patch, base_oid, diagnostics


def handoff_record_bytes(cwd, services: Any):
    """Return raw ownership proof for preservation tests and diagnostics."""
    try:
        path = _handoff_record_path(cwd, services)
        return path.read_bytes() if path is not None and path.is_file() else None
    except OSError:
        return None


def _archive_handoff_record(cwd, raw: bytes, services: Any) -> bool:
    """Preserve a checkout-wide owner record before it is replaced."""
    temporary = None
    try:
        common_path = _git_common_path(cwd, services)
        if common_path is None:
            return False
        digest = hashlib.sha256(raw).hexdigest()
        path = (
            common_path
            / "orcha"
            / "handoffs"
            / "archive"
            / "records"
            / _checkout_metadata_key(cwd)
            / f"{digest}.patch"
        )
        if path.is_file():
            return path.read_bytes() == raw
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        os.close(fd)
        pathlib.Path(temporary).write_bytes(raw)
        os.replace(temporary, path)
        temporary = None
        return path.read_bytes() == raw
    except OSError:
        return False
    finally:
        if temporary:
            try:
                pathlib.Path(temporary).unlink()
            except OSError:
                pass


def _restore_handoff_record(cwd, raw: bytes | None, services: Any) -> bool:
    """Roll a provisional owner-record write back to its exact prior bytes."""
    temporary = None
    try:
        path = _handoff_record_path(cwd, services)
        if path is None:
            return False
        current = path.read_bytes() if path.is_file() else None
        if current is not None and current != raw:
            if not _archive_handoff_record(cwd, current, services):
                return False
        if raw is None:
            if path.exists():
                path.unlink()
            return True
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        os.close(fd)
        pathlib.Path(temporary).write_bytes(raw)
        os.replace(temporary, path)
        temporary = None
        return path.read_bytes() == raw
    except OSError:
        return False
    finally:
        if temporary:
            try:
                pathlib.Path(temporary).unlink()
            except OSError:
                pass


def _read_handoff_record(cwd, services: Any):
    """Read the stream owner and exact patch previously placed by Orcha."""
    try:
        path = _handoff_record_path(cwd, services)
        if path is None or not path.is_file():
            return None
        raw = path.read_text()
        try:
            record = json.loads(raw)
        except json.JSONDecodeError:
            # Records written before ownership scoping contained only a patch.
            # Treat them as unowned so dirty state fails closed instead of being
            # attributed to whichever stream happens to arrive next.
            if raw.lstrip().startswith(("{", "[")):
                return {"invalid": True, "owner_key": None, "patch": None}
            return {"owner_key": None, "patch": raw}
        if not isinstance(record, dict) or not isinstance(record.get("patch"), str):
            return {"invalid": True, "owner_key": None, "patch": None}
        return {
            "owner_key": record.get("owner_key"),
            "patch": record["patch"],
        }
    except (OSError, UnicodeError):
        return None


def _write_handoff_record(cwd, owner_key: str, patch: str, services: Any) -> bool:
    """Atomically remember the stream and state Orcha owns in a checkout."""
    temporary = None
    try:
        path = _handoff_record_path(cwd, services)
        if path is None:
            return False
        raw = json.dumps(
            {"version": 2, "owner_key": owner_key, "patch": patch},
            separators=(",", ":"),
        ).encode("utf-8", "surrogateescape")
        previous = path.read_bytes() if path.is_file() else None
        if previous == raw:
            return True
        if previous is not None and not _archive_handoff_record(
            cwd, previous, services
        ):
            return False
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        os.close(fd)
        pathlib.Path(temporary).write_bytes(raw)
        os.replace(temporary, path)
        temporary = None
        return True
    except OSError:
        return False
    finally:
        if temporary:
            try:
                pathlib.Path(temporary).unlink()
            except OSError:
                pass


def _is_linked_worktree(cwd) -> bool:
    """Return whether this is a dedicated linked worktree rather than main."""
    try:
        return pathlib.Path(cwd, ".git").is_file()
    except OSError:
        return False


def _replace_managed_patch(
    cwd, managed: str, desired: str, owner_key: str, services: Any
) -> bool:
    """Replace only Orcha-owned state while preserving independent destination work."""
    if managed.strip() and not _apply_patch(cwd, managed, services, reverse=True):
        return False

    if desired.strip() and not _apply_patch(cwd, desired, services):
        if managed.strip():
            _apply_patch(cwd, managed, services)
        return False

    if _write_handoff_record(cwd, owner_key, desired, services):
        return True

    # A record is required before this state can be safely reconciled again.
    # Restore the original destination if persisting that ownership proof fails.
    if desired.strip():
        _apply_patch(cwd, desired, services, reverse=True)
    if managed.strip():
        _apply_patch(cwd, managed, services)
    return False


def printable(text):
    """Return text safe to serialise as JSON (surrogate-escaped bytes replaced)."""
    if text is None:
        return None
    return text.encode("utf-8", "surrogateescape").decode("utf-8", "replace")


def capture_diff(worktree, services: Any, cap: int = 200_000):
    """Return the worker's net diff from main, including untracked files."""
    if not worktree:
        return None
    output = _full_patch(worktree, services)
    if output is None:
        return None
    return bounded_printable_diff(output, cap=cap)


def bounded_printable_diff(output: str, cap: int = 200_000):
    """Return a bounded display copy of an already captured exact patch."""
    if len(output) > cap:
        output = output[:cap] + "\n...[diff truncated]..."
    return printable(output)


def record_checkout_stream_snapshot(
    cwd, owner_key: str, services: Any, *, run_id=None
) -> HandoffResult:
    """Archive an exact stream view without changing checkout ownership or files.

    Callers must establish that this stream is stopped. Two identical captures
    and a stable base commit are required, so an active sibling cannot make a
    torn or transient view authoritative. This records provenance only; it never
    relabels the checkout-wide owner record.
    """
    if not cwd or not owner_key or not run_id:
        return _result(
            False,
            "snapshot_identity_missing",
            "source_snapshot",
            source=cwd,
            owner_key=owner_key,
            guidance=(
                "A checkout path, logical stream owner, and stopped run are "
                "required before provenance can be archived."
            ),
        )
    base_oid = _origin_main_oid(cwd, services)
    patch, capture_diagnostics = _handoff_patch(
        cwd, services, base_ref=base_oid or "origin/main"
    )
    confirmed_patch, confirmed_diagnostics = _handoff_patch(
        cwd, services, base_ref=base_oid or "origin/main"
    )
    confirmed_base_oid = _origin_main_oid(cwd, services)
    if patch is None or confirmed_patch is None or base_oid is None:
        limit_code = next(
            (
                item.get("code")
                for item in (capture_diagnostics, confirmed_diagnostics)
                if item.get("code") in {"patch_paths_exceeded", "patch_bytes_exceeded"}
            ),
            None,
        )
        return _result(
            False,
            "snapshot_capture_limit" if limit_code else "source_capture_failed",
            "source_snapshot",
            source=cwd,
            owner_key=owner_key,
            guidance=(
                "The complete shared-checkout view exceeds the safe snapshot limit; "
                "it was left in place for human reconciliation."
                if limit_code
                else "Orcha could not read the complete source checkout; leave it untouched and inspect repository access."
            ),
            details={
                "capture": capture_diagnostics,
                "confirmation": confirmed_diagnostics,
            },
        )
    if patch != confirmed_patch or base_oid != confirmed_base_oid:
        return _result(
            False,
            "source_changed_during_snapshot",
            "source_snapshot",
            source=cwd,
            owner_key=owner_key,
            patch=confirmed_patch,
            guidance=(
                "The shared checkout changed while Orcha was reading it. No "
                "snapshot was trusted; retry only after active writers stop."
            ),
        )
    if not _write_stream_snapshot(
        cwd,
        owner_key,
        patch,
        services,
        run_id=run_id,
        base_oid=base_oid,
    ):
        return _result(
            False,
            "snapshot_write_failed",
            "source_snapshot",
            source=cwd,
            owner_key=owner_key,
            patch=patch,
            guidance="Orcha could not archive source provenance; the checkout was left unchanged.",
        )
    return _result(
        True,
        "snapshot_recorded",
        "source_snapshot",
        source=cwd,
        owner_key=owner_key,
        patch=patch,
        guidance="The exact stream snapshot is archived in Git's private metadata.",
        mutated=True,
        details={"captured_diff": bounded_printable_diff(patch)},
    )


def _status_paths(cwd, services: Any):
    """Paths with any change in ``cwd`` (tracked, untracked, ignored) — one git call."""
    return_code, output = services._run_git(
        [
            "status",
            "--porcelain=v1",
            "-z",
            "--ignored",
            "--untracked-files=all",
            "--",
            *DIFF_EXCLUDES,
            # Linked worktrees nested under the main checkout are separate
            # checkouts, never part of this checkout's file state (ls-files, which
            # builds the patches, never descends into them either).
            ":(exclude).orcha-worktrees",
        ],
        cwd=cwd,
        timeout=60,
    )
    if return_code != 0:
        return None
    # Patches are taken against origin/main, so commits on the checkout's own
    # branch count as state too (they are invisible to `git status`).
    committed_code, committed = services._run_git(
        ["diff", "--name-only", "-z", "origin/main", "--", *DIFF_EXCLUDES],
        cwd=cwd,
        timeout=60,
    )
    if committed_code != 0:
        return None
    paths = {path for path in committed.split("\0") if path}
    entries = output.split("\0")
    index = 0
    while index < len(entries):
        entry = entries[index]
        index += 1
        if len(entry) < 4:
            continue
        status = entry[:2]
        path = entry[3:]
        # Runtime caches and container-wide records are deliberately excluded
        # from a stream's portable handoff patch.  Ignore those paths here only
        # when Git confirms they are ignored files; a tracked or ordinary
        # untracked path with the same name must still make the destination
        # dirty.  Substantive ignored files (for example a stream-private
        # credential or generated artifact) remain part of the exact snapshot.
        if status == "!!" and _non_portable_ignored_path(path):
            continue
        paths.add(path)
        if entry[0] in "RC":
            # Rename/copy entries carry the original path as the next NUL field.
            index += 1
    # Older Git (e.g. 2.39 on Debian) still reports a nested linked worktree as
    # "!! .orcha-worktrees/<name>/" despite the exclude pathspec above.
    return {
        path
        for path in paths
        if not path.startswith(NESTED_WORKTREES_PREFIX)
    }


def _patch_paths(patch: str):
    """File paths a unified patch touches (``diff --git a/X b/X`` headers)."""
    paths = set()
    for line in (patch or "").splitlines():
        if line.startswith("diff --git a/"):
            rest = line[len("diff --git a/"):]
            split = rest.rfind(" b/")
            if split > 0:
                paths.add(rest[:split])
    return paths


def inspect_handoff(
    source_cwd,
    destination_cwd,
    services: Any,
    *,
    owner_key: str | None = None,
    source_owner_verified: bool = False,
    snapshot_run_id=None,
) -> HandoffResult:
    """Build a complete, non-mutating handoff preflight."""
    owner_key = owner_key or "legacy-unscoped"
    if not source_cwd or not destination_cwd:
        return _result(
            False,
            "checkout_path_missing",
            "routing",
            source=source_cwd,
            destination=destination_cwd,
            owner_key=owner_key,
            guidance="Both the saved source and selected destination are required.",
        )
    try:
        source = pathlib.Path(source_cwd).resolve()
        destination = pathlib.Path(destination_cwd).resolve()
    except OSError:
        return _result(
            False,
            "checkout_path_unreadable",
            "routing",
            source=source_cwd,
            destination=destination_cwd,
            owner_key=owner_key,
            guidance="Orcha could not resolve one checkout path; both were left untouched.",
        )
    source_overlap = checkout_overlap_evidence(source, services)
    source_overlap_status = source_overlap.get("status")
    if source == destination and source_overlap_status != "none":
        return _result(
            False,
            (
                "source_overlap_evidence_unreadable"
                if source_overlap_status == "unreadable"
                else "source_shared_overlap_unresolved"
            ),
            "source_provenance",
            source=source,
            destination=destination,
            owner_key=owner_key,
            guidance=(
                "This checkout has unresolved proof that multiple streams shared "
                "its files. It remains preserved, and no worker should resume in "
                "it until the project owner reconciles the saved states."
            ),
            details={
                "overlap_status": source_overlap_status,
                "overlap_evidence_count": source_overlap.get("evidence_count", 0),
            },
        )
    if source == destination:
        return _result(
            True,
            "same_checkout",
            "routing",
            source=source,
            destination=destination,
            owner_key=owner_key,
            guidance="The stream is already routed to the selected checkout.",
        )

    source_record = _read_handoff_record(source, services)
    if source_record is not None and source_record.get("invalid"):
        return _result(
            False,
            "source_owner_record_invalid",
            "source_provenance",
            source=source,
            destination=destination,
            owner_key=owner_key,
            guidance=(
                "The source ownership record is corrupt or incomplete. It was "
                "preserved unchanged; ask the project owner which state should resume."
            ),
        )
    observed_owner = source_record.get("owner_key") if source_record else None
    source_proof = None
    snapshot_record = None
    snapshot_status, snapshot_record = _stream_snapshot_status(
        source, owner_key, snapshot_run_id, services
    )
    if snapshot_status == "match":
        # The immutable, run-bound sidecar is the source of truth for this
        # stopped stream. Shared main may now hold a different owner's later
        # state; re-reading it here would either misattribute that state or
        # recreate the foreign-owner deadlock this sidecar prevents.
        patch = snapshot_record["patch"]
        snapshot_base_oid = snapshot_record["origin_main_oid"]
        source_proof = (
            "stopped_run_snapshot_foreign_owner"
            if source_record is not None and observed_owner != owner_key
            else "stopped_run_snapshot"
        )
    elif source_overlap_status != "none":
        return _result(
            False,
            (
                "source_overlap_evidence_unreadable"
                if source_overlap_status == "unreadable"
                else "source_shared_overlap_unresolved"
            ),
            "source_provenance",
            source=source,
            destination=destination,
            owner_key=owner_key,
            observed_owner=observed_owner,
            guidance=(
                "Durable proof shows that overlapping streams shared the source "
                "checkout, and this stream has no exact stopped-run snapshot. "
                "All files and ownership proof were preserved for project-owner "
                "reconciliation."
            ),
            details={
                "overlap_status": source_overlap_status,
                "overlap_evidence_count": source_overlap.get("evidence_count", 0),
                "snapshot_status": snapshot_status,
                "snapshot_run_id": str(snapshot_run_id) if snapshot_run_id else None,
            },
        )
    elif source_record is not None and observed_owner != owner_key:
        code = (
            "source_snapshot_unreadable"
            if snapshot_status == "unreadable" and snapshot_run_id
            else "foreign_source_owner"
        )
        reason = (
            "The exact stopped-run snapshot is missing for this stream."
            if snapshot_status == "missing"
            else "This stream's stopped-run snapshot could not be validated."
        )
        return _result(
            False,
            code,
            "source_provenance",
            source=source,
            destination=destination,
            owner_key=owner_key,
            observed_owner=observed_owner,
            guidance=(
                f"{reason} The foreign ownership proof and source checkout were "
                "preserved; run the non-mutating handoff preflight and ask the "
                "project owner which saved state to resume."
            ),
            details={
                "snapshot_status": snapshot_status,
                "snapshot_run_id": str(snapshot_run_id) if snapshot_run_id else None,
            },
        )
    else:
        snapshot_base_oid = None
        current_base_oid = _origin_main_oid(source, services)
        patch, capture_diagnostics = _handoff_patch(
            source, services, base_ref=current_base_oid or "origin/main"
        )
        if patch is None or current_base_oid is None:
            return _result(
                False,
                (
                    "source_capture_limit"
                    if capture_diagnostics.get("code")
                    in {"patch_paths_exceeded", "patch_bytes_exceeded"}
                    else "source_capture_failed"
                ),
                "source_capture",
                source=source,
                destination=destination,
                owner_key=owner_key,
                observed_owner=observed_owner,
                guidance=(
                    "The complete source exceeds the safe handoff capture limit; it "
                    "was left untouched for human reconciliation."
                    if capture_diagnostics.get("code")
                    in {"patch_paths_exceeded", "patch_bytes_exceeded"}
                    else "Orcha could not read the complete source checkout; inspect repository access and leave both checkouts untouched."
                ),
                details={"capture": capture_diagnostics},
            )
        if _is_linked_worktree(source) and source_owner_verified:
            source_proof = "verified_linked_worktree"
        elif source_record is not None and observed_owner == owner_key:
            if source_record.get("patch") != patch:
                return _result(
                    False,
                    "source_owner_record_mismatch",
                    "source_provenance",
                    source=source,
                    destination=destination,
                    owner_key=owner_key,
                    observed_owner=observed_owner,
                    patch=patch,
                    guidance=(
                        "The source changed after its checkout-wide ownership proof "
                        "was saved, and there is no exact stopped-run snapshot. Both "
                        "checkouts and the prior proof were preserved."
                    ),
                )
            source_proof = "checkout_owner_record"
        else:
            return _result(
                False,
                "source_provenance_missing",
                "source_provenance",
                source=source,
                destination=destination,
                owner_key=owner_key,
                observed_owner=observed_owner,
                patch=patch,
                guidance=(
                    "Run history identifies the source path, but there is no exact "
                    "saved-state proof for this stream. Leave it untouched and ask "
                    "the project owner which state should resume."
                ),
                details={"run_history_matches_path": bool(source_owner_verified)},
            )

    if snapshot_base_oid is not None:
        destination_base_oid = _origin_main_oid(destination, services)
        if destination_base_oid != snapshot_base_oid:
            return _result(
                False,
                "snapshot_base_moved",
                "destination_provenance",
                source=source,
                destination=destination,
                owner_key=owner_key,
                observed_owner=observed_owner,
                patch=patch,
                guidance=(
                    "The saved stream snapshot and destination use different base "
                    "commits. Both were preserved; reconcile the upstream change "
                    "explicitly instead of applying an ambiguous patch."
                ),
                details={
                    "snapshot_base_oid": snapshot_base_oid,
                    "destination_base_oid": destination_base_oid,
                },
            )

    destination_overlap = checkout_overlap_evidence(destination, services)
    if destination_overlap.get("status") != "none":
        return _result(
            False,
            (
                "destination_overlap_evidence_unreadable"
                if destination_overlap.get("status") == "unreadable"
                else "destination_shared_overlap_unresolved"
            ),
            "destination_provenance",
            source=source,
            destination=destination,
            owner_key=owner_key,
            observed_owner=observed_owner,
            patch=patch,
            guidance=(
                "The destination has unresolved proof that multiple streams "
                "shared its files. It was left untouched for project-owner "
                "reconciliation."
            ),
            details={
                "overlap_status": destination_overlap.get("status"),
                "overlap_evidence_count": destination_overlap.get(
                    "evidence_count", 0
                ),
            },
        )
    destination_record = _read_handoff_record(destination, services)
    if destination_record is not None and destination_record.get("invalid"):
        return _result(
            False,
            "destination_owner_record_invalid",
            "destination_provenance",
            source=source,
            destination=destination,
            owner_key=owner_key,
            observed_owner=None,
            patch=patch,
            guidance=(
                "The destination ownership record is corrupt or incomplete. It and "
                "both checkouts were preserved for human reconciliation."
            ),
        )
    destination_owner = (
        destination_record.get("owner_key") if destination_record else None
    )
    changed = _status_paths(destination, services)
    if changed is None:
        return _result(
            False,
            "destination_status_failed",
            "destination_inspection",
            source=source,
            destination=destination,
            owner_key=owner_key,
            observed_owner=destination_owner,
            patch=patch,
            guidance="Orcha could not inspect the destination checkout; no files or ownership records were changed.",
        )
    if changed and destination_record is not None and destination_owner != owner_key:
        return _result(
            False,
            "destination_owned_by_other_stream",
            "destination_provenance",
            source=source,
            destination=destination,
            owner_key=owner_key,
            observed_owner=destination_owner,
            patch=patch,
            guidance="The destination contains state managed for a different stream; both checkouts were preserved.",
        )
    if changed and destination_record is None and not changed <= _patch_paths(patch):
        return _result(
            False,
            "destination_has_independent_changes",
            "destination_provenance",
            source=source,
            destination=destination,
            owner_key=owner_key,
            patch=patch,
            guidance="The destination has independent files. Commit, stash, or move those destination changes before retrying.",
            details={"changed_path_count": len(changed)},
        )

    destination_patch = ""
    if changed:
        destination_patch, destination_diagnostics = _handoff_patch(
            destination, services
        )
        if destination_patch is None:
            return _result(
                False,
                "destination_capture_failed",
                "destination_inspection",
                source=source,
                destination=destination,
                owner_key=owner_key,
                observed_owner=destination_owner,
                patch=patch,
                guidance=(
                    "The complete destination exceeds the safe handoff capture limit; "
                    "both checkouts were preserved."
                    if destination_diagnostics.get("code")
                    in {"patch_paths_exceeded", "patch_bytes_exceeded"}
                    else "Orcha could not read the complete destination checkout; both checkouts were preserved."
                ),
                details={"capture": destination_diagnostics},
            )
    managed_patch = (
        destination_record.get("patch")
        if destination_record is not None and destination_owner == owner_key
        else None
    )
    if destination_patch != patch and managed_patch is None and destination_patch.strip():
        return _result(
            False,
            "destination_has_independent_changes",
            "destination_provenance",
            source=source,
            destination=destination,
            owner_key=owner_key,
            observed_owner=destination_owner,
            patch=patch,
            guidance="The destination has independent state that Orcha cannot safely replace; commit, stash, or move it before retrying.",
        )

    ready_code = (
        "ready_from_stream_snapshot"
        if source_proof.startswith("stopped_run_snapshot")
        else "ready"
    )
    return _result(
        True,
        ready_code,
        "preflight",
        source=source,
        destination=destination,
        owner_key=owner_key,
        observed_owner=observed_owner,
        patch=patch,
        guidance="The exact source provenance and destination state are safe to reconcile.",
        details={
            "source_proof": source_proof,
            "source_snapshot_run_id": (
                snapshot_record.get("run_id") if snapshot_record else None
            ),
            "destination_owner": destination_owner,
            "destination_patch_sha256": _patch_digest(destination_patch),
            "changed_path_count": len(changed),
        },
    )


def _place_handoff_patch(
    destination_cwd, patch: str, owner_key: str, services: Any
) -> bool:
    """Safely reconcile one known stream's patch into its destination checkout."""
    # A developer's main checkout can hold tens of thousands of ignored files
    # (virtualenvs, node_modules). Diffing each of them against /dev/null takes
    # minutes and starves every wake, so decide from one `git status` first and
    # only build the destination's exact patch when the outcome depends on it.
    destination_record = _read_handoff_record(destination_cwd, services)
    changed = _status_paths(destination_cwd, services)
    if changed is None:
        return False
    if not changed:
        destination_patch = ""
    else:
        if destination_record is not None and destination_record.get(
            "owner_key"
        ) != owner_key:
            return False
        if destination_record is None and not changed <= _patch_paths(patch):
            # Independent work exists that this stream's patch does not even
            # mention; it can never be an identical state, so never touch it.
            return False
        destination_patch = _full_patch(
            destination_cwd, services, include_ignored=True
        )
        if destination_patch is None:
            return False

    if (
        destination_record is not None
        and destination_record.get("owner_key") != owner_key
        and destination_patch.strip()
    ):
        return False
    managed_patch = (
        destination_record.get("patch")
        if destination_record is not None
        and destination_record.get("owner_key") == owner_key
        else None
    )
    if destination_patch == patch:
        can_manage_destination = (
            not destination_patch.strip()
            or _is_linked_worktree(destination_cwd)
            or managed_patch is not None
        )
        return not can_manage_destination or _write_handoff_record(
            destination_cwd, owner_key, patch, services
        )

    if managed_patch is None:
        if destination_patch.strip():
            return False
        transferred = _replace_patch(
            destination_cwd, destination_patch, patch, services
        )
        if not transferred:
            return False
        if not _write_handoff_record(destination_cwd, owner_key, patch, services):
            if patch.strip():
                _apply_patch(destination_cwd, patch, services, reverse=True)
            return False
    else:
        if not destination_patch.strip():
            managed_patch = ""
        if not _replace_managed_patch(
            destination_cwd, managed_patch, patch, owner_key, services
        ):
            return False
    return True


def _handoff_changes_result_locked(
    source_cwd,
    destination_cwd,
    services: Any,
    *,
    owner_key: str | None = None,
    source_owner_verified: bool = False,
    snapshot_run_id=None,
    checkout_guard=None,
) -> HandoffResult:
    """Carry a worker's complete in-progress state into a newly selected checkout.

    The patch is based on ``origin/main`` so it includes both commits made on a
    worker branch and uncommitted files. A complete dry run must succeed before
    each patch operation touches the destination. On any conflict or I/O error,
    the caller can stop the replacement worker while leaving the source checkout
    intact.
    """
    owner_key = owner_key or "legacy-unscoped"
    plan = inspect_handoff(
        source_cwd,
        destination_cwd,
        services,
        owner_key=owner_key,
        source_owner_verified=source_owner_verified,
        snapshot_run_id=snapshot_run_id,
    )
    if not plan.ok or plan.code == "same_checkout":
        return plan
    try:
        source_path = pathlib.Path(source_cwd).resolve()
        destination_path = pathlib.Path(destination_cwd).resolve()
    except OSError:
        return _result(
            False,
            "checkout_path_unreadable",
            "apply_revalidation",
            source=source_cwd,
            destination=destination_cwd,
            owner_key=owner_key,
            guidance="A checkout path became unreadable after preflight; nothing was changed.",
        )

    source_proof = plan.details.get("source_proof") or ""
    if source_proof.startswith("stopped_run_snapshot"):
        snapshot_status, snapshot_record = _stream_snapshot_status(
            source_cwd, owner_key, snapshot_run_id, services
        )
        if snapshot_status != "match":
            return _result(
                False,
                "snapshot_changed_since_preflight",
                "apply_revalidation",
                source=source_path,
                destination=destination_path,
                owner_key=owner_key,
                guidance=(
                    "The stopped-run snapshot could not be revalidated. Both "
                    "checkouts and all ownership proof were left untouched."
                ),
            )
        patch = snapshot_record["patch"]
    else:
        patch, capture_diagnostics = _handoff_patch(source_cwd, services)
        if patch is None:
            return _result(
                False,
                "source_capture_failed",
                "apply_revalidation",
                source=source_path,
                destination=destination_path,
                owner_key=owner_key,
                guidance="The source could not be re-read after preflight; both checkouts were preserved.",
                details={"capture": capture_diagnostics},
            )
    if _patch_digest(patch) != plan.patch_sha256:
        return _result(
            False,
            "state_changed_since_preflight",
            "apply_revalidation",
            source=source_path,
            destination=destination_path,
            owner_key=owner_key,
            patch=patch,
            guidance="The source checkout changed during preflight; no destination files were changed. Retry after the active writer stops.",
        )

    if checkout_guard is not None:
        guard_result = checkout_guard(source_path, destination_path)
        if guard_result is not None and not guard_result.ok:
            return guard_result

    source_record = _read_handoff_record(source_cwd, services)
    source_record_before = handoff_record_bytes(source_cwd, services)
    foreign_source = bool(
        source_record is not None and source_record.get("owner_key") != owner_key
    )
    refresh_source_record = bool(
        not foreign_source
        and (
            _is_linked_worktree(source_cwd)
            or source_record is not None
            or source_proof in {"verified_linked_worktree", "linked_worktree"}
            or source_proof == "stopped_run_snapshot"
        )
    )
    if refresh_source_record and not _write_handoff_record(
        source_cwd, owner_key, patch, services
    ):
        return _result(
            False,
            "source_record_write_failed",
            "source_provenance",
            source=source_path,
            destination=destination_path,
            owner_key=owner_key,
            patch=patch,
            guidance="Orcha could not persist source ownership proof; the destination was left unchanged.",
        )

    destination_record_before = handoff_record_bytes(destination_cwd, services)
    if destination_record_before is not None and not _archive_handoff_record(
        destination_cwd, destination_record_before, services
    ):
        if refresh_source_record:
            _restore_handoff_record(source_cwd, source_record_before, services)
        return _result(
            False,
            "destination_record_archive_failed",
            "preservation_archive",
            source=source_path,
            destination=destination_path,
            owner_key=owner_key,
            patch=patch,
            guidance=(
                "The destination ownership proof could not be archived, so no "
                "destination files were changed."
            ),
        )

    if not _place_handoff_patch(destination_cwd, patch, owner_key, services):
        restored = True
        if refresh_source_record:
            restored = _restore_handoff_record(
                source_cwd, source_record_before, services
            )
        return _result(
            False,
            "destination_reconcile_failed",
            "destination_apply",
            source=source_path,
            destination=destination_path,
            owner_key=owner_key,
            patch=patch,
            guidance=(
                "Destination reconciliation failed after a safe preflight. Source "
                "files, destination files, and archived ownership proof remain "
                "preserved; run the non-mutating handoff preflight again before retrying."
            ),
            details={"source_owner_record_restored": restored},
        )
    return _result(
        True,
        "transferred",
        "complete",
        source=source_path,
        destination=destination_path,
        owner_key=owner_key,
        patch=patch,
        guidance="The exact saved file view is available in the selected checkout.",
        mutated=True,
        details={
            "source_proof": source_proof,
            "source_snapshot_run_id": (
                str(snapshot_run_id) if snapshot_run_id is not None else None
            ),
        },
    )


def handoff_changes_result(
    source_cwd,
    destination_cwd,
    services: Any,
    *,
    owner_key: str | None = None,
    source_owner_verified: bool = False,
    snapshot_run_id=None,
    checkout_guard=None,
) -> HandoffResult:
    """Serialize, revalidate, live-check, and apply one checkout handoff."""
    owner_key = owner_key or "legacy-unscoped"
    try:
        same_path = bool(source_cwd and destination_cwd) and (
            pathlib.Path(source_cwd).resolve()
            == pathlib.Path(destination_cwd).resolve()
        )
    except OSError:
        same_path = False
    if same_path and _outside_git(destination_cwd, services):
        # A respawn in the same non-Git checkout moves nothing and has no Git
        # metadata to lock or record; the live guard still applies.
        if checkout_guard is not None:
            guarded = checkout_guard(source_cwd, destination_cwd)
            if guarded is not None and not guarded.ok:
                return guarded
        return _result(
            True,
            "same_checkout",
            "routing",
            source=source_cwd,
            destination=destination_cwd,
            owner_key=owner_key,
            guidance="The worker continues in the same checkout; nothing was moved.",
        )
    with _handoff_mutation_lock(destination_cwd, services) as acquired:
        if not acquired:
            return _result(
                False,
                "handoff_lock_unavailable",
                "apply_lock",
                source=source_cwd,
                destination=destination_cwd,
                owner_key=owner_key,
                guidance=(
                    "Another checkout reconciliation may be in progress, or the "
                    "repository lock could not be opened. No checkout was changed."
                ),
            )
        return _handoff_changes_result_locked(
            source_cwd,
            destination_cwd,
            services,
            owner_key=owner_key,
            source_owner_verified=source_owner_verified,
            snapshot_run_id=snapshot_run_id,
            checkout_guard=checkout_guard,
        )


def handoff_changes(
    source_cwd,
    destination_cwd,
    services: Any,
    *,
    owner_key: str | None = None,
    source_owner_verified: bool = False,
    snapshot_run_id=None,
    checkout_guard=None,
) -> bool:
    """Boolean compatibility wrapper around :func:`handoff_changes_result`."""
    return handoff_changes_result(
        source_cwd,
        destination_cwd,
        services,
        owner_key=owner_key,
        source_owner_verified=source_owner_verified,
        snapshot_run_id=snapshot_run_id,
        checkout_guard=checkout_guard,
    ).ok


def handoff_branch_changes(
    base_cwd,
    branch,
    destination_cwd,
    services: Any,
    *,
    owner_key: str | None = None,
    checkout_guard=None,
) -> bool:
    """Boolean compatibility wrapper for retained-branch reconciliation."""
    return handoff_branch_changes_result(
        base_cwd,
        branch,
        destination_cwd,
        services,
        owner_key=owner_key,
        checkout_guard=checkout_guard,
    ).ok


def handoff_branch_changes_result(
    base_cwd,
    branch,
    destination_cwd,
    services: Any,
    *,
    owner_key: str | None = None,
    checkout_guard=None,
) -> HandoffResult:
    """Carry committed state from a retained branch with an exact outcome."""
    owner_key = owner_key or "legacy-unscoped"
    if not base_cwd or not branch or not destination_cwd:
        return _result(
            False,
            "retained_branch_path_missing",
            "source_recovery",
            source=base_cwd,
            destination=destination_cwd,
            owner_key=owner_key,
            guidance="The retained branch or destination path is missing; nothing was changed.",
        )
    patch = _branch_patch(base_cwd, branch, services)
    if patch is None:
        return _result(
            False,
            "retained_branch_unreadable",
            "source_recovery",
            source=base_cwd,
            destination=destination_cwd,
            owner_key=owner_key,
            guidance="Orcha could not read the retained branch; the branch and destination were preserved.",
        )
    with _handoff_mutation_lock(destination_cwd, services) as acquired:
        if not acquired:
            return _result(
                False,
                "handoff_lock_unavailable",
                "apply_lock",
                source=base_cwd,
                destination=destination_cwd,
                owner_key=owner_key,
                patch=patch,
                guidance="Another reconciliation may be active; the retained branch and destination were left unchanged.",
            )
        if checkout_guard is not None:
            guarded = checkout_guard(base_cwd, destination_cwd)
            if guarded is not None and not guarded.ok:
                return guarded
        destination_record = _read_handoff_record(destination_cwd, services)
        if destination_record is not None and destination_record.get("invalid"):
            return _result(
                False,
                "destination_owner_record_invalid",
                "destination_provenance",
                source=base_cwd,
                destination=destination_cwd,
                owner_key=owner_key,
                patch=patch,
                guidance=(
                    "The destination ownership record is invalid. It, the "
                    "retained branch, and all destination files were preserved."
                ),
            )
        changed = _status_paths(destination_cwd, services)
        if changed is None:
            return _result(
                False,
                "destination_status_failed",
                "destination_inspection",
                source=base_cwd,
                destination=destination_cwd,
                owner_key=owner_key,
                patch=patch,
                guidance="Orcha could not inspect the destination; nothing was changed.",
            )
        if changed and destination_record is not None and destination_record.get(
            "owner_key"
        ) != owner_key:
            return _result(
                False,
                "destination_owned_by_other_stream",
                "destination_provenance",
                source=base_cwd,
                destination=destination_cwd,
                owner_key=owner_key,
                observed_owner=destination_record.get("owner_key"),
                patch=patch,
                guidance=(
                    "The destination contains state owned by another stream; the "
                    "retained branch and destination were preserved."
                ),
            )
        destination_patch = ""
        if changed:
            if destination_record is None and not changed <= _patch_paths(patch):
                return _result(
                    False,
                    "destination_has_independent_changes",
                    "destination_provenance",
                    source=base_cwd,
                    destination=destination_cwd,
                    owner_key=owner_key,
                    patch=patch,
                    guidance=(
                        "The destination has independent files; the retained "
                        "branch and destination were preserved."
                    ),
                )
            destination_patch = _full_patch(
                destination_cwd, services, include_ignored=True
            )
            if destination_patch is None:
                return _result(
                    False,
                    "destination_capture_failed",
                    "destination_inspection",
                    source=base_cwd,
                    destination=destination_cwd,
                    owner_key=owner_key,
                    patch=patch,
                    guidance="Orcha could not capture the destination; nothing was changed.",
                )
        managed_patch = (
            destination_record.get("patch")
            if destination_record is not None
            and destination_record.get("owner_key") == owner_key
            else None
        )
        if (
            destination_patch != patch
            and managed_patch is None
            and destination_patch.strip()
        ):
            return _result(
                False,
                "destination_has_independent_changes",
                "destination_provenance",
                source=base_cwd,
                destination=destination_cwd,
                owner_key=owner_key,
                patch=patch,
                guidance=(
                    "The destination has independent state; the retained branch "
                    "and destination were preserved."
                ),
            )
        destination_record_before = handoff_record_bytes(destination_cwd, services)
        if destination_record_before is not None and not _archive_handoff_record(
            destination_cwd, destination_record_before, services
        ):
            return _result(
                False,
                "destination_record_archive_failed",
                "preservation_archive",
                source=base_cwd,
                destination=destination_cwd,
                owner_key=owner_key,
                patch=patch,
                guidance=(
                    "The destination ownership proof could not be archived, so "
                    "the retained branch and destination were left unchanged."
                ),
            )
        placed = _place_handoff_patch(
            destination_cwd, patch, owner_key, services
        )
        return _result(
            placed,
            "branch_transferred" if placed else "destination_reconcile_failed",
            "complete" if placed else "destination_apply",
            source=base_cwd,
            destination=destination_cwd,
            owner_key=owner_key,
            patch=patch,
            guidance=(
                "The retained branch was carried into the selected checkout."
                if placed
                else "The retained branch could not be applied safely; the branch and destination were preserved."
            ),
            mutated=placed,
        )


def branch_commit_count(base_cwd, branch, services: Any) -> int | None:
    """Count commits beyond origin/main, or ``None`` when Git cannot prove it.

    Callers use this value to decide whether a branch may be deleted.  Treating
    an inspection failure as zero would turn an unavailable Git command or a
    corrupt ref into permission to destroy committed work.
    """
    if not branch:
        return 0
    try:
        return_code, output = services._run_git(
            ["rev-list", "--count", f"origin/main..{branch}"], cwd=base_cwd
        )
    except (OSError, TypeError, ValueError):
        return None
    if return_code != 0 or not output.strip().isdigit():
        return None
    return int(output.strip())


def teardown_worktree(base_cwd, worktree, branch, services: Any) -> str:
    """Remove a worktree while retaining any branch with committed work."""
    if not worktree:
        return "noop"
    commit_count = branch_commit_count(base_cwd, branch, services)
    if commit_count is None:
        return "preserved-unproven"
    has_commits = commit_count > 0
    services._run_git(
        ["worktree", "remove", "--force", worktree], cwd=base_cwd
    )
    if pathlib.Path(worktree).exists():
        return "preserved-teardown-failed"
    if branch and not has_commits:
        services._run_git(["branch", "-D", branch], cwd=base_cwd)
    return "removed"


def discard_worktree(base_cwd, worktree, branch, services: Any) -> bool:
    """Drop a worktree's uncommitted work with the human's consent.

    The worktree is force-removed. Its branch is deleted when it holds no commits
    beyond origin/main, otherwise renamed under ``orcha-discarded/`` so committed
    work stays reachable while the routing recovery no longer finds it (the
    stream then starts clean in the selected checkout).
    """
    if not worktree:
        return False
    commit_count = branch_commit_count(base_cwd, branch, services)
    if commit_count is None:
        return False
    patch, _diagnostics = _handoff_patch(worktree, services)
    runtime_manifest = _runtime_overlay_manifest(worktree)
    if (
        patch is None
        or not clear_retirement_record(base_cwd, worktree, services)
        or not _write_retirement_record(
            base_cwd,
            worktree,
            branch,
            services,
            disposition="human_discarded",
            patch=patch,
            runtime_manifest=runtime_manifest,
        )
    ):
        return False
    if pathlib.Path(worktree).exists():
        services._run_git(
            ["worktree", "remove", "--force", "--force", worktree], cwd=base_cwd
        )
    services._run_git(["worktree", "prune"], cwd=base_cwd)
    if branch:
        exists, _ = services._run_git(
            ["show-ref", "--verify", "--quiet", f"refs/heads/{branch}"], cwd=base_cwd
        )
        if exists == 0:
            if commit_count > 0:
                from .notifier_checkout_consent import discard_branch_name

                services._run_git(
                    ["branch", "-m", branch, discard_branch_name(branch)], cwd=base_cwd
                )
            else:
                services._run_git(["branch", "-D", branch], cwd=base_cwd)
    if pathlib.Path(worktree).exists():
        clear_retirement_record(base_cwd, worktree, services)
        return False
    return _finalize_retirement_record(
        base_cwd, worktree, branch, services
    )


def is_git_repo(cwd, services: Any) -> bool:
    """Return whether a path belongs to a Git worktree."""
    return bool(cwd) and services._run_git(
        ["rev-parse", "--git-dir"], cwd=cwd
    )[0] == 0


def worktree_is_dirty(worktree, services: Any, excludes=None) -> bool:
    """Return whether a worktree has changes or cannot be inspected safely."""
    if not worktree:
        return False
    arguments = ["status", "--porcelain", "--ignored", "--untracked-files=all"]
    if excludes:
        arguments.extend(["--", *excludes])
    return_code, output = services._run_git(arguments, cwd=worktree)
    return return_code != 0 or bool(output.strip())


def safe_teardown_worktree(base_cwd, worktree, branch, services: Any) -> str:
    """Retire a clean worktree without ever discarding uncommitted work."""
    if not worktree:
        return "noop"
    if services._worktree_is_dirty(worktree):
        return "preserved-dirty"
    if branch_commit_count(base_cwd, branch, services) is None:
        return "preserved-unproven"
    patch, _diagnostics = _handoff_patch(worktree, services)
    if patch is None:
        return "preserved-unproven"
    runtime_manifest = _runtime_overlay_manifest(worktree)
    base_runtime_manifest = _runtime_overlay_manifest(base_cwd)
    if runtime_manifest is None or base_runtime_manifest is None:
        return "preserved-unproven"
    if runtime_manifest != base_runtime_manifest:
        return "preserved-runtime-state"
    if not clear_retirement_record(base_cwd, worktree, services):
        return "preserved-unproven"
    if not _write_retirement_record(
        base_cwd,
        worktree,
        branch,
        services,
        disposition="clean",
        patch=patch,
        runtime_manifest=runtime_manifest,
    ):
        return "preserved-unproven"
    teardown_disposition = services._teardown_worktree(
        base_cwd, worktree, branch
    )
    if pathlib.Path(worktree).exists():
        clear_retirement_record(base_cwd, worktree, services)
        return (
            teardown_disposition
            if isinstance(teardown_disposition, str)
            and teardown_disposition.startswith("preserved-")
            else "preserved-teardown-failed"
        )
    if not _finalize_retirement_record(
        base_cwd, worktree, branch, services
    ):
        return "removed-unproven"
    return "removed"
