"""E3 — the resident-session transport primitives (the WARM, stdin-driven `claude`).

Unit cover for the building blocks of the resident-session manager:
  * spawn_resident — `claude -p --input-format stream-json` with an OPEN stdin pipe (vs the
    ephemeral headless worker's DEVNULL + argv prompt); --resume for a warm restart.
  * _send_user_turn — one user turn → an NDJSON line on stdin (the exact shape E2 proved).
  * _extract_session_id — pull claude's assigned session_id from the log head (for pinning).
  * _result_after — find the per-turn terminal `result` boundary (reply-capture).
The daemon-loop integration (discovery → claim → feed → capture → reap) builds on these.
"""
import io
import json
import re
import time

from orcha_cli import notifier


class CapturePopen:
    """Records argv + kwargs of a Popen call; exposes a writable stdin + a pid."""
    last = None

    def __init__(self, argv, **kw):
        CapturePopen.last = {"argv": argv, "kw": kw}
        self.argv = argv
        self.pid = 31337
        self.stdin = io.BytesIO()
        self.returncode = None

    def poll(self):
        return self.returncode


# ---------- spawn_resident ----------

def test_spawn_resident_builds_stream_json_input_argv(monkeypatch, tmp_path):
    monkeypatch.setattr(notifier.shutil, "which", lambda x: "/usr/bin/claude")
    monkeypatch.setattr(notifier.subprocess, "Popen", CapturePopen)
    ok, repr_, proc = notifier.spawn_resident(str(tmp_path), alias="Vox",
                                              log_path=tmp_path / "r.log")
    assert ok is True and proc is not None
    argv = CapturePopen.last["argv"]
    # warm, stdin-driven session — NOT a one-shot argv prompt
    assert argv[:2] == ["claude", "-p"]
    assert argv[2] == "--input-format" and argv[3] == "stream-json"
    assert "--output-format" in argv and argv[argv.index("--output-format") + 1] == "stream-json"
    assert "--include-partial-messages" in argv and "--verbose" in argv
    # NO positional prompt: every token after -p is a flag (begins with '-')
    assert all(tok.startswith("-") or argv[i - 1].startswith("--")
               for i, tok in enumerate(argv[2:], start=2))
    # no tty → bypass permission prompts, like the headless worker
    assert "--dangerously-skip-permissions" in argv
    # OPEN stdin pipe is the whole point (headless uses DEVNULL)
    assert CapturePopen.last["kw"]["stdin"] is notifier.subprocess.PIPE
    assert CapturePopen.last["kw"]["start_new_session"] is True


def test_spawn_resident_resume_and_persona(monkeypatch, tmp_path):
    """Warm restart --resume's the pinned session; a cold boot's persona+history rides in
    --append-system-prompt."""
    monkeypatch.setattr(notifier.shutil, "which", lambda x: "/usr/bin/claude")
    monkeypatch.setattr(notifier.subprocess, "Popen", CapturePopen)
    notifier.spawn_resident(str(tmp_path), alias="Vox", system_prompt="PERSONA+HISTORY",
                            resume_session_id="11111111-2222-3333-4444-555555555555",
                            log_path=tmp_path / "r.log")
    argv = CapturePopen.last["argv"]
    assert "--resume" in argv
    assert argv[argv.index("--resume") + 1] == "11111111-2222-3333-4444-555555555555"
    assert "--append-system-prompt" in argv
    assert argv[argv.index("--append-system-prompt") + 1] == "PERSONA+HISTORY"


def test_spawn_resident_passes_model(monkeypatch, tmp_path):
    """GAP A/B: a resident boots on the agent's selected model via `--model`."""
    monkeypatch.setattr(notifier.shutil, "which", lambda x: "/usr/bin/claude")
    monkeypatch.setattr(notifier.subprocess, "Popen", CapturePopen)
    notifier.spawn_resident(str(tmp_path), alias="Vox", model="claude-fable-5",
                            log_path=tmp_path / "r.log")
    argv = CapturePopen.last["argv"]
    assert "--model" in argv and argv[argv.index("--model") + 1] == "claude-fable-5"
    # absent → no flag
    notifier.spawn_resident(str(tmp_path), alias="Vox", log_path=tmp_path / "r.log")
    assert "--model" not in CapturePopen.last["argv"]


def test_spawn_resident_dry_run_and_missing_claude(monkeypatch, tmp_path):
    # dry-run never spawns
    ok, _, proc = notifier.spawn_resident(str(tmp_path), dry_run=True)
    assert ok is False and proc is None
    # claude not on PATH → no spawn (mirrors spawn_headless)
    monkeypatch.setattr(notifier.shutil, "which", lambda x: None)
    ok, _, proc = notifier.spawn_resident(str(tmp_path))
    assert ok is False and proc is None


def test_spawn_resident_codex_runtime_is_unsupported(tmp_path):
    ok, repr_, proc = notifier.spawn_resident(str(tmp_path), runtime="codex", model="gpt-5.5")
    assert ok is False and proc is None
    assert "codex resident" in repr_ and "unsupported" in repr_


def test_service_residents_starts_codex_conversation_worker(monkeypatch, tmp_path):
    conv = {"conversation_id": "c1", "agent_id": "a1", "agent_alias": "Vox",
            "model": "gpt-5.5", "model_runtime": "codex",
            "session_id": None, "pending_human": True, "last_turn_seq": 1,
            "conversation_ack_ts": 42.0}
    turns = [{"seq": 1, "role": "human", "content": "hello"}]
    posts = _wire(monkeypatch, active=[conv], turns=turns)
    proc = ResidentProc()
    spawned = []
    monkeypatch.setattr(notifier, "spawn_headless",
                        lambda *a, **k: spawned.append((a, k)) or (True, "repr", proc))
    live = {}

    notifier.service_residents("http://x", "cid", live, quiet=True, base_cwd=str(tmp_path))

    assert spawned and spawned[0][1]["runtime"] == "codex"
    assert spawned[0][1]["model"] == "gpt-5.5"
    assert spawned[0][1]["last_message_path"] is not None
    assert any("wake-claim" in u and b.get("kind") == "conversation" for u, b in posts)
    run_post = next(b for u, b in posts if u.endswith("/runs"))
    assert run_post["wake_event"] == "conversation_turn"
    assert run_post["pid"] == proc.pid
    assert run_post["runtime"] == "codex"
    assert run_post["conversation_id"] == "c1"
    assert run_post["conversation_ack_ts"] == 42.0
    assert run_post["last_message_path"]
    assert live["c1"]["runtime"] == "codex"
    assert live["c1"]["current_run_id"] == "RUN-1"
    assert live["c1"]["conversation_ack_ts"] == 42.0
    assert spawned[0][1]["resume_session_id"] is None     # no pinned session → cold
    assert live["c1"]["resume_session_id"] is None


# ---------- #286: Codex session-resume (capture + reattach, fail-open) ----------

def _codex_resume_conv(**over):
    conv = {"conversation_id": "c1", "agent_id": "a1", "agent_alias": "Vox",
            "model": "gpt-5.5", "model_runtime": "codex",
            "session_id": "11111111-2222-3333-4444-555555555555", "cold_required": False,
            "pending_human": True, "last_turn_seq": 3, "conversation_ack_ts": 42.0}
    conv.update(over)
    return conv


def _wire_codex_spawn(monkeypatch, conv):
    """Wire a service_residents tick for ONE pending Codex conversation; capture the spawn call."""
    turns = [{"seq": 1, "role": "human", "content": "old q"},
             {"seq": 2, "role": "agent", "content": "old a"},
             {"seq": 3, "role": "human", "content": "new q"}]
    posts = _wire(monkeypatch, active=[conv], turns=turns)
    proc = ResidentProc()
    spawned = []
    monkeypatch.setattr(notifier, "spawn_headless",
                        lambda *a, **k: spawned.append((a, k)) or (True, "repr", proc))
    monkeypatch.setattr(notifier, "_is_git_repo", lambda *a, **k: False)
    return posts, spawned


def test_service_residents_codex_resumes_when_session_pinned(monkeypatch, tmp_path):
    """#286: a pinned session + not cold_required + no prior resume-failure → resume:
    spawn_headless gets resume_session_id, NO persona, and a prompt WITHOUT the full history."""
    notifier._CODEX_RESUME_FAILED.discard("c1")
    posts, spawned = _wire_codex_spawn(monkeypatch, _codex_resume_conv())
    live = {}

    notifier.service_residents("http://x", "cid", live, quiet=True, base_cwd=str(tmp_path))

    assert spawned, "expected a Codex worker spawn"
    _args, kw = spawned[0]
    assert kw["resume_session_id"] == "11111111-2222-3333-4444-555555555555"
    assert kw["system_prompt"] is None                 # persona lives in the rollout, not re-injected
    prompt = _args[1]
    assert "new q" in prompt                            # only the pending turn
    assert "old q" not in prompt and "old a" not in prompt   # NO history re-injection — the win
    assert live["c1"]["resume_session_id"] == "11111111-2222-3333-4444-555555555555"


def test_service_residents_codex_cold_when_cold_required(monkeypatch, tmp_path):
    """#286 mutation tooth: cold_required (ISS-70 digest changed) forces COLD even with a pinned
    session — full history + persona re-injected, resume_session_id None."""
    notifier._CODEX_RESUME_FAILED.discard("c1")
    posts, spawned = _wire_codex_spawn(monkeypatch, _codex_resume_conv(cold_required=True))
    live = {}

    notifier.service_residents("http://x", "cid", live, quiet=True, base_cwd=str(tmp_path))

    _args, kw = spawned[0]
    assert kw["resume_session_id"] is None
    assert kw["system_prompt"] == "PERSONA"            # cold re-injects persona/digest
    assert "old q" in _args[1]                          # cold re-injects history


def test_service_residents_codex_cold_when_resume_failed_flag_set(monkeypatch, tmp_path):
    """#286 mutation tooth: a conversation flagged _CODEX_RESUME_FAILED falls back to COLD even
    with a pinned session (so a bad rollout never re-breaks the turn)."""
    notifier._CODEX_RESUME_FAILED.add("c1")
    try:
        posts, spawned = _wire_codex_spawn(monkeypatch, _codex_resume_conv())
        live = {}
        notifier.service_residents("http://x", "cid", live, quiet=True, base_cwd=str(tmp_path))
        _args, kw = spawned[0]
        assert kw["resume_session_id"] is None
        assert kw["system_prompt"] == "PERSONA"
    finally:
        notifier._CODEX_RESUME_FAILED.discard("c1")


def test_extract_codex_session_id_tolerant_shapes(tmp_path):
    """#286: pull the session id from any of the known Codex carriers."""
    top = tmp_path / "a.ndjson"
    top.write_text('{"type":"thread.started","thread_id":"sid-top"}\n')
    assert notifier._extract_codex_session_id(str(top)) == "sid-top"

    nested = tmp_path / "b.ndjson"
    nested.write_text('{"id":"0","msg":{"type":"session_configured","session_id":"sid-nested"}}\n')
    assert notifier._extract_codex_session_id(str(nested)) == "sid-nested"

    conv = tmp_path / "c.ndjson"
    conv.write_text('{"type":"item","x":1}\n{"conversation_id":"sid-conv"}\n')
    assert notifier._extract_codex_session_id(str(conv)) == "sid-conv"


def test_extract_codex_session_id_none_when_absent(tmp_path):
    log = tmp_path / "n.ndjson"
    log.write_text('{"type":"agent_message","message":"hi"}\n')
    assert notifier._extract_codex_session_id(str(log)) is None
    assert notifier._extract_codex_session_id(None) is None
    assert notifier._extract_codex_session_id(str(tmp_path / "nope.ndjson")) is None


def test_codex_resume_prompt_omits_history():
    """#286: the resume prompt carries ONLY the new turns — no history block."""
    pending = [{"seq": 5, "role": "human", "content": "the new question"}]
    p = notifier._codex_resume_prompt("Vox", pending)
    assert "the new question" in p
    assert "## Conversation so far" not in p
    assert "RESUMES your existing Codex session" in p


