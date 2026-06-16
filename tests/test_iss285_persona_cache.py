"""#285 — cache/reuse persona+digest across wakes (daemon-side fetch/build cache).

The notifier is a long-lived loop, so an agent's persona (static until edited) and its #287-curated
digest are stable between close-together wakes. Before #285, EVERY wake re-GET /persona + /digest
and re-ran the (LLM) digest curation. _build_persona now serves the (persona, curated_digest) pair
from a short-TTL per-agent cache, with two hard invariants these teeth pin:

  * the protocol (RULES) is NEVER cached — fetched fresh every wake so a human edit applies on the
    very next wake (#326 A1);
  * the checkpoint/respawn path passes force_fresh=True so a just-written continuity digest is never
    served stale (the whole safety bar of #285).

Each test mutation-verifies: it fails if the behavior it pins is neutered.
"""
import io
import json
import re
import time

from orcha_cli import notifier  # noqa: E402  (conftest puts orcha-cli on sys.path)


def _fake_get(state, counts):
    """A counting stand-in for notifier._get_json. `state` is mutable so a test can change what
    a later wake would fetch; `counts` records how many times each endpoint was hit."""
    def fake(url, timeout=8.0):
        if url.endswith("/persona"):
            counts["persona"] += 1
            return state["persona"]
        if url.endswith("/digest"):
            counts["digest"] += 1
            return state["digest"]
        if url.endswith("/protocol"):
            counts["protocol"] += 1
            return state["protocol"]
        return None
    return fake


def _wire(monkeypatch, state, *, ttl=90.0):
    """Common harness: isolate the cache, neutralize #287 curation (separately tested) so the
    digest passes through verbatim, pin a TTL, and install the counting _get_json."""
    notifier._clear_persona_cache()
    monkeypatch.setattr(notifier, "_digest_curate", None)
    monkeypatch.setattr(notifier, "_PERSONA_CACHE_TTL_SECS", ttl)
    counts = {"persona": 0, "digest": 0, "protocol": 0}
    monkeypatch.setattr(notifier, "_get_json", _fake_get(state, counts))
    return counts


def test_second_wake_within_ttl_reuses_persona_and_digest(monkeypatch):
    """A 2nd wake within the TTL makes ZERO new persona/digest fetches — served from cache."""
    state = {"persona": {"system_prompt": "You are Tim."},
             "digest": {"digest": {"current_focus": "epic 285"}},
             "protocol": {"protocol": {"notes": "one task at a time"}}}
    counts = _wire(monkeypatch, state)

    out1 = notifier._build_persona("http://x", "agent-1")
    out2 = notifier._build_persona("http://x", "agent-1")

    assert counts["persona"] == 1   # fetched once, then cached (would be 2 without the cache)
    assert counts["digest"] == 1
    assert "epic 285" in out1 and "epic 285" in out2
    assert out1 == out2


def test_cache_expiry_refetches(monkeypatch):
    """Once the TTL has elapsed the entry is stale and the next wake re-fetches persona+digest."""
    state = {"persona": {"system_prompt": "You are Tim."},
             "digest": {"digest": {"current_focus": "epic 285"}},
             "protocol": {"protocol": {"notes": "rules"}}}
    counts = _wire(monkeypatch, state, ttl=0.0)   # every entry is born already expired

    notifier._build_persona("http://x", "agent-1")
    notifier._build_persona("http://x", "agent-1")

    assert counts["persona"] == 2   # both wakes re-fetched (would be 1 if expiry were ignored)
    assert counts["digest"] == 2


