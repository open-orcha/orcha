"""Remote-portal awareness — a workspace whose portal is NOT on this machine says so.

Field bug: a "local" workspace whose orcha.json pointed api_base at a cloud portal
created tasks THERE while its human believed everything was local — the human's
first hint was a foreign domain in a chat link. Two surfaces close the gap:

  R1  `remote_portal_notice(api_base)` — persona section for any NON-loopback
      portal host. GENERIC by design: it echoes whatever host is configured (a
      BYOC IP, a self-hosted domain, or a managed cloud); no deployment's domain
      is ever special-cased. Loopback → None (a local portal needs no notice).
  R2  `format_persona(..., api_base=)` appends the notice inside the stable
      (GH#34 cache-friendly) prefix, right after the workspace-gated blocks.

Each test carries a mutation note: revert the named production line → RED.
"""
from orcha_cli.notifier_persona import (
    format_persona,
    remote_portal_notice,
)

_PERSONA = {"system_prompt": "You are Test, a worker agent."}


# ---------- R1: the classifier ----------

def test_loopback_hosts_get_no_notice():
    """Mutation: drop the loopback short-circuit → localhost gets a notice → RED."""
    for base in ("http://localhost:8000", "http://127.0.0.1:8001",
                 "http://127.9.9.9:8000", "http://[::1]:8000",
                 "http://0.0.0.0:8000", None, ""):
        assert remote_portal_notice(base) is None, base


def test_remote_hosts_are_named_generically():
    """Any non-loopback host is named verbatim — BYOC IPs and custom domains get the
    exact same treatment as a managed cloud. Mutation: special-case any single
    domain (or drop the host echo) → RED."""
    for base, host in (
        ("https://orcha.example-corp.dev", "orcha.example-corp.dev"),
        ("http://192.168.1.7:8000", "192.168.1.7"),
        ("https://10.0.0.5", "10.0.0.5"),
        ("https://my-own-box.internal:8443/api", "my-own-box.internal"),
    ):
        notice = remote_portal_notice(base)
        assert notice is not None, base
        assert f"REMOTE: {host}" in notice
        assert host in notice.split("say plainly", 1)[1]  # the tell-the-human half


def test_notice_is_stable_for_caching():
    """GH#34: same api_base → byte-identical text (prompt-cache prefix). Mutation:
    embed anything volatile (a timestamp, a counter) → RED."""
    a = remote_portal_notice("https://orcha.example-corp.dev")
    b = remote_portal_notice("https://orcha.example-corp.dev")
    assert a == b


def test_unparseable_api_base_fails_quiet():
    """Garbage api_base must not crash persona assembly. Mutation: let urlsplit
    exceptions escape → RED."""
    assert remote_portal_notice("http://[not-a-host") is None


# ---------- R2: persona wiring ----------

def test_persona_carries_notice_for_remote_portal():
    """Mutation: drop the remote_portal_notice append in format_persona → RED."""
    out = format_persona(_PERSONA, None, api_base="https://orcha.example-corp.dev")
    assert "## Remote portal notice" in out
    assert "orcha.example-corp.dev" in out


def test_persona_clean_for_local_portal():
    out = format_persona(_PERSONA, None, api_base="http://127.0.0.1:8001")
    assert "Remote portal notice" not in out


def test_persona_clean_when_api_base_unknown():
    """No api_base (older callers, tests) → no notice, no crash."""
    out = format_persona(_PERSONA, None)
    assert "Remote portal notice" not in out