def test_reconcile_codex_conversation_runs_reattaches_live_pid(monkeypatch, tmp_path):
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "model": "gpt-5.5", "model_runtime": "codex",
            "pending_human": True, "last_turn_seq": 2, "conversation_ack_ts": 88.0}
    log = tmp_path / "c.ndjson"
    reply = tmp_path / "c.ndjson.reply.txt"
    run = {"run_id": "RUN-1", "agent_id": "A1", "wake_event": "conversation_turn",
           "status": "running", "runtime": "codex", "conversation_id": "C1",
           "conversation_ack_ts": 77.0,
           "pid": 12345, "log_path": str(log), "last_message_path": str(reply),
           "worktree": str(tmp_path / "wt"), "branch": "orcha/Vox", "base_cwd": str(tmp_path)}
    posts = []

    def _get(url, **k):
        if "active-conversations" in url:
            return {"conversations": [conv]}
        if "/agents/A1/runs" in url:
            return {"runs": [run]}
        return None

    monkeypatch.setattr(notifier, "_get_json", _get)
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **k: posts.append((url, body)) or {})
    monkeypatch.setattr(notifier, "_pid_alive", lambda pid: pid == 12345)
    live = {}

    notifier.reconcile_codex_conversation_runs("http://x", "cid", live, quiet=True,
                                               base_cwd=str(tmp_path))

    assert posts == []
    assert live["C1"]["runtime"] == "codex"
    assert live["C1"]["proc"].pid == 12345
    assert live["C1"]["current_run_id"] == "RUN-1"
    assert live["C1"]["conversation_ack_ts"] == 77.0


def test_reconcile_codex_conversation_runs_recovers_dead_pid_reply(monkeypatch, tmp_path):
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "model": "gpt-5.5", "model_runtime": "codex",
            "pending_human": True, "last_turn_seq": 2, "conversation_ack_ts": 88.0}
    log = tmp_path / "c.ndjson"
    log.write_text('{"type":"agent_message","message":"draft"}\n')
    reply = tmp_path / "c.ndjson.reply.txt"
    reply.write_text("recovered reply\n")
    run = {"run_id": "RUN-1", "agent_id": "A1", "wake_event": "conversation_turn",
           "status": "running", "runtime": "codex", "conversation_id": "C1",
           "conversation_ack_ts": 77.0,
           "pid": 12345, "log_path": str(log), "last_message_path": str(reply),
           "worktree": str(tmp_path / "wt"), "branch": "orcha/Vox", "base_cwd": str(tmp_path)}
    posts = []
    teardowns = []

    def _get(url, **k):
        if "active-conversations" in url:
            return {"conversations": [conv]}
        if "/agents/A1/runs" in url:
            return {"runs": [run]}
        return None

    def _post(url, body, **k):
        posts.append((url, body))
        if "/conversations/C1/turns" in url:
            return {"turn": {"id": "T1"}}
        return {}

    monkeypatch.setattr(notifier, "_get_json", _get)
    monkeypatch.setattr(notifier, "_post_json", _post)
    monkeypatch.setattr(notifier, "_pid_alive", lambda pid: False)
    monkeypatch.setattr(notifier, "_capture_diff", lambda worktree: "diff")
    monkeypatch.setattr(notifier, "_safe_teardown_worktree",
                        lambda *args: teardowns.append(args) or "removed")
    live = {}

    notifier.reconcile_codex_conversation_runs("http://x", "cid", live, quiet=True,
                                               base_cwd=str(tmp_path))

    turn_post = next(b for u, b in posts if u.endswith("/conversations/C1/turns"))
    assert turn_post["content"] == "recovered reply"
    assert turn_post["run_id"] == "RUN-1"
    finish = next(b for u, b in posts if u.endswith("/runs/RUN-1/finish"))
    assert finish["status"] == "exited"
    assert finish["exit_code"] == 0
    assert finish["diff"] == "diff"
    ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert ack["kind"] == "codex_conversation_orphan_recovered"
    assert ack["delivered_ts"] == 77.0
    assert ack["release_lease"] is True
    assert teardowns == [(str(tmp_path), str(tmp_path / "wt"), "orcha/Vox")]
    assert live == {}


# ---------- _send_user_turn ----------

def test_send_user_turn_writes_exact_ndjson():
    proc = CapturePopen(["claude"])
    assert notifier._send_user_turn(proc, "hello agent") is True
    proc.stdin.seek(0)
    line = proc.stdin.read().decode()
    assert line.endswith("\n")
    obj = json.loads(line)
    assert obj == {"type": "user",
                   "message": {"role": "user",
                               "content": [{"type": "text", "text": "hello agent"}]}}


def test_send_user_turn_false_when_pipe_gone():
    class Dead:
        stdin = None
    assert notifier._send_user_turn(Dead(), "x") is False
    assert notifier._send_user_turn(None, "x") is False

    class Broken:
        class _s:
            def write(self, b):
                raise BrokenPipeError()
            def flush(self):
                pass
        stdin = _s()
    assert notifier._send_user_turn(Broken(), "x") is False


# ---------- _extract_session_id ----------

def test_extract_session_id_from_log_head(tmp_path):
    log = tmp_path / "r.log"
    log.write_text(
        '{"type":"system","subtype":"init","session_id":"abc-123","tools":[]}\n'
        '{"type":"assistant","session_id":"abc-123","message":{"content":[]}}\n')
    assert notifier._extract_session_id(str(log)) == "abc-123"


def test_extract_session_id_none_when_absent_or_unreadable(tmp_path):
    log = tmp_path / "r.log"
    log.write_text('{"type":"assistant","message":{"content":[]}}\n')   # no session_id
    assert notifier._extract_session_id(str(log)) is None
    assert notifier._extract_session_id(None) is None
    assert notifier._extract_session_id(str(tmp_path / "nope.log")) is None


# ---------- _result_after (per-turn reply boundary) ----------

def test_result_after_finds_each_turn_boundary(tmp_path):
    log = tmp_path / "r.log"
    log.write_text(
        '{"type":"assistant","message":{"content":[{"type":"text","text":"thinking"}]}}\n'
        '{"type":"result","subtype":"success","num_turns":1,"session_id":"s1","result":"answer one"}\n'
        '{"type":"assistant","message":{"content":[{"type":"text","text":"more"}]}}\n'
        '{"type":"result","subtype":"success","num_turns":2,"session_id":"s1","result":"answer two"}\n')
    r1 = notifier._result_after(str(log), 0)
    assert r1 and r1["text"] == "answer one" and r1["num_turns"] == 1
    assert r1["subtype"] == "success" and r1["session_id"] == "s1"
    # scanning from just past result#1 yields result#2 (not #1 again) — the next turn's reply
    r2 = notifier._result_after(str(log), r1["end_offset"])
    assert r2 and r2["text"] == "answer two" and r2["num_turns"] == 2


def test_result_after_none_until_turn_completes(tmp_path):
    log = tmp_path / "r.log"
    # only an assistant line + a PARTIAL (unterminated, half-written) result → turn not done
    log.write_bytes(
        b'{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}\n'
        b'{"type":"result","subtype":"succ')
    assert notifier._result_after(str(log), 0) is None
    assert notifier._result_after(None, 0) is None


# ---------- service_residents — the daemon-loop state machine ----------

class ResidentProc:
    def __init__(self, alive=True, pid=4321):
        self.pid = pid
        self.returncode = None if alive else 0
        self.stdin = io.BytesIO()
        self.killed = False
    def poll(self):
        return self.returncode
    def kill(self):
        self.killed = True
        self.returncode = -9
    def wait(self, timeout=None):
        return self.returncode


def _wire(monkeypatch, *, active, turns=None, claim=True):
    """Route notifier's HTTP helpers for a service_residents tick. Returns the posts log."""
    posts = []

    def _get(url, **k):
        if "active-conversations" in url:
            return {"conversations": active}
        if "/turns" in url:                               # _next_human_turn — API filters after_seq
            m = re.search(r"after_seq=(\d+)", url)
            after = int(m.group(1)) if m else 0
            return {"turns": [t for t in (turns or []) if t.get("seq", 0) > after]}
        if "/conversation" in url:                        # agent's active conv: NEWEST page, oldest→newest
            return {"conversation": {"id": "C1"}, "turns": turns or []}
        return None      # persona/digest → None

    def _post(url, body, **k):
        posts.append((url, body))
        if "wake-claim" in url:
            return {"claimed": claim, "reason": "blocked" if not claim else None,
                    "lease_kind": "resident"}
        if url.endswith("/runs"):
            return {"run_id": "RUN-1", "status": "running"}
        if "/conversations/" in url and url.endswith("/turns"):
            return {"turn": {"id": "T1"}}
        return {}

    monkeypatch.setattr(notifier, "_get_json", _get)
    monkeypatch.setattr(notifier, "_post_json", _post)
    monkeypatch.setattr(notifier, "_build_persona", lambda *a, **k: "PERSONA")
    monkeypatch.setattr(notifier, "_pump_one", lambda *a, **k: None)
    return posts


def test_service_residents_cold_boot_and_feeds_turn(monkeypatch, tmp_path):
    """A pending human turn with no live resident → claim a RESIDENT lease, cold-boot spawn_resident
    (persona, no --resume), open a per-turn run, and feed the turn to stdin."""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": None, "pending_human": True, "last_turn_seq": 1}
    posts = _wire(monkeypatch, active=[conv], turns=[{"seq": 1, "role": "human", "content": "hello"}])
    proc = ResidentProc()
    spawned = []
    monkeypatch.setattr(notifier, "spawn_resident",
                        lambda *a, **k: spawned.append((a, k)) or (True, "repr", proc))
    live = {}

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))

    assert spawned and spawned[0][1]["resume_session_id"] is None        # cold boot
    assert spawned[0][1]["system_prompt"] == "PERSONA"
    assert any("wake-claim" in u and b.get("lease_kind") == "resident" for u, b in posts)
    assert any(u.endswith("/runs") for u, _ in posts)                    # per-turn run opened
    proc.stdin.seek(0)
    assert json.loads(proc.stdin.read().decode())["message"]["content"][0]["text"] == "hello"
    r = live["C1"]
    assert r["awaiting_result"] is True and r["serviced_seq"] == 1 and r["current_run_id"] == "RUN-1"
    assert r["runtime"] == notifier.RUNTIME_CLAUDE


def test_service_residents_cold_boot_forced_by_cold_required(monkeypatch, tmp_path):
    """ISS-70: a conversation WITH a pinned session_id would normally warm-resume, but when the
    server signals `cold_required` (its latest digest is newer than the session pin) the boot must
    be COLD — re-injecting persona+digest so the resident re-reads the cross-embodiment digest,
    NOT --resume the stale warm session."""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": "99999999-8888-7777-6666-555555555555",   # pinned → would warm-resume
            "cold_required": True,                                  # ...but the digest is newer
            "pending_human": True, "last_turn_seq": 1}
    posts = _wire(monkeypatch, active=[conv], turns=[{"seq": 1, "role": "human", "content": "hello"}])
    proc = ResidentProc()
    spawned = []
    monkeypatch.setattr(notifier, "spawn_resident",
                        lambda *a, **k: spawned.append((a, k)) or (True, "repr", proc))
    live = {}

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))

    assert spawned and spawned[0][1]["resume_session_id"] is None        # forced COLD despite session_id
    assert spawned[0][1]["system_prompt"] == "PERSONA"                   # persona+digest re-injected
    assert live["C1"]["cold"] is True and live["C1"]["session_pinned"] is False


def test_service_residents_warm_resume_when_cold_required_false(monkeypatch, tmp_path):
    """ISS-70 negative: a pinned session with cold_required=False (no newer digest) still warm-
    resumes — the override is one-shot per new digest, never a blanket cold-on-every-turn."""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": "99999999-8888-7777-6666-555555555555",
            "cold_required": False, "pending_human": True, "last_turn_seq": 1}
    _wire(monkeypatch, active=[conv], turns=[{"seq": 1, "role": "human", "content": "hello"}])
    proc = ResidentProc()
    spawned = []
    monkeypatch.setattr(notifier, "spawn_resident",
                        lambda *a, **k: spawned.append((a, k)) or (True, "repr", proc))
    live = {}

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))

    assert spawned and spawned[0][1]["resume_session_id"] == conv["session_id"]   # warm --resume
    assert live["C1"]["cold"] is False