def test_respawn_force_fresh_bypasses_and_refreshes_cache(monkeypatch):
    """The respawn path's force_fresh=True must serve the JUST-WRITTEN continuity digest, never the
    cached pre-checkpoint one — and it refreshes the cache so following wakes reuse the fresh value.
    This is the #285 safety bar."""
    state = {"persona": {"system_prompt": "You are Tim."},
             "digest": {"digest": {"current_focus": "OLD continuity"}},
             "protocol": {"protocol": {"notes": "rules"}}}
    counts = _wire(monkeypatch, state)

    out1 = notifier._build_persona("http://x", "agent-1")             # caches OLD
    assert "OLD continuity" in out1

    # checkpoint writes a NEW continuity digest, then respawns wanting it
    state["digest"] = {"digest": {"current_focus": "NEW continuity"}}
    out2 = notifier._build_persona("http://x", "agent-1", force_fresh=True)

    assert "NEW continuity" in out2 and "OLD continuity" not in out2   # bypassed the stale cache
    assert counts["digest"] == 2                                       # re-fetched despite TTL

    # force_fresh refreshed the cache → a following normal wake serves NEW without a new fetch
    out3 = notifier._build_persona("http://x", "agent-1")
    assert "NEW continuity" in out3
    assert counts["digest"] == 2


def test_protocol_fetched_fresh_even_on_a_cached_wake(monkeypatch):
    """#326 (A1) regression guard: even when persona+digest are served from cache, the protocol
    (RULES) is re-fetched every wake, so a human edit applies on the very next wake. Caching the
    full formatted text instead of the components would break this — this tooth catches that."""
    state = {"persona": {"system_prompt": "You are Tim."},
             "digest": {"digest": {"current_focus": "epic 285"}},
             "protocol": {"protocol": {"notes": "RULE A"}}}
    counts = _wire(monkeypatch, state)

    out1 = notifier._build_persona("http://x", "agent-1")
    assert "RULE A" in out1

    state["protocol"] = {"protocol": {"notes": "RULE B edited"}}       # human edits the protocol
    out2 = notifier._build_persona("http://x", "agent-1")

    assert "RULE B edited" in out2 and "RULE A" not in out2            # protocol applied next wake
    assert counts["persona"] == 1                                      # persona WAS cached...
    assert counts["protocol"] == 2                                     # ...but protocol was not


def test_transient_fetch_failure_is_not_cached(monkeypatch):
    """A transient _get_json failure (None) must NOT be pinned for the TTL — else a real persona
    or digest would be suppressed on every wake in that window. The next wake retries."""
    state = {"persona": None,                                          # simulate a portal hiccup
             "digest": {"digest": {"current_focus": "epic 285"}},
             "protocol": {"protocol": {"notes": "rules"}}}
    counts = _wire(monkeypatch, state)

    notifier._build_persona("http://x", "agent-1")                     # persona None → not cached
    state["persona"] = {"system_prompt": "recovered"}
    out2 = notifier._build_persona("http://x", "agent-1")             # retries

    assert out2 and "recovered" in out2
    assert counts["persona"] == 2                                      # retried (would be 1 if poisoned)


def test_cache_is_keyed_per_agent(monkeypatch):
    """One agent's cached entry must not satisfy another agent's wake."""
    state = {"persona": {"system_prompt": "You are Tim."},
             "digest": {"digest": {"current_focus": "epic 285"}},
             "protocol": {"protocol": {"notes": "rules"}}}
    counts = _wire(monkeypatch, state)

    notifier._build_persona("http://x", "agent-1")
    notifier._build_persona("http://x", "agent-2")                     # different agent → fresh fetch

    assert counts["persona"] == 2
    assert counts["digest"] == 2


# ---------- #222 ↔ #285 seam: the digest_resync cold-reboot must not serve a stale cached digest ----------

class _ResidentProc:
    """Minimal Popen stand-in: a closeable stdin, a poll()able returncode."""
    def __init__(self, pid=4321):
        self.pid = pid
        self.returncode = None
        self.stdin = io.BytesIO()
    def poll(self):
        return self.returncode
    def kill(self):
        self.returncode = -9
    def wait(self, timeout=None):
        return self.returncode