def test_service_residents_restarts_existing_idle_resident_when_cold_required(monkeypatch, tmp_path):
    """#222: live->resident digest re-sync. cold_required must also evict an already-live idle
    resident before it consumes the next human turn, not only affect brand-new boots."""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": "99999999-8888-7777-6666-555555555555",
            "cold_required": True, "pending_human": True, "last_turn_seq": 3}
    posts = _wire(monkeypatch, active=[conv],
                  turns=[{"seq": 3, "role": "human", "content": "fresh question"}])
    old_proc = ResidentProc(pid=1111)
    new_proc = ResidentProc(pid=2222)
    killed = []
    spawned = []
    monkeypatch.setattr(notifier, "_kill_worker", lambda proc, **k: killed.append(proc.pid))
    monkeypatch.setattr(notifier, "spawn_resident",
                        lambda *a, **k: spawned.append((a, k)) or (True, "repr", new_proc))
    live = {"C1": {"proc": old_proc, "agent_id": "A1", "conversation_id": "C1",
                   "alias": "Vox", "log_path": tmp_path / "c.ndjson",
                   "session_id": conv["session_id"], "session_pinned": True,
                   "cold": False, "serviced_seq": 2, "current_run_id": None, "run_id": None,
                   "awaiting_result": False, "turn_scan_offset": 0,
                   "lines_offset": 0, "lines_buf": b"", "lines_seq": 1,
                   "last_activity_ts": time.time()}}

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))

    assert killed == [old_proc.pid]                              # stale resident was checkpointed
    assert old_proc.stdin.closed is True                         # EOF path fired before kill
    assert spawned and spawned[0][1]["resume_session_id"] is None # forced cold despite session_id
    assert spawned[0][1]["system_prompt"] == "PERSONA"           # latest digest re-injected
    assert live["C1"]["proc"] is new_proc and live["C1"]["cold"] is True
    new_proc.stdin.seek(0)
    sent = json.loads(new_proc.stdin.read().decode())["message"]["content"][0]["text"]
    assert sent == "fresh question"                              # delivered only to the fresh boot
    assert any(u.endswith("/wake-ack") and b["kind"] == "resident_digest_resync"
               and b["release_lease"] is True for u, b in posts)


def test_service_residents_defers_cold_required_restart_while_mid_turn(monkeypatch, tmp_path):
    """#222 safety: do not interrupt an in-flight resident turn for digest re-sync. It restarts
    only after the current result is captured and the resident is idle."""
    log = tmp_path / "c.ndjson"
    log.write_text("")
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": "99999999-8888-7777-6666-555555555555",
            "cold_required": True, "pending_human": True, "last_turn_seq": 3}
    posts = _wire(monkeypatch, active=[conv],
                  turns=[{"seq": 3, "role": "human", "content": "fresh question"}])
    proc = ResidentProc(pid=1111)
    killed = []
    spawned = []
    monkeypatch.setattr(notifier, "_kill_worker", lambda proc, **k: killed.append(proc.pid))
    monkeypatch.setattr(notifier, "spawn_resident",
                        lambda *a, **k: spawned.append((a, k)) or (True, "repr", ResidentProc()))
    live = {"C1": {"proc": proc, "agent_id": "A1", "conversation_id": "C1",
                   "alias": "Vox", "log_path": log, "session_id": conv["session_id"],
                   "session_pinned": True, "cold": False, "serviced_seq": 2,
                   "current_run_id": "RUN-1", "run_id": "RUN-1",
                   "awaiting_result": True, "awaiting_since": time.time(),
                   "turn_scan_offset": 0, "lines_offset": 0, "lines_buf": b"",
                   "lines_seq": 1, "last_activity_ts": time.time()}}

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))

    assert killed == [] and spawned == []                         # in-flight turn left alone
    assert live["C1"]["awaiting_result"] is True
    assert not any(u.endswith("/wake-ack") and b["kind"] == "resident_digest_resync"
                   for u, b in posts)


def test_service_residents_keeps_idle_resident_until_cold_required_turn_is_pending(monkeypatch, tmp_path):
    """#222 warm-zone guard: a newer digest alone should not tear down an idle resident early.
    Restart only at the point a pending human turn would otherwise be delivered stale."""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": "99999999-8888-7777-6666-555555555555",
            "cold_required": True, "pending_human": False, "last_turn_seq": 2}
    posts = _wire(monkeypatch, active=[conv])
    proc = ResidentProc(pid=1111)
    killed = []
    spawned = []
    monkeypatch.setattr(notifier, "_kill_worker", lambda proc, **k: killed.append(proc.pid))
    monkeypatch.setattr(notifier, "spawn_resident",
                        lambda *a, **k: spawned.append((a, k)) or (True, "repr", ResidentProc()))
    live = {"C1": {"proc": proc, "agent_id": "A1", "conversation_id": "C1",
                   "alias": "Vox", "log_path": tmp_path / "c.ndjson",
                   "session_id": conv["session_id"], "session_pinned": True,
                   "cold": False, "serviced_seq": 2, "current_run_id": None, "run_id": None,
                   "awaiting_result": False, "turn_scan_offset": 0,
                   "lines_offset": 0, "lines_buf": b"", "lines_seq": 1,
                   "last_activity_ts": time.time()}}

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))

    assert killed == [] and spawned == []
    assert live["C1"]["proc"] is proc
    assert not any(u.endswith("/wake-ack") and b["kind"] == "resident_digest_resync"
                   for u, b in posts)


def test_service_residents_captures_reply_and_pins_session(monkeypatch, tmp_path):
    """An in-flight turn whose `result` has landed → POST the agent turn (role=agent, run_id, meta),
    finish the run, and pin the claude session_id for later --resume."""
    log = tmp_path / "c.ndjson"
    log.write_text('{"type":"result","subtype":"success","num_turns":3,'
                   '"session_id":"sess-9","result":"the answer"}\n')
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": None, "pending_human": True, "last_turn_seq": 1}
    posts = _wire(monkeypatch, active=[conv])
    live = {"C1": {"proc": ResidentProc(), "agent_id": "A1", "conversation_id": "C1",
                   "alias": "Vox", "log_path": log, "session_id": None, "session_pinned": False,
                   "cold": True, "serviced_seq": 1, "current_run_id": "RUN-1", "run_id": "RUN-1",
                   "awaiting_result": True, "turn_scan_offset": 0,
                   "lines_offset": 0, "lines_buf": b"", "lines_seq": 1,
                   "last_activity_ts": time.time()}}

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))

    turn_post = next(b for u, b in posts if u.endswith("/conversations/C1/turns"))
    assert turn_post["role"] == "agent" and turn_post["content"] == "the answer"
    assert turn_post["run_id"] == "RUN-1" and turn_post["meta"]["num_turns"] == 3
    assert any(u.endswith("/runs/RUN-1/finish") for u, _ in posts)
    sess = next(b for u, b in posts if u.endswith("/conversations/C1/session"))
    assert sess["session_id"] == "sess-9"
    r = live["C1"]
    assert r["awaiting_result"] is False and r["session_pinned"] is True
    assert any(u.endswith("/wake-renew") for u, _ in posts)              # lease held while warm


def test_service_residents_posts_codex_conversation_reply_on_exit(monkeypatch, tmp_path):
    """A finished one-shot Codex conversation worker writes its final message back into the
    Conversation tab, finishes its worker_run, and advances the consumed conversation_turn event."""
    reply = tmp_path / "c.ndjson.reply.txt"
    reply.write_text("hello from codex\n")
    log = tmp_path / "c.ndjson"
    log.write_text('{"type":"agent_message","message":"streamed draft"}\n')
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "model": "gpt-5.5", "model_runtime": "codex",
            "session_id": None, "pending_human": True, "last_turn_seq": 1}
    posts = _wire(monkeypatch, active=[conv])
    live = {"C1": {"runtime": "codex", "proc": ResidentProc(alive=False),
                   "agent_id": "A1", "conversation_id": "C1", "alias": "Vox",
                   "log_path": log, "last_message_path": reply,
                   "worktree": None, "branch": None, "base_cwd": str(tmp_path),
                   "serviced_seq": 1, "current_run_id": "RUN-1", "run_id": "RUN-1",
                   "conversation_ack_ts": 77.0,
                   "hard_deadline": time.time() + 1000,
                   "last_size": 0, "last_progress_ts": time.time(),
                   "lines_offset": 0, "lines_buf": b"", "lines_seq": 1,
                   "last_activity_ts": time.time()}}

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))

    turn_post = next(b for u, b in posts if u.endswith("/conversations/C1/turns"))
    assert turn_post["role"] == "agent"
    assert turn_post["author_agent_id"] == "A1"
    assert turn_post["content"] == "hello from codex"
    assert turn_post["run_id"] == "RUN-1"
    assert turn_post["meta"]["runtime"] == "codex"
    assert any(u.endswith("/runs/RUN-1/finish") for u, _ in posts)
    ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert ack["kind"] == "codex_conversation_released"
    assert ack["event"] == "conversation_turn"
    assert ack["delivered_ts"] == 77.0
    assert ack["release_lease"] is True
    assert live == {}


def test_service_residents_codex_captures_and_pins_session_on_reply(monkeypatch, tmp_path):
    """#286: a Codex worker that produced a GENUINE reply has its session id captured from the
    log and pinned via POST /conversations/{id}/session, so the next turn can resume."""
    notifier._CODEX_RESUME_FAILED.add("C1")             # a prior failure that a real reply heals
    reply = tmp_path / "c.ndjson.reply.txt"
    reply.write_text("here is your answer\n")
    log = tmp_path / "c.ndjson"
    log.write_text('{"id":"0","msg":{"type":"session_configured",'
                   '"session_id":"99999999-8888-7777-6666-555555555555"}}\n')
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "model": "gpt-5.5", "model_runtime": "codex",
            "session_id": None, "pending_human": True, "last_turn_seq": 1}
    posts = _wire(monkeypatch, active=[conv])
    live = {"C1": {"runtime": "codex", "proc": ResidentProc(alive=False),
                   "agent_id": "A1", "conversation_id": "C1", "alias": "Vox",
                   "log_path": log, "last_message_path": reply,
                   "worktree": None, "branch": None, "base_cwd": str(tmp_path),
                   "serviced_seq": 1, "current_run_id": "RUN-1", "run_id": "RUN-1",
                   "conversation_ack_ts": 77.0, "resume_session_id": None,
                   "hard_deadline": time.time() + 1000,
                   "last_size": 0, "last_progress_ts": time.time(),
                   "lines_offset": 0, "lines_buf": b"", "lines_seq": 1,
                   "last_activity_ts": time.time()}}

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))

    pin = next(b for u, b in posts if u.endswith("/conversations/C1/session"))
    assert pin["session_id"] == "99999999-8888-7777-6666-555555555555"
    assert "C1" not in notifier._CODEX_RESUME_FAILED     # a real reply clears the failed flag


def test_service_residents_codex_resume_failure_falls_back_to_cold(monkeypatch, tmp_path):
    """#286 FAIL-SAFE: a `codex exec resume` worker that produced NO reply must NOT post the
    sentinel — it flags the conversation for COLD retry and releases the lease with the human turn
    still pending (delivered_ts None), so the next tick re-runs cold. Never a broken turn."""
    notifier._CODEX_RESUME_FAILED.discard("C1")
    log = tmp_path / "c.ndjson"
    log.write_text('{"type":"token_count","n":5}\n')     # no reply, no result
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "model": "gpt-5.5", "model_runtime": "codex",
            "session_id": "sid-x", "pending_human": True, "last_turn_seq": 1}
    posts = _wire(monkeypatch, active=[conv])
    live = {"C1": {"runtime": "codex", "proc": ResidentProc(alive=False),
                   "agent_id": "A1", "conversation_id": "C1", "alias": "Vox",
                   "log_path": log, "last_message_path": tmp_path / "missing.reply.txt",
                   "worktree": None, "branch": None, "base_cwd": str(tmp_path),
                   "serviced_seq": 1, "current_run_id": "RUN-1", "run_id": "RUN-1",
                   "conversation_ack_ts": 77.0, "resume_session_id": "sid-x",
                   "hard_deadline": time.time() + 1000,
                   "last_size": 0, "last_progress_ts": time.time(),
                   "lines_offset": 0, "lines_buf": b"", "lines_seq": 1,
                   "last_activity_ts": time.time()}}
    try:
        notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))

        assert "C1" in notifier._CODEX_RESUME_FAILED      # flagged for cold retry
        assert not any(u.endswith("/conversations/C1/turns") for u, _ in posts)  # NO sentinel reply
        ack = next(b for u, b in posts if u.endswith("/wake-ack"))
        assert ack.get("delivered_ts") is None            # turn stays pending → re-runs cold
        assert ack["release_lease"] is True
    finally:
        notifier._CODEX_RESUME_FAILED.discard("C1")


def test_service_residents_idle_reaps_and_releases_lease(monkeypatch, tmp_path):
    """A warm resident with no in-flight turn and nothing pending, idle past the reap window →
    torn down (stdin EOF + graceful kill) and its embodiment lease RELEASED (not the conversation
    ended — that's human-driven)."""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": "sess-9", "pending_human": False, "last_turn_seq": 2}
    posts = _wire(monkeypatch, active=[conv])
    monkeypatch.setattr(notifier.os, "getpgid", lambda pid: pid)
    sigs = []
    monkeypatch.setattr(notifier.os, "killpg", lambda pgid, sig: sigs.append((pgid, sig)))
    proc = ResidentProc()
    live = {"C1": {"proc": proc, "agent_id": "A1", "conversation_id": "C1", "alias": "Vox",
                   "log_path": tmp_path / "c.ndjson", "session_id": "sess-9", "session_pinned": True,
                   "cold": False, "serviced_seq": 2, "current_run_id": None, "run_id": None,
                   "awaiting_result": False, "turn_scan_offset": 0,
                   "lines_offset": 0, "lines_buf": b"", "lines_seq": 1,
                   "last_activity_ts": time.time() - (notifier.RESIDENT_IDLE_REAP_SECS + 10)}}

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))

    assert live == {}                                                    # torn down
    assert sigs and sigs[0][1] == notifier.signal.SIGTERM                # graceful kill
    ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert ack["kind"] == "resident_idle" and ack["release_lease"] is True
    assert not any(u.endswith("/end") for u, _ in posts)                 # conversation NOT ended


def test_service_residents_skips_when_lease_refused(monkeypatch, tmp_path):
    """Single-embodiment: if the resident claim loses (an ephemeral wake holds the lease), no
    resident is booted."""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": None, "pending_human": True, "last_turn_seq": 1}
    posts = _wire(monkeypatch, active=[conv],
                  turns=[{"seq": 1, "role": "human", "content": "hi"}], claim=False)
    spawned = []
    monkeypatch.setattr(notifier, "spawn_resident",
                        lambda *a, **k: spawned.append(1) or (True, "r", ResidentProc()))
    live = {}

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))

    assert spawned == [] and live == {}                                  # claim lost → no spawn
    assert not any(u.endswith("/runs") for u, _ in posts)


# ---------- ISS-69(b): a live terminal preempts an IDLE resident; mid-turn yields are deferred ----------

def _wire_preempt(monkeypatch, *, active, preempt_requested):
    """Route the HTTP helpers so wake-renew reports a pending yield request. Returns posts log."""
    posts = []

    def _get(url, **k):
        return {"conversations": active} if "active-conversations" in url else None

    def _post(url, body, **k):
        posts.append((url, body))
        if url.endswith("/wake-renew"):
            return {"renewed": True, "lease_kind": "resident", "preempt_requested": preempt_requested}
        return {}
    monkeypatch.setattr(notifier, "_get_json", _get)
    monkeypatch.setattr(notifier, "_post_json", _post)
    monkeypatch.setattr(notifier, "_pump_one", lambda *a, **k: None)
    return posts


def test_service_residents_yields_idle_resident_on_preempt(monkeypatch, tmp_path):
    """A live terminal asked an IDLE resident to yield (wake-renew → preempt_requested). The daemon
    snapshots + releases the lease (graceful SIGTERM so SessionEnd/C1 runs) — and does so NOW, even
    though the resident is well within its idle-reap window (it's the YIELD, not idleness, closing it)."""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": "sess-9", "pending_human": False, "last_turn_seq": 2}
    posts = _wire_preempt(monkeypatch, active=[conv], preempt_requested=True)
    monkeypatch.setattr(notifier.os, "getpgid", lambda pid: pid)
    sigs = []
    monkeypatch.setattr(notifier.os, "killpg", lambda pgid, sig: sigs.append((pgid, sig)))
    proc = ResidentProc()
    live = {"C1": {"proc": proc, "agent_id": "A1", "conversation_id": "C1", "alias": "Vox",
                   "log_path": tmp_path / "c.ndjson", "session_id": "sess-9", "session_pinned": True,
                   "cold": False, "serviced_seq": 2, "current_run_id": None, "run_id": None,
                   "awaiting_result": False, "turn_scan_offset": 0,
                   "lines_offset": 0, "lines_buf": b"", "lines_seq": 1,
                   "last_activity_ts": time.time()}}     # RECENT activity → would NOT idle-reap

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))

    assert live == {}                                                    # yielded the embodiment
    assert sigs and sigs[0][1] == notifier.signal.SIGTERM                # graceful → snapshot-on-yield
    ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert ack["kind"] == "resident_preempted" and ack["release_lease"] is True


def test_service_residents_defers_preempt_while_mid_turn(monkeypatch, tmp_path):
    """A preempt that arrives while the resident is MID-TURN (awaiting_result, no result yet) must NOT
    SIGKILL it — that would lose the in-flight reply. The flag persists server-side, so the resident
    keeps running this tick; the next idle tick yields = deferred-to-turn-end with no extra code."""
    log = tmp_path / "c.ndjson"
    log.write_text('{"type":"assistant","message":{"content":[]}}\n')   # NO terminal result → still awaiting
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": "sess-9", "pending_human": False, "last_turn_seq": 1}
    posts = _wire_preempt(monkeypatch, active=[conv], preempt_requested=True)
    proc = ResidentProc()
    live = {"C1": {"proc": proc, "agent_id": "A1", "conversation_id": "C1", "alias": "Vox",
                   "log_path": log, "session_id": "sess-9", "session_pinned": True,
                   "cold": False, "serviced_seq": 1, "current_run_id": "RUN-1", "run_id": "RUN-1",
                   "awaiting_result": True, "awaiting_since": time.time(), "turn_scan_offset": 0,
                   "lines_offset": 0, "lines_buf": b"", "lines_seq": 1,
                   "last_activity_ts": time.time()}}

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))

    assert "C1" in live and proc.killed is False                         # mid-turn → NOT yielded
    assert not any(u.endswith("/wake-ack") for u, _ in posts)            # lease NOT released yet


def test_service_residents_no_yield_without_preempt(monkeypatch, tmp_path):
    """Mutation guard: with no pending yield request, an idle (but recently-active) resident is NOT
    closed by the preempt path — it just renews and stays warm."""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": "sess-9", "pending_human": False, "last_turn_seq": 2}
    posts = _wire_preempt(monkeypatch, active=[conv], preempt_requested=False)
    proc = ResidentProc()
    live = {"C1": {"proc": proc, "agent_id": "A1", "conversation_id": "C1", "alias": "Vox",
                   "log_path": tmp_path / "c.ndjson", "session_id": "sess-9", "session_pinned": True,
                   "cold": False, "serviced_seq": 2, "current_run_id": None, "run_id": None,
                   "awaiting_result": False, "turn_scan_offset": 0,
                   "lines_offset": 0, "lines_buf": b"", "lines_seq": 1,
                   "last_activity_ts": time.time()}}     # recent → not idle-reaped either

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))

    assert "C1" in live and proc.killed is False                         # stays warm
    assert not any(u.endswith("/wake-ack") for u, _ in posts)


# ---------- ISS-78 (A2): a warm resident IDLE-YIELDS its inbox to an ephemeral drain (no bleed) ----------

def _wire_drain(monkeypatch, *, active):
    """Route the HTTP helpers for an idle-yield tick: wake-renew has no preempt; capture all posts.
    Stub the graceful-kill syscalls so _close_resident's SIGTERM teardown is observable, and record
    any _send_user_turn so a test can prove NOTHING was injected into the warm session on a yield."""
    posts = []
    sigs = []
    fed = []

    def _get(url, **k):
        return {"conversations": active} if "active-conversations" in url else None

    def _post(url, body, **k):
        posts.append((url, body))
        if url.endswith("/wake-renew"):
            return {"renewed": True, "lease_kind": "resident", "preempt_requested": False}
        if url.endswith("/runs"):
            return {"run_id": "RUN-D", "status": "running"}
        return {}
    monkeypatch.setattr(notifier, "_get_json", _get)
    monkeypatch.setattr(notifier, "_post_json", _post)
    monkeypatch.setattr(notifier, "_pump_one", lambda *a, **k: None)
    monkeypatch.setattr(notifier, "_send_user_turn",
                        lambda proc, text: fed.append(text) or True)
    monkeypatch.setattr(notifier.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(notifier.os, "killpg", lambda pgid, sig: sigs.append((pgid, sig)))
    monkeypatch.setattr(notifier, "_RESIDENT_DRAIN_YIELD", {})    # isolate module state per test
    return posts, sigs, fed


def _idle_resident(tmp_path, **over):
    r = {"proc": ResidentProc(), "agent_id": "A1", "conversation_id": "C1", "alias": "Vox",
         "log_path": tmp_path / "c.ndjson", "session_id": "sess-9", "session_pinned": True,
         "cold": False, "serviced_seq": 2, "current_run_id": None, "run_id": None,
         "awaiting_result": False, "turn_scan_offset": 0, "base_cwd": str(tmp_path),
         "lines_offset": 0, "lines_buf": b"", "lines_seq": 1, "last_activity_ts": time.time()}
    r.update(over)
    return r


def _stub_spawn(monkeypatch, *, sent=True, proc=None, raises=False):
    """Stub spawn_headless so a drain-sidecar test never launches a real `claude`. Records each call
    (cwd/prompt/kwargs) so a test can prove the base checkout, the lean prompt, and the model carried."""
    calls = []

    def _spawn(cwd, prompt, flags, dry_run, **kw):
        calls.append({"cwd": cwd, "prompt": prompt, "flags": flags, "kw": kw})
        if raises:
            raise RuntimeError("boom — spawn failed")
        return (sent, "spawn-repr", proc if sent else None)
    monkeypatch.setattr(notifier, "spawn_headless", _spawn)
    return calls


def test_service_residents_retires_idle_claude_resident_when_conversation_now_codex(monkeypatch, tmp_path):
    """Regression: a pre-existing Claude resident for a conversation that now resolves to Codex must
    release its resident lease so the Codex one-shot conversation worker can claim and answer."""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "model": "gpt-5.5", "model_runtime": "codex",
            "session_id": None, "pending_human": True, "last_turn_seq": 3,
            "conversation_ack_ts": 77.0}
    posts = _wire(monkeypatch, active=[conv],
                  turns=[{"seq": 3, "role": "human", "content": "please wake"}])
    sigs = []
    monkeypatch.setattr(notifier.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(notifier.os, "killpg", lambda pgid, sig: sigs.append((pgid, sig)))
    codex_proc = ResidentProc(pid=9999)
    spawns = _stub_spawn(monkeypatch, proc=codex_proc)
    old_proc = ResidentProc(pid=4321)
    live = {"C1": _idle_resident(tmp_path, proc=old_proc)}  # legacy resident dict: no runtime field

    notifier.service_residents("http://x", "cid", live, quiet=True, base_cwd=str(tmp_path))

    assert sigs and sigs[0] == (4321, notifier.signal.SIGTERM)    # old Claude resident retired
    release_ack = next(b for u, b in posts
                       if u.endswith("/wake-ack") and b["kind"] == "resident_runtime_changed")
    assert release_ack["release_lease"] is True
    assert len(spawns) == 1
    assert spawns[0]["kw"]["runtime"] == notifier.RUNTIME_CODEX
    assert spawns[0]["kw"]["model"] == "gpt-5.5"
    run_post = next(b for u, b in posts if u.endswith("/runs"))
    assert run_post["runtime"] == notifier.RUNTIME_CODEX
    assert run_post["conversation_ack_ts"] == 77.0
    assert live["C1"]["runtime"] == notifier.RUNTIME_CODEX
    assert live["C1"]["proc"] is codex_proc


def test_service_residents_defers_runtime_change_while_claude_turn_inflight(monkeypatch, tmp_path):
    """A runtime flip must not SIGTERM a Claude resident mid-answer. The old turn is allowed to finish;
    retirement happens on a later idle tick."""
    log = tmp_path / "c.ndjson"
    log.write_text('{"type":"assistant","message":{"content":[]}}\n')   # no terminal result yet
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "model": "gpt-5.5", "model_runtime": "codex",
            "session_id": None, "pending_human": True, "last_turn_seq": 3}
    posts = _wire(monkeypatch, active=[conv],
                  turns=[{"seq": 3, "role": "human", "content": "next turn"}])
    sigs = []
    monkeypatch.setattr(notifier.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(notifier.os, "killpg", lambda pgid, sig: sigs.append((pgid, sig)))
    spawns = _stub_spawn(monkeypatch, proc=ResidentProc(pid=9999))
    proc = ResidentProc(pid=4321)
    live = {"C1": _idle_resident(tmp_path, proc=proc, log_path=log, awaiting_result=True,
                                 awaiting_since=time.time(), current_run_id="RUN-1",
                                 run_id="RUN-1", serviced_seq=2)}

    notifier.service_residents("http://x", "cid", live, quiet=True, base_cwd=str(tmp_path))

    assert "C1" in live and live["C1"]["proc"] is proc
    assert sigs == [] and proc.killed is False
    assert spawns == []                                           # Codex waits for current turn
    assert any(u.endswith("/wake-renew") for u, _ in posts)       # old resident remains leased
    assert not any(u.endswith("/wake-ack") for u, _ in posts)     # no premature release


def test_service_residents_recycles_idle_claude_resident_on_model_change(monkeypatch, tmp_path):
    """GH#88: an agent's model changed within the SAME (claude) runtime while its resident was alive
    and idle. set_agent_model already cleared the pinned session_id, so active-conversations reports
    the NEW model + a NULL session — but the still-warm resident kept its OLD boot model baked into
    the session. service_residents must retire the stale resident (releasing its lease) and cold-boot
    a fresh one on the newly selected model before feeding the next human turn."""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "model": "claude-sonnet-5", "model_runtime": "claude",
            "session_id": None, "pending_human": True, "last_turn_seq": 3}
    posts = _wire(monkeypatch, active=[conv],
                  turns=[{"seq": 3, "role": "human", "content": "fresh question"}])
    old_proc = ResidentProc(pid=1111)
    new_proc = ResidentProc(pid=2222)
    killed = []
    spawned = []
    monkeypatch.setattr(notifier, "_kill_worker", lambda proc, **k: killed.append(proc.pid))
    monkeypatch.setattr(notifier, "spawn_resident",
                        lambda *a, **k: spawned.append((a, k)) or (True, "repr", new_proc))
    # resident booted on Opus; runtime stays claude so the runtime-change branch never fires.
    live = {"C1": _idle_resident(tmp_path, proc=old_proc, model="claude-opus-4-8",
                                 session_id=None, session_pinned=False)}

    notifier.service_residents("http://x", "cid", live, quiet=True, base_cwd=str(tmp_path))

    assert killed == [old_proc.pid]                                  # stale Opus resident checkpointed
    assert old_proc.stdin.closed is True                            # EOF path fired before kill
    assert any(u.endswith("/wake-ack") and b["kind"] == "resident_model_changed"
               and b["release_lease"] is True for u, b in posts)
    assert spawned and spawned[0][1]["model"] == "claude-sonnet-5"   # cold-booted on the NEW model
    assert spawned[0][1]["resume_session_id"] is None               # cold boot, not --resume
    assert live["C1"]["proc"] is new_proc and live["C1"]["model"] == "claude-sonnet-5"
    new_proc.stdin.seek(0)
    sent = json.loads(new_proc.stdin.read().decode())["message"]["content"][0]["text"]
    assert sent == "fresh question"                                # delivered only to the fresh boot