def _drive_service_residents(monkeypatch, state, conv, turns):
    """Run ONE service_residents tick with the REAL _build_persona wired to a mutable `state`
    (persona/digest/protocol), so the per-agent cache is actually exercised end-to-end. Returns
    (spawned, live): the captured spawn_resident calls and the live-residents dict."""
    notifier._clear_persona_cache()
    monkeypatch.setattr(notifier, "_digest_curate", None)               # curation tested separately
    monkeypatch.setattr(notifier, "_PERSONA_CACHE_TTL_SECS", 90.0)

    def _get(url, **k):
        if "active-conversations" in url:
            return {"conversations": [conv]}
        if url.endswith("/persona"):
            return state["persona"]
        if url.endswith("/digest"):
            return state["digest"]
        if url.endswith("/protocol"):
            return state["protocol"]
        if "/turns" in url:
            m = re.search(r"after_seq=(\d+)", url)
            after = int(m.group(1)) if m else 0
            return {"turns": [t for t in turns if t.get("seq", 0) > after]}
        if "/conversation" in url:
            return {"conversation": {"id": "C1"}, "turns": turns}
        return None

    def _post(url, body, **k):
        if "wake-claim" in url:
            return {"claimed": True, "lease_kind": "resident"}
        if url.endswith("/runs"):
            return {"run_id": "RUN-1", "status": "running"}
        return {}

    monkeypatch.setattr(notifier, "_get_json", _get)
    monkeypatch.setattr(notifier, "_post_json", _post)
    monkeypatch.setattr(notifier, "_kill_worker", lambda *a, **k: None)
    monkeypatch.setattr(notifier, "_pump_one", lambda *a, **k: None)
    spawned = []
    monkeypatch.setattr(notifier, "spawn_resident",
                        lambda *a, **k: spawned.append((a, k)) or (True, "repr", _ResidentProc()))
    return spawned


def test_digest_resync_cold_reboot_serves_fresh_digest_not_cached(monkeypatch, tmp_path):
    """#285 ↔ #222 seam. A warm idle resident's (persona, digest) is already in the short-TTL
    cache. #222 then decides this agent's LIVE digest is newer than its session pin and evicts it
    (reason=digest_resync) so the same scan cold-reboots and re-injects the latest digest. Without
    popping the cache at that eviction, the cold reboot's _build_persona would re-serve the now-stale
    cached digest — defeating the very resync. This tooth drives the real path and asserts the spawn
    carries the NEW digest; it FAILS if the `_PERSONA_CACHE.pop(...)` at the eviction is removed."""
    state = {"persona": {"system_prompt": "You are Vox."},
             "digest": {"digest": {"current_focus": "OLD-before-resync"}},
             "protocol": {"protocol": {"notes": "rules"}}}
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": "99999999-8888-7777-6666-555555555555",
            "cold_required": True, "pending_human": True, "last_turn_seq": 3}
    turns = [{"seq": 3, "role": "human", "content": "fresh question"}]

    spawned = _drive_service_residents(monkeypatch, state, conv, turns)

    # warm the cache with the OLD digest the way a prior wake would have
    seeded = notifier._build_persona("http://x", "A1")
    assert "OLD-before-resync" in seeded

    # a live terminal writes a NEWER digest; #222 will flag cold_required and resync
    state["digest"] = {"digest": {"current_focus": "NEW-after-resync"}}
    old_proc = _ResidentProc(pid=1111)
    live = {"C1": {"proc": old_proc, "agent_id": "A1", "conversation_id": "C1", "alias": "Vox",
                   "log_path": tmp_path / "c.ndjson", "session_id": conv["session_id"],
                   "session_pinned": True, "cold": False, "serviced_seq": 2,
                   "current_run_id": None, "run_id": None, "awaiting_result": False,
                   "turn_scan_offset": 0, "lines_offset": 0, "lines_buf": b"", "lines_seq": 1,
                   "last_activity_ts": time.time()}}

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))

    assert spawned, "the resync should have cold-rebooted the resident"
    sysprompt = spawned[-1][1]["system_prompt"]
    assert "NEW-after-resync" in sysprompt          # the resync injected the FRESH digest...
    assert "OLD-before-resync" not in sysprompt      # ...never the stale cached one
    assert spawned[-1][1]["resume_session_id"] is None   # forced cold despite the pinned session