def test_service_residents_defers_model_change_while_claude_turn_inflight(monkeypatch, tmp_path):
    """GH#88 safety: a same-runtime model switch must not SIGTERM a resident mid-answer. The old turn
    finishes on the old model; the recycle happens on a later idle tick."""
    log = tmp_path / "c.ndjson"
    log.write_text('{"type":"assistant","message":{"content":[]}}\n')   # no terminal result yet
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "model": "claude-sonnet-5", "model_runtime": "claude",
            "session_id": None, "pending_human": True, "last_turn_seq": 3}
    posts = _wire(monkeypatch, active=[conv],
                  turns=[{"seq": 3, "role": "human", "content": "next turn"}])
    killed = []
    spawned = []
    monkeypatch.setattr(notifier, "_kill_worker", lambda proc, **k: killed.append(proc.pid))
    monkeypatch.setattr(notifier, "spawn_resident",
                        lambda *a, **k: spawned.append((a, k)) or (True, "repr", ResidentProc()))
    proc = ResidentProc(pid=1111)
    live = {"C1": _idle_resident(tmp_path, proc=proc, model="claude-opus-4-8", log_path=log,
                                 awaiting_result=True, awaiting_since=time.time(),
                                 current_run_id="RUN-1", run_id="RUN-1", serviced_seq=2)}

    notifier.service_residents("http://x", "cid", live, quiet=True, base_cwd=str(tmp_path))

    assert killed == [] and proc.killed is False                    # in-flight turn left alone
    assert spawned == []                                            # no cold reboot yet
    assert "C1" in live and live["C1"]["awaiting_result"] is True
    assert any(u.endswith("/wake-renew") for u, _ in posts)         # old resident remains leased
    assert not any(u.endswith("/wake-ack") and b["kind"] == "resident_model_changed"
                   for u, b in posts)


def test_service_residents_recycles_before_feeding_after_model_change_capture(monkeypatch, tmp_path):
    """GH#88 race: if an old-model turn finishes and a newer human turn is already queued, capture
    the old reply but cold-boot before feeding the queued turn."""
    log = tmp_path / "c.ndjson"
    log.write_text(
        '{"type":"result","subtype":"success","num_turns":1,'
        '"session_id":"old-session","result":"old answer"}\n'
    )
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "model": "claude-sonnet-5", "model_runtime": "claude",
            "session_id": None, "pending_human": True, "last_turn_seq": 5}
    posts = _wire(monkeypatch, active=[conv],
                  turns=[{"seq": 5, "role": "human", "content": "next on new model"}])
    old_proc = ResidentProc(pid=1111)
    new_proc = ResidentProc(pid=2222)
    killed = []
    spawned = []
    monkeypatch.setattr(notifier, "_kill_worker", lambda proc, **k: killed.append(proc.pid))
    monkeypatch.setattr(notifier, "spawn_resident",
                        lambda *a, **k: spawned.append((a, k)) or (True, "repr", new_proc))
    live = {"C1": _idle_resident(tmp_path, proc=old_proc, model="claude-opus-4-8",
                                 log_path=log, awaiting_result=True,
                                 awaiting_since=time.time(), current_run_id="RUN-OLD",
                                 run_id="RUN-OLD", serviced_seq=3)}

    notifier.service_residents("http://x", "cid", live, quiet=True, base_cwd=str(tmp_path))

    assert any(u.endswith("/conversations/C1/turns")
               and b["role"] == "agent" and b["content"] == "old answer"
               for u, b in posts)
    assert any(u.endswith("/runs/RUN-OLD/finish") for u, _ in posts)
    assert killed == [old_proc.pid]
    assert any(u.endswith("/wake-ack") and b["kind"] == "resident_model_changed"
               and b["release_lease"] is True for u, b in posts)
    assert spawned and spawned[0][1]["model"] == "claude-sonnet-5"
    assert spawned[0][1]["resume_session_id"] is None
    assert live["C1"]["proc"] is new_proc and live["C1"]["model"] == "claude-sonnet-5"
    new_proc.stdin.seek(0)
    sent = json.loads(new_proc.stdin.read().decode())["message"]["content"][0]["text"]
    assert sent == "next on new model"
    assert old_proc.stdin.closed is True


def test_service_residents_spawns_drain_sidecar_when_idle(monkeypatch, tmp_path):
    """#247 B3 (§5.2 warm-zone): an idle warm resident with queued NON-conversation events
    (pending_inbox>0) NO LONGER yields its lease (the A2 yield tore down the warm session, forcing a
    cold re-boot and defeating §5.1). It spawns a THROWAWAY drain sidecar in its OWN session — keeping
    the warm conversation AND the embodiment lease. The lease is NOT released, nothing is fed into the
    warm session, the sidecar runs in the BASE checkout with the per-agent model + the lean (no
    task-start) prompt, and its handle is tracked on the resident."""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": "sess-9", "pending_human": False, "last_turn_seq": 2,
            "pending_inbox": 3, "inbox_ack_ts": 30.0, "model": "claude-opus-4-8",
            # Gate P1b: directed messages have no other inbox surface — must reach the sidecar prompt.
            "inbox_messages": ["[task-thread message on task T-7] review my diff — RESPOND on it"]}
    posts, sigs, fed = _wire_drain(monkeypatch, active=[conv])
    sidecar = ResidentProc(pid=9999)
    spawns = _stub_spawn(monkeypatch, proc=sidecar)
    proc = ResidentProc()
    live = {"C1": _idle_resident(tmp_path, proc=proc)}

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))

    assert "C1" in live and proc.killed is False                 # warm resident + lease KEPT
    assert not sigs                                              # resident NOT graceful-killed/yielded
    assert not any(u.endswith("/wake-ack") for u, _ in posts)    # lease NOT released (no ack at SPAWN)
    assert len(spawns) == 1                                      # exactly one drain sidecar spawned
    assert spawns[0]["cwd"] == str(tmp_path)                     # BASE checkout, never a pinned worktree
    assert spawns[0]["kw"].get("model") == "claude-opus-4-8"     # per-agent model carried (#202/#218)
    assert "do not claim or start a task" in spawns[0]["prompt"].lower()   # lean: NO task auto-start
    assert "/orcha-listen" in spawns[0]["prompt"]                # one-shot: explicitly no watch loop
    # Gate P1b tooth: the directed-message CONTENT is fed into the sidecar prompt (no other surface).
    assert "review my diff — RESPOND on it" in spawns[0]["prompt"]
    assert live["C1"]["sidecar"]["proc"] is sidecar             # handle tracked on the resident
    assert live["C1"]["sidecar"]["ack_ts"] == 30.0             # P1a: spawn-time cursor mark stashed
    assert fed == []                                            # NOTHING injected into the warm session
    assert not any(u.endswith("/runs") for u, _ in posts)        # sidecar registers NO worker_run (§3)
    assert notifier._RESIDENT_DRAIN_YIELD["C1"][0] == 30.0       # attempt mark recorded (anti-thrash)


def test_service_residents_no_yield_when_inbox_empty(monkeypatch, tmp_path):
    """Mutation guard: pending_inbox=0 → no yield; the resident just renews and stays warm."""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": "sess-9", "pending_human": False, "last_turn_seq": 2,
            "pending_inbox": 0, "inbox_ack_ts": None}
    posts, sigs, fed = _wire_drain(monkeypatch, active=[conv])
    proc = ResidentProc()
    live = {"C1": _idle_resident(tmp_path, proc=proc)}

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))

    assert "C1" in live and proc.killed is False                 # stays warm, not yielded
    assert not sigs                                              # no graceful kill
    assert not any(u.endswith("/wake-ack") for u, _ in posts)    # lease NOT released


def test_service_residents_drain_backstop_skips_stalled_repeat(monkeypatch, tmp_path):
    """#247 B3 anti-thrash backstop (carries ISS-75/#188 forward). A conversation that already drained
    at inbox_ack_ts=30 must NOT spawn ANOTHER drain sidecar when the scan still reports the SAME high-
    water mark within the cooldown — otherwise a stuck/echo event the drain can't ack away thrashes a
    fresh sidecar every cycle. It holds the warm session this tick WITHOUT spawning."""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": "sess-9", "pending_human": False, "last_turn_seq": 2,
            "pending_inbox": 2, "inbox_ack_ts": 30.0}          # same mark as the last drain → no progress
    posts, sigs, fed = _wire_drain(monkeypatch, active=[conv])
    spawns = _stub_spawn(monkeypatch, proc=ResidentProc(pid=9999))
    notifier._RESIDENT_DRAIN_YIELD["C1"] = (30.0, time.time())  # we just drained at 30, within cooldown
    proc = ResidentProc()
    live = {"C1": _idle_resident(tmp_path, proc=proc)}

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))

    assert "C1" in live and proc.killed is False                 # stays warm — no re-drain thrash
    assert spawns == []                                          # backstop: NO new sidecar this tick
    assert not sigs and not any(u.endswith("/wake-ack") for u, _ in posts)


def test_service_residents_drain_fires_on_new_event_despite_recent_attempt(monkeypatch, tmp_path):
    """#247 B3: the anti-thrash backstop only throttles a STALLED repeat — a genuinely NEW event (a
    higher inbox_ack_ts than the last drain attempt's) clears `stalled` and spawns a fresh drain
    sidecar immediately, even within the cooldown window. Forward progress is never delayed, and the
    warm session is KEPT (no yield)."""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": "sess-9", "pending_human": False, "last_turn_seq": 2,
            "pending_inbox": 1, "inbox_ack_ts": 45.0, "model": "claude-opus-4-8"}   # NEW event
    posts, sigs, fed = _wire_drain(monkeypatch, active=[conv])
    spawns = _stub_spawn(monkeypatch, proc=ResidentProc(pid=9999))
    notifier._RESIDENT_DRAIN_YIELD["C1"] = (30.0, time.time())  # last attempt at 30, within cooldown
    proc = ResidentProc()
    live = {"C1": _idle_resident(tmp_path, proc=proc)}

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))

    assert "C1" in live and proc.killed is False                # warm KEPT (not yielded)
    assert len(spawns) == 1                                     # new event → fresh drain sidecar
    assert not any(u.endswith("/wake-ack") for u, _ in posts)   # lease NOT released
    assert notifier._RESIDENT_DRAIN_YIELD["C1"][0] == 45.0       # attempt mark advanced


def test_service_residents_pending_human_precedes_yield(monkeypatch, tmp_path):
    """ISS-78: a real pending HUMAN turn always wins over an inbox-drain yield — the resident answers
    the human (conversation_turn run) and does NOT yield the lease this tick, even with inbox>0. The
    `not pending` guard is the tooth: without it the resident would tear down + release mid human turn."""
    notifier._RESIDENT_DRAIN_YIELD.clear()                       # decisive: no stale backstop masking
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": "sess-9", "pending_human": True, "last_turn_seq": 3,
            "pending_inbox": 5, "inbox_ack_ts": 99.0}
    posts = _wire(monkeypatch, active=[conv],
                  turns=[{"seq": 3, "role": "human", "content": "are you there?"}])
    proc = ResidentProc()
    live = {"C1": _idle_resident(tmp_path, proc=proc)}

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))

    # decisive no-yield signal first: a yield would post a wake-ack (release_lease) and record the mark.
    assert not any(u.endswith("/wake-ack") for u, _ in posts)    # no yield/release
    assert "C1" not in notifier._RESIDENT_DRAIN_YIELD            # never entered the yield branch
    run = next(b for u, b in posts if u.endswith("/runs"))
    assert run["wake_event"] == "conversation_turn"              # answered the human, not yielded
    assert live["C1"]["proc"] is proc and proc.killed is False   # SAME warm resident kept the lease
    assert live["C1"]["current_run_kind"] == "conversation"


# ---------- #266 (FIRING): a warm-idle resident YIELDS for a due clock auto-wake ----------

def test_service_residents_yields_on_auto_wake_due(monkeypatch, tmp_path):
    """#266: an idle warm resident (no in-flight turn, no pending human) whose clock auto-wake is DUE
    yields the lease — same snapshot+release seam as the inbox-drain, NEVER injecting the heartbeat
    into the warm human session. Crucially the release passes stamp_woken=False so it does NOT reset
    the cadence clock out from under the very auto_wake_due that should fire the ephemeral wake next."""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": "sess-9", "pending_human": False, "last_turn_seq": 2,
            "pending_inbox": 0, "inbox_ack_ts": None, "auto_wake_due": True}
    posts, sigs, fed = _wire_drain(monkeypatch, active=[conv])
    proc = ResidentProc()
    live = {"C1": _idle_resident(tmp_path, proc=proc)}

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))

    assert live == {}                                           # yielded the embodiment
    assert sigs and sigs[0][1] == notifier.signal.SIGTERM       # graceful close → snapshot-on-yield
    ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert ack["kind"] == "resident_auto_wake_yield" and ack["release_lease"] is True
    assert ack["stamp_woken"] is False                          # the tooth: clock preserved for the ephemeral
    assert fed == []                                            # NOTHING injected into the warm session
    assert not any(u.endswith("/conversations/C1/turns") for u, _ in posts)   # no conversation reply
    assert not any(u.endswith("/runs") for u, _ in posts)       # no in-session heartbeat run opened


def test_service_residents_no_auto_wake_yield_when_not_due(monkeypatch, tmp_path):
    """Mutation guard: auto_wake_due=False (and inbox empty) → no yield; the resident stays warm.
    Without gating on auto_wake_due the resident would tear down its warm session every tick."""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": "sess-9", "pending_human": False, "last_turn_seq": 2,
            "pending_inbox": 0, "inbox_ack_ts": None, "auto_wake_due": False}
    posts, sigs, fed = _wire_drain(monkeypatch, active=[conv])
    proc = ResidentProc()
    live = {"C1": _idle_resident(tmp_path, proc=proc)}

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))

    assert "C1" in live and proc.killed is False                # stays warm, not yielded
    assert not sigs                                             # no graceful kill
    assert not any(u.endswith("/wake-ack") for u, _ in posts)   # lease NOT released


def test_service_residents_auto_wake_yield_skipped_mid_turn(monkeypatch, tmp_path):
    """#266 spec point 3: a resident MID-TURN (awaiting_result) when the clock fires is NEVER yielded —
    'awake' is redefined as mid-turn-right-now. The in-flight turn is left to finish; the wake catches
    a later idle tick. The awaiting_result guard is the tooth."""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": "sess-9", "pending_human": False, "last_turn_seq": 2,
            "pending_inbox": 0, "inbox_ack_ts": None, "auto_wake_due": True}
    posts, sigs, fed = _wire_drain(monkeypatch, active=[conv])
    monkeypatch.setattr(notifier, "_result_after", lambda *a, **k: None)   # turn still running
    proc = ResidentProc()
    # mid-turn: awaiting a result, with a live run — but no finished result yet
    live = {"C1": _idle_resident(tmp_path, proc=proc, awaiting_result=True,
                                 awaiting_since=time.time(), current_run_id="RUN-1")}

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))

    assert "C1" in live and proc.killed is False                # held — mid-turn, not yielded
    assert not sigs
    assert not any(u.endswith("/wake-ack") for u, _ in posts)   # no release while mid-turn


def test_service_residents_pending_human_precedes_auto_wake_yield(monkeypatch, tmp_path):
    """#266: a real pending HUMAN turn wins over a due clock auto-wake — the resident answers the human
    (conversation_turn run) and does NOT yield, even with auto_wake_due. Guards against auto-wake tearing
    down a session that owes a human a reply."""
    notifier._RESIDENT_DRAIN_YIELD.clear()
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": "sess-9", "pending_human": True, "last_turn_seq": 3,
            "pending_inbox": 0, "inbox_ack_ts": None, "auto_wake_due": True}
    posts = _wire(monkeypatch, active=[conv],
                  turns=[{"seq": 3, "role": "human", "content": "are you there?"}])
    proc = ResidentProc()
    live = {"C1": _idle_resident(tmp_path, proc=proc)}

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))

    assert not any(u.endswith("/wake-ack") for u, _ in posts)   # no yield/release
    run = next(b for u, b in posts if u.endswith("/runs"))
    assert run["wake_event"] == "conversation_turn"             # answered the human, not yielded
    assert live["C1"]["proc"] is proc and proc.killed is False  # SAME warm resident kept the lease


# ---------- #247 B3: warm-zone drain SIDECAR — the Kedar-locked §3 ONE-EMBODIMENT invariants ----------

def test_service_residents_sidecar_running_preserves_single_embodiment(monkeypatch, tmp_path):
    """#247 B3 §3 HARD MANDATE (Kedar-locked ONE-EMBODIMENT, B2 @c2b15b5). With a resident lease HELD
    and a drain sidecar ALREADY running, the tick must: (a) keep the SAME resident (one body), renewing
    its lease; (b) NOT spawn a second drain sidecar (no double-embodiment); (c) NOT release/teardown the
    resident; (d) keep the existing sidecar handle. The sidecar holds NO lease and NO worker_run, so it
    can never be mistaken for the embodiment. Mutation tooth: drop the `r['sidecar']` short-circuit and a
    SECOND sidecar is spawned + the inbox-drain path re-runs → this flips RED."""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": "sess-9", "pending_human": False, "last_turn_seq": 2,
            "pending_inbox": 3, "inbox_ack_ts": 30.0, "model": "claude-opus-4-8"}
    posts, sigs, fed = _wire_drain(monkeypatch, active=[conv])
    spawns = _stub_spawn(monkeypatch, proc=ResidentProc(pid=10001))   # would-be SECOND sidecar
    proc = ResidentProc()
    running_sidecar = ResidentProc(pid=9999, alive=True)              # first sidecar, still draining
    live = {"C1": _idle_resident(tmp_path, proc=proc,
                                 sidecar={"proc": running_sidecar, "log_path": tmp_path / "d.log",
                                          "hard_deadline": time.time() + 1000})}

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))

    assert "C1" in live and proc.killed is False                  # (a/c) resident KEPT, not torn down
    assert live["C1"]["sidecar"]["proc"] is running_sidecar       # (d) same sidecar, not replaced
    assert running_sidecar.killed is False                        # not killed (within its deadline)
    assert spawns == []                                           # (b) NO second drain sidecar
    assert not sigs                                              # resident NOT graceful-killed
    assert not any(u.endswith("/wake-ack") for u, _ in posts)    # lease NOT released
    assert any(u.endswith("/wake-renew") for u, _ in posts)      # single embodiment lease RENEWED
    assert not any(u.endswith("/runs") for u, _ in posts)        # sidecar opens NO worker_run (§3)


def test_service_residents_reaps_finished_sidecar_parks_cursor(monkeypatch, tmp_path):
    """#247 B3 §3(d) + Gate P1a: when the drain sidecar EXITS CLEANLY (rc 0), the tick clears its handle
    (no worker_run to /finish — clean by construction) AND posts EXACTLY ONE wake-ack that PARKS the
    wake cursor (delivered_ts=the stashed spawn-time ack_ts) with release_lease=False — so the drained
    backlog stops re-surfacing as pending_inbox while the warm resident + lease are KEPT. One transition
    per tick: it does NOT immediately spawn another drain. Mutation tooth: drop the success ack and the
    cursor never advances → the warm resident re-sees the whole backlog on its real wake (this flips
    RED on the wake-ack assertion)."""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": "sess-9", "pending_human": False, "last_turn_seq": 2,
            "pending_inbox": 2, "inbox_ack_ts": 30.0}
    posts, sigs, fed = _wire_drain(monkeypatch, active=[conv])
    spawns = _stub_spawn(monkeypatch, proc=ResidentProc(pid=10001))
    proc = ResidentProc()
    dead_sidecar = ResidentProc(pid=9999, alive=False)               # exited cleanly (returncode 0)
    live = {"C1": _idle_resident(tmp_path, proc=proc,
                                 sidecar={"proc": dead_sidecar, "log_path": tmp_path / "d.log",
                                          "hard_deadline": time.time() + 1000, "ack_ts": 30.0})}

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))

    assert live["C1"]["sidecar"] is None                          # handle cleared on exit (clean)
    assert "C1" in live and proc.killed is False                  # warm resident + lease KEPT
    assert spawns == []                                          # no same-tick re-spawn (one/tick)
    acks = [b for u, b in posts if u.endswith("/wake-ack")]
    assert len(acks) == 1                                        # P1a: EXACTLY one cursor-park ack
    assert acks[0]["delivered_ts"] == 30.0                       # parked at the stashed spawn-time mark
    assert acks[0]["release_lease"] is False                     # KEEP the warm lease (no A2 yield)
    assert acks[0]["kind"] == "resident_drain_sidecar"
    assert not any(u.endswith("/runs") for u, _ in posts)        # nothing to finish (no run)


def test_service_residents_kills_wedged_sidecar_keeps_resident(monkeypatch, tmp_path):
    """#247 B3 §8/§3 + Gate P1a tooth 3: a WEDGED drain sidecar (still alive PAST its own hard deadline)
    is graceful-killed so it can never pin the resident lease open — but the warm resident + its lease are
    KEPT (the sidecar's death is independent of the embodiment). A wedged-kill is NOT a clean completion,
    so the cursor is NOT advanced even though an ack_ts is stashed — the partially-drained backlog must
    re-surface for a fresh drain. Mutation tooth: drop the hard-deadline kill and a wedged sidecar runs
    unbounded (no SIGTERM recorded, handle never cleared) → this flips RED; ack-on-failure would flip the
    wake-ack assertion RED."""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": "sess-9", "pending_human": False, "last_turn_seq": 2,
            "pending_inbox": 2, "inbox_ack_ts": 30.0}
    posts, sigs, fed = _wire_drain(monkeypatch, active=[conv])
    proc = ResidentProc()
    wedged = ResidentProc(pid=9999, alive=True)                      # still running, past deadline
    live = {"C1": _idle_resident(tmp_path, proc=proc,
                                 sidecar={"proc": wedged, "log_path": tmp_path / "d.log",
                                          "hard_deadline": time.time() - 1, "ack_ts": 30.0})}

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))

    assert sigs and sigs[0] == (9999, notifier.signal.SIGTERM)    # the SIDECAR (pid 9999) was killed
    assert live["C1"]["sidecar"] is None                          # handle cleared after the kill
    assert "C1" in live and proc.killed is False                  # resident + lease KEPT (pid 4321 alive)
    assert not any(u.endswith("/wake-ack") for u, _ in posts)    # tooth 3: NO cursor ack on wedged-kill


def test_service_residents_failed_sidecar_does_not_park_cursor(monkeypatch, tmp_path):
    """#247 B3 Gate P1a tooth 3 (the other failure mode): a drain sidecar that EXITS NATURALLY but with
    a NON-ZERO return code drained the backlog only partially — so the tick clears its handle (keeping
    the warm resident + lease) but DOES NOT advance the wake cursor. The un-acked events stay pending and
    a fresh drain runs next tick — nothing is silently acked away on a failed drain. Mutation tooth: ack
    unconditionally on `done` (drop the `success`/returncode guard) and this flips RED (a wake-ack would
    appear, marking a half-drained backlog delivered)."""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": "sess-9", "pending_human": False, "last_turn_seq": 2,
            "pending_inbox": 2, "inbox_ack_ts": 30.0}
    posts, sigs, fed = _wire_drain(monkeypatch, active=[conv])
    spawns = _stub_spawn(monkeypatch, proc=ResidentProc(pid=10001))
    proc = ResidentProc()
    failed_sidecar = ResidentProc(pid=9999, alive=False)             # exited...
    failed_sidecar.returncode = 1                                    # ...but with a FAILURE code
    live = {"C1": _idle_resident(tmp_path, proc=proc,
                                 sidecar={"proc": failed_sidecar, "log_path": tmp_path / "d.log",
                                          "hard_deadline": time.time() + 1000, "ack_ts": 30.0})}

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))

    assert live["C1"]["sidecar"] is None                          # handle cleared (no run to finish)
    assert "C1" in live and proc.killed is False                  # warm resident + lease KEPT
    assert spawns == []                                          # one transition per tick (no re-spawn)
    assert not any(u.endswith("/wake-ack") for u, _ in posts)    # tooth 3: NO cursor ack on a failed exit


def test_service_residents_warm_zone_holds_to_1200s(monkeypatch, tmp_path):
    """#247 B3 §5.1: the warm-zone idle-reap window is 1200s. A resident idle for 1000s — well under
    1200 but OVER the OLD 900 — is NOT reaped; it stays warm. Mutation tooth: revert the constant to
    900.0 and this resident WOULD be reaped (live=={}) → this flips RED."""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": "sess-9", "pending_human": False, "last_turn_seq": 2,
            "pending_inbox": 0, "inbox_ack_ts": None}
    posts, sigs, fed = _wire_drain(monkeypatch, active=[conv])
    proc = ResidentProc()
    live = {"C1": _idle_resident(tmp_path, proc=proc,
                                 last_activity_ts=time.time() - 1000.0)}   # 1000s: in the warm zone

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))

    assert "C1" in live and proc.killed is False                  # 1000s < 1200s → warm, NOT reaped
    assert not sigs                                              # no graceful close
    assert not any(u.endswith("/wake-ack") for u, _ in posts)    # lease NOT released


def test_service_residents_drain_sidecar_spawn_failure_falls_open_to_yield(monkeypatch, tmp_path):
    """#247 B3 §8 fail-open: if the drain sidecar can't be spawned (spawn raises / returns not-sent),
    the resident falls back to the A2 idle-YIELD — graceful close + lease release so the next tick's
    ephemeral drains the backlog. Never crashes, never strands. Mutation tooth: remove the try/except +
    fallback and a spawn exception propagates (the call raises instead of cleanly yielding)."""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": "sess-9", "pending_human": False, "last_turn_seq": 2,
            "pending_inbox": 3, "inbox_ack_ts": 30.0, "model": "claude-opus-4-8"}
    posts, sigs, fed = _wire_drain(monkeypatch, active=[conv])
    _stub_spawn(monkeypatch, raises=True)                            # spawn blows up
    proc = ResidentProc()
    live = {"C1": _idle_resident(tmp_path, proc=proc)}

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))    # must NOT raise

    assert live == {}                                            # fell open → yielded the embodiment
    assert sigs and sigs[0][1] == notifier.signal.SIGTERM        # graceful close on the yield fallback
    ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert ack["kind"] == "resident_inbox_drain_yield" and ack["release_lease"] is True
    assert fed == []                                            # nothing injected into the warm session


def test_service_residents_reaps_crashed_resident(monkeypatch, tmp_path):
    """A resident process that exited mid-turn → its in-flight run is finished 'killed' and the
    lease released; next tick re-detects the still-unanswered human turn and respawns."""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": "sess-9", "pending_human": True, "last_turn_seq": 1}
    posts = _wire(monkeypatch, active=[conv],
                  turns=[{"seq": 1, "role": "human", "content": "hi"}])
    # the unanswered turn would trigger a same-tick respawn; stub it to a no-spawn so this test
    # isolates the CRASH-reap path (same-tick recovery is exercised by the cold-boot test).
    monkeypatch.setattr(notifier, "spawn_resident", lambda *a, **k: (False, "r", None))
    live = {"C1": {"proc": ResidentProc(alive=False), "agent_id": "A1", "conversation_id": "C1",
                   "alias": "Vox", "log_path": tmp_path / "c.ndjson", "session_id": "sess-9",
                   "session_pinned": True, "cold": False, "serviced_seq": 1,
                   "current_run_id": "RUN-1", "run_id": "RUN-1", "awaiting_result": True,
                   "turn_scan_offset": 0, "lines_offset": 0, "lines_buf": b"", "lines_seq": 1,
                   "last_activity_ts": time.time()}}

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))

    assert live == {}                                                    # dropped
    fin = next(b for u, b in posts if u.endswith("/runs/RUN-1/finish"))
    assert fin["status"] == "killed"
    ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert ack["kind"] == "resident_exited" and ack["release_lease"] is True


# ---------- E3 + Vault #120: V1 history-prefix injection (cold-boot only) ----------

_HISTORY_TURNS = [{"seq": 1, "role": "human", "content": "old q"},
                  {"seq": 2, "role": "agent", "content": "old a"},
                  {"seq": 3, "role": "human", "content": "new q"}]   # seq3 is the unanswered turn


def test_cold_boot_injects_history_prefix_and_feeds_unanswered_turn(monkeypatch, tmp_path):
    """When Vault's formatter is present, a COLD boot prepends the RESOLVED turns (≤ last agent
    reply) after persona, and feeds only the UNANSWERED turn (seq3) — never the already-answered
    seq1."""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": None, "pending_human": True, "last_turn_seq": 3}
    posts = _wire(monkeypatch, active=[conv], turns=_HISTORY_TURNS)
    monkeypatch.setattr(notifier, "_format_history",
                        lambda prior: "## Conversation so far\n" + ";".join(t["content"] for t in prior))
    proc = ResidentProc()
    spawned = []
    monkeypatch.setattr(notifier, "spawn_resident",
                        lambda *a, **k: spawned.append((a, k)) or (True, "r", proc))
    live = {}

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))

    sp = spawned[0][1]["system_prompt"]
    assert "PERSONA" in sp and "## Conversation so far" in sp and "old q;old a" in sp
    assert spawned[0][1]["resume_session_id"] is None                    # cold boot
    proc.stdin.seek(0)
    assert json.loads(proc.stdin.read().decode())["message"]["content"][0]["text"] == "new q"
    assert live["C1"]["serviced_seq"] == 3                               # fed seq3, skipped seq1


def test_cold_boot_skips_already_answered_turns_without_formatter(monkeypatch, tmp_path):
    """The serviced-past-last-agent fix is independent of the (optional) history formatter: with
    _format_history unavailable, a cold boot still skips the resolved seq1/seq2 and feeds only the
    unanswered seq3 — no re-answering an old question, no history block. We force the no-formatter
    case explicitly (now that conversation_prefix.py is merged in main, the optional import
    resolves, so we can't rely on it being absent)."""
    monkeypatch.setattr(notifier, "_format_history", None)
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": None, "pending_human": True, "last_turn_seq": 3}
    posts = _wire(monkeypatch, active=[conv], turns=_HISTORY_TURNS)
    proc = ResidentProc()
    spawned = []
    monkeypatch.setattr(notifier, "spawn_resident",
                        lambda *a, **k: spawned.append((a, k)) or (True, "r", proc))
    live = {}

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))

    assert spawned[0][1]["system_prompt"] == "PERSONA"                   # persona only, no history
    proc.stdin.seek(0)
    assert json.loads(proc.stdin.read().decode())["message"]["content"][0]["text"] == "new q"
    assert live["C1"]["serviced_seq"] == 3


def test_cold_boot_cursor_uses_newest_agent_reply_not_oldest_page(monkeypatch, tmp_path):
    """Review P2: `serviced` must derive from the NEWEST agent reply, not the oldest page. Simulate
    a long conversation whose recent page ends agent(300), human(301-pending): the resident must
    feed seq 301, never an ancient turn. (The boot fetch now hits the agent's active-conversation
    read = the newest page, so resolved_through sees seq 300.)"""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": None, "pending_human": True, "last_turn_seq": 301}
    recent = [{"seq": 299, "role": "human", "content": "old"},
              {"seq": 300, "role": "agent", "content": "answered"},
              {"seq": 301, "role": "human", "content": "latest pending"}]
    _wire(monkeypatch, active=[conv], turns=recent)
    proc = ResidentProc()
    monkeypatch.setattr(notifier, "spawn_resident", lambda *a, **k: (True, "r", proc))
    live = {}

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))

    proc.stdin.seek(0)
    assert json.loads(proc.stdin.read().decode())["message"]["content"][0]["text"] == "latest pending"
    assert live["C1"]["serviced_seq"] == 301              # newest agent (300) → feed 301, not an old turn


def test_warm_resume_skips_history_and_persona(monkeypatch, tmp_path):
    """A WARM boot (--resume a pinned session) injects NEITHER persona NOR history (both are
    already in-session — double-injection would duplicate them); the serviced-bump still applies
    so it feeds the unanswered turn."""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": "sess-9", "pending_human": True, "last_turn_seq": 3}
    posts = _wire(monkeypatch, active=[conv], turns=_HISTORY_TURNS)
    # even if the formatter exists, the warm path must NOT call it
    monkeypatch.setattr(notifier, "_format_history", lambda prior: "SHOULD-NOT-APPEAR")
    proc = ResidentProc()
    spawned = []
    monkeypatch.setattr(notifier, "spawn_resident",
                        lambda *a, **k: spawned.append((a, k)) or (True, "r", proc))
    live = {}

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))

    assert spawned[0][1]["system_prompt"] is None                        # warm — nothing injected
    assert spawned[0][1]["resume_session_id"] == "sess-9"
    proc.stdin.seek(0)
    assert json.loads(proc.stdin.read().decode())["message"]["content"][0]["text"] == "new q"
    assert live["C1"]["serviced_seq"] == 3


# ---------- ISS-8: resident runs in an isolated worktree (Kedar-greenlit narrow fix) ----------

def test_safe_teardown_worktree_preserves_dirty(monkeypatch):
    """A resident's un-pushed conversational work must NEVER be force-discarded."""
    monkeypatch.setattr(notifier, "_run_git", lambda args, **k: (0, " M f.py\n"))
    removed = []
    monkeypatch.setattr(notifier, "_teardown_worktree", lambda *a, **k: removed.append(a))
    assert notifier._safe_teardown_worktree("/base", "/wt", "br") == "preserved-dirty"
    assert removed == []


def test_safe_teardown_worktree_removes_clean(monkeypatch):
    monkeypatch.setattr(notifier, "_run_git", lambda args, **k: (0, ""))
    removed = []
    monkeypatch.setattr(notifier, "_teardown_worktree", lambda *a, **k: removed.append(a))
    assert notifier._safe_teardown_worktree("/base", "/wt", "br") == "removed"
    assert removed == [("/base", "/wt", "br")]


def test_safe_teardown_worktree_noop_without_worktree():
    assert notifier._safe_teardown_worktree("/base", None, None) == "noop"


def test_service_residents_boots_in_isolated_worktree(monkeypatch, tmp_path):
    """ISS-8: the resident spawns IN a provisioned worktree (off origin/main), not base_cwd —
    so conversational code work can't open a PR off the shared main checkout (Page's bug)."""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": None, "pending_human": True, "last_turn_seq": 1}
    _wire(monkeypatch, active=[conv], turns=[{"seq": 1, "role": "human", "content": "hi"}])
    monkeypatch.setattr(notifier, "_is_git_repo", lambda cwd: True)
    monkeypatch.setattr(notifier, "_provision_resident_worktree", lambda base, conv: ("/wt/Vox", "orcha/resident-C1"))
    spawned_cwd = []
    monkeypatch.setattr(notifier, "spawn_resident",
                        lambda cwd, **k: spawned_cwd.append(cwd) or (True, "r", ResidentProc()))
    live = {}
    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))
    assert spawned_cwd == ["/wt/Vox"]                                  # ran IN the worktree
    assert live["C1"]["worktree"] == "/wt/Vox"
    assert live["C1"]["branch"] == "orcha/resident-C1"
    assert live["C1"]["base_cwd"] == str(tmp_path)


def test_service_residents_fails_closed_when_worktree_provision_fails(monkeypatch, tmp_path):
    """review [P1]: in a git checkout, if worktree isolation FAILS, the resident must NOT boot in
    the shared checkout (that's the ISS-8 hazard) — release the lease + skip instead."""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": None, "pending_human": True, "last_turn_seq": 1}
    posts = _wire(monkeypatch, active=[conv], turns=[{"seq": 1, "role": "human", "content": "hi"}])
    monkeypatch.setattr(notifier, "_is_git_repo", lambda cwd: True)
    monkeypatch.setattr(notifier, "_provision_resident_worktree", lambda base, conv: (None, None))   # isolation failed
    spawned = []
    monkeypatch.setattr(notifier, "spawn_resident", lambda *a, **k: spawned.append(1) or (True, "r", ResidentProc()))
    live = {}
    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))
    assert spawned == [] and live == {}                               # FAILED CLOSED — no boot in main
    ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert ack["kind"] == "resident_failed" and ack["release_lease"] is True
    assert not any(u.endswith("/runs") for u, _ in posts)


def test_service_residents_non_git_boots_in_base_cwd(monkeypatch, tmp_path):
    """Explicit fallback: a NON-git project has no shared main to tangle, so the resident may boot
    in base_cwd (no isolation needed, no ISS-8 hazard)."""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": None, "pending_human": True, "last_turn_seq": 1}
    _wire(monkeypatch, active=[conv], turns=[{"seq": 1, "role": "human", "content": "hi"}])
    monkeypatch.setattr(notifier, "_is_git_repo", lambda cwd: False)
    provisioned = []
    monkeypatch.setattr(notifier, "_provision_resident_worktree",
                        lambda base, conv: provisioned.append(1) or ("/wt/x", "br"))
    spawned_cwd = []
    monkeypatch.setattr(notifier, "spawn_resident",
                        lambda cwd, **k: spawned_cwd.append(cwd) or (True, "r", ResidentProc()))
    live = {}
    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))
    assert provisioned == []                                          # didn't even try to provision
    assert spawned_cwd == [str(tmp_path)]                             # booted in base_cwd
    assert live["C1"]["worktree"] is None


def _idle_reapable(tmp_path):
    return {"C1": {"proc": ResidentProc(), "agent_id": "A1", "conversation_id": "C1", "alias": "Vox",
                   "log_path": tmp_path / "c.ndjson", "worktree": "/wt/Vox", "branch": "orcha/resident-C1",
                   "base_cwd": str(tmp_path), "session_id": "sess-9", "session_pinned": True,
                   "cold": False, "serviced_seq": 2, "current_run_id": None, "run_id": None,
                   "awaiting_result": False, "turn_scan_offset": 0, "booted_ts": time.time() - 1000,
                   "lines_offset": 0, "lines_buf": b"", "lines_seq": 1,
                   "last_activity_ts": time.time() - (notifier.RESIDENT_IDLE_REAP_SECS + 10)}}


def test_service_residents_idle_reap_keeps_worktree(monkeypatch, tmp_path):
    """ISS-61: on idle-reap the lease is released BUT the STABLE worktree is KEPT (the next
    --resume boot reuses it so claude's session cwd doesn't change). Teardown is conversation-end
    only — tearing it down on every idle was what broke warm-resume."""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": "sess-9", "pending_human": False, "last_turn_seq": 2}
    posts = _wire(monkeypatch, active=[conv])
    monkeypatch.setattr(notifier.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(notifier.os, "killpg", lambda pgid, sig: None)
    teardowns = []
    monkeypatch.setattr(notifier, "_safe_teardown_worktree",
                        lambda base, wt, br: teardowns.append((base, wt, br)) or "removed")
    live = _idle_reapable(tmp_path)
    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))
    assert teardowns == []                                              # worktree KEPT for --resume
    assert live == {}                                                  # resident reaped
    assert any(u.endswith("/wake-ack") and b.get("release_lease") for u, b in posts)


def test_service_residents_conversation_end_tears_down_worktree(monkeypatch, tmp_path):
    """When the human ENDS the conversation (it leaves active-conversations), the worktree IS torn
    down (nothing left to resume into)."""
    posts = _wire(monkeypatch, active=[])     # C1 no longer active → conversation_ended path
    monkeypatch.setattr(notifier.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(notifier.os, "killpg", lambda pgid, sig: None)
    teardowns = []
    monkeypatch.setattr(notifier, "_safe_teardown_worktree",
                        lambda base, wt, br: teardowns.append((base, wt, br)) or "removed")
    live = _idle_reapable(tmp_path)
    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))
    assert teardowns == [(str(tmp_path), "/wt/Vox", "orcha/resident-C1")]   # torn down on end
    assert live == {}


def test_service_residents_cold_fallback_on_fast_warm_crash(monkeypatch, tmp_path):
    """ISS-61: a WARM (--resume) boot that dies within the resume window flags the conversation to
    COLD-boot next time (don't re-attempt a session claude can't find → no crash-loop)."""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": "sess-9", "pending_human": False, "last_turn_seq": 1}
    _wire(monkeypatch, active=[conv])
    notifier._RESIDENT_RESUME_FAILED.discard("C1")
    dead = ResidentProc()
    dead.returncode = 1                         # already exited (crashed)
    live = {"C1": {"proc": dead, "agent_id": "A1", "conversation_id": "C1", "alias": "Vox",
                   "log_path": tmp_path / "c.ndjson", "worktree": "/wt/Vox", "branch": "orcha/resident-C1",
                   "base_cwd": str(tmp_path), "session_id": "sess-9", "session_pinned": True,
                   "cold": False, "serviced_seq": 1, "current_run_id": None, "run_id": None,
                   "awaiting_result": False, "turn_scan_offset": 0, "booted_ts": time.time() - 2,  # died fast
                   "lines_offset": 0, "lines_buf": b"", "lines_seq": 1, "last_activity_ts": time.time()}}
    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))
    assert "C1" in notifier._RESIDENT_RESUME_FAILED          # flagged → next boot COLD
    notifier._RESIDENT_RESUME_FAILED.discard("C1")          # cleanup module state


# ---------- ISS-60: a HUNG turn (awaiting_result forever) is hard-capped + lease released ----------

def test_service_residents_hard_caps_hung_turn_and_releases_lease(monkeypatch, tmp_path):
    """ISS-60: a turn that never lands its `result` would otherwise keep the resident
    awaiting_result forever — idle-reap can't fire and the daemon renews the lease every tick,
    suppressing ALL ephemeral wakes for the agent. Hard-cap it: graceful close + lease release."""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": "sess-9", "pending_human": False, "last_turn_seq": 1}
    log = tmp_path / "c.ndjson"   # NO result line → the turn never finishes
    log.write_text('{"type":"assistant","message":{"content":[{"type":"text","text":"thinking"}]}}\n')
    posts = _wire(monkeypatch, active=[conv])
    monkeypatch.setattr(notifier.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(notifier.os, "killpg", lambda pgid, sig: None)
    live = {"C1": {"proc": ResidentProc(), "agent_id": "A1", "conversation_id": "C1", "alias": "Vox",
                   "log_path": log, "session_id": "sess-9", "session_pinned": True, "cold": False,
                   "serviced_seq": 1, "current_run_id": "RUN-1", "run_id": "RUN-1",
                   "awaiting_result": True,
                   "awaiting_since": time.time() - (notifier.HARD_CAP_MIN_SECS + 60),   # hung past the cap
                   "turn_scan_offset": 0, "lines_offset": 0, "lines_buf": b"", "lines_seq": 1,
                   "last_activity_ts": time.time()}}
    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))
    assert live == {}                                                    # reaped
    ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert ack["kind"] == "resident_hung" and ack["release_lease"] is True   # lease RELEASED
    assert any(u.endswith("/runs/RUN-1/finish") for u, _ in posts)      # hung run finished


def test_service_residents_does_not_reap_turn_within_cap(monkeypatch, tmp_path):
    """A turn still awaiting a result but WITHIN the hard cap is left to run (renews its lease)."""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": "sess-9", "pending_human": False, "last_turn_seq": 1}
    log = tmp_path / "c.ndjson"
    log.write_text('{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}\n')
    posts = _wire(monkeypatch, active=[conv])
    live = {"C1": {"proc": ResidentProc(), "agent_id": "A1", "conversation_id": "C1", "alias": "Vox",
                   "log_path": log, "session_id": "sess-9", "session_pinned": True, "cold": False,
                   "serviced_seq": 1, "current_run_id": "RUN-1", "run_id": "RUN-1",
                   "awaiting_result": True, "awaiting_since": time.time() - 30,   # well within the cap
                   "turn_scan_offset": 0, "lines_offset": 0, "lines_buf": b"", "lines_seq": 1,
                   "last_activity_ts": time.time()}}
    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))
    assert "C1" in live                                                  # NOT reaped
    assert any(u.endswith("/wake-renew") for u, _ in posts)             # lease renewed (still warm)
    assert not any(u.endswith("/wake-ack") for u, _ in posts)           # NOT released


# ---------- _overlay_runtime_config (worktree runtime overlay) ----------

def _overlay_base(tmp_path):
    """A project .claude/ with the three gitignored runtime pieces a fresh worktree lacks."""
    claude = tmp_path / "base" / ".claude"
    (claude / "orcha-tabs").mkdir(parents=True)
    (claude / "orcha.json").write_text('{"api_base_url": "http://x:8000"}')
    (claude / "orcha-tabs" / "Vault.json").write_text('{"alias": "Vault"}')
    (claude / "settings.json").write_text(
        '{"hooks": {"SessionEnd": [{"hooks": [{"type": "command", "command": "orcha snapshot"}]}]}}')
    return tmp_path / "base"


def test_overlay_copies_settings_json_for_sessionend_hook(tmp_path):
    """Regression: the live-terminal / headless worktree had no SessionEnd `orcha snapshot`
    hook because the overlay copied only orcha.json + orcha-tabs, never settings.json — so
    snapshot-on-close silently never fired. The overlay must carry settings.json too."""
    base = _overlay_base(tmp_path)
    wt = tmp_path / "wt"
    wt.mkdir()
    notifier._overlay_runtime_config(base, wt)
    settings = wt / ".claude" / "settings.json"
    assert settings.exists(), "settings.json was not overlaid — SessionEnd snapshot hook missing"
    assert "orcha snapshot" in settings.read_text()
    # the pre-existing overlay pieces must still land
    assert (wt / ".claude" / "orcha.json").exists()
    assert (wt / ".claude" / "orcha-tabs" / "Vault.json").exists()


def test_overlay_tolerates_missing_settings_json(tmp_path):
    """No settings.json in the base (un-hooked project) → overlay still succeeds, just no copy."""
    base = _overlay_base(tmp_path)
    (base / ".claude" / "settings.json").unlink()
    wt = tmp_path / "wt"
    wt.mkdir()
    notifier._overlay_runtime_config(base, wt)              # must not raise
    assert not (wt / ".claude" / "settings.json").exists()
    assert (wt / ".claude" / "orcha.json").exists()         # the rest still overlaid
