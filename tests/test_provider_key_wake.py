"""Wake-path (triage / ack) uses a Settings-stored per-provider key — no env key required.

Closes the review blocker: the daemon's #288 triage and #307 routine-handoff (ack) run in the host
notifier, which previously only had env keys. The portal now carries the SEALED stored key for the
triage/ack provider on the wake-scan (`triage_key_enc` / `ack_key_enc`); the daemon unseals it
locally with the shared ORCHA_SECRET_KEY (no plaintext on the wire) and passes it to llm_util. These
tests prove an xAI key saved ONLY in Settings (sealed, no ORCHA_LLM_API_KEY / XAI_API_KEY in env)
reaches both wake paths.

Pure unit — no DB, no network: secret_box seals in-process, _llm_util + _post_json are monkeypatched.
"""
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "orcha-cli"))
from orcha_cli import notifier  # noqa: E402
from orcha_cli import secret_box  # noqa: E402

MASTER = "wake-path-master-key-0123456789"
XAI_KEY = "xai-stored-only-grok-key-4242"


class _FakeLLM:
    """Records the api_key llm_util receives, so we can assert the stored key flowed through."""
    def __init__(self):
        self.triage = None
        self.ack = None

    def triage_wake(self, event_text, *, config=None, api_key=None, **_):
        self.triage = {"config": config, "api_key": api_key}
        return {"wake": False, "reason": "ok"}

    def handoff_ack(self, text, *, config=None, api_key=None, **_):
        self.ack = {"config": config, "api_key": api_key}
        return {"ack": True, "text": "acknowledged"}


def _seal(monkeypatch):
    monkeypatch.delenv("ORCHA_LLM_API_KEY", raising=False)
    monkeypatch.delenv("XAI_API_KEY", raising=False)
    monkeypatch.setenv("ORCHA_SECRET_KEY", MASTER)
    return secret_box.seal(XAI_KEY, env={"ORCHA_SECRET_KEY": MASTER})


# ---- _unseal_scan_key: the sealed blob → plaintext, with env precedence preserved ----

def test_unseal_scan_key_returns_stored_key_no_env(monkeypatch):
    blob = _seal(monkeypatch)
    scan = {"triage_key_enc": blob}
    assert notifier._unseal_scan_key(scan, "triage_key_enc") == XAI_KEY


def test_unseal_scan_key_none_when_field_absent(monkeypatch):
    monkeypatch.setenv("ORCHA_SECRET_KEY", MASTER)
    monkeypatch.delenv("ORCHA_LLM_API_KEY", raising=False)
    assert notifier._unseal_scan_key({}, "triage_key_enc") is None
    assert notifier._unseal_scan_key({"triage_key_enc": None}, "triage_key_enc") is None


def test_unseal_scan_key_env_override_wins(monkeypatch):
    # resolve_llm_key precedence: an ORCHA_LLM_API_KEY env override shadows the stored blob.
    blob = _seal(monkeypatch)
    monkeypatch.setenv("ORCHA_LLM_API_KEY", "env-override-key")
    assert notifier._unseal_scan_key({"triage_key_enc": blob}, "triage_key_enc") == "env-override-key"


# ---- triage path: stored xAI key reaches llm_util.triage_wake ----

def test_triage_uses_stored_provider_key(monkeypatch):
    blob = _seal(monkeypatch)
    key = notifier._unseal_scan_key({"triage_key_enc": blob}, "triage_key_enc")
    assert key == XAI_KEY  # unsealed from Settings storage, no env key present
    fake = _FakeLLM()
    monkeypatch.setattr(notifier, "_llm_util", fake)
    notifier._triage_wake("some event", config={"triage": {"provider": "xai", "model": "grok-4.3"}},
                          api_key=key)
    assert fake.triage["api_key"] == XAI_KEY


# ---- ack path: stored xAI key reaches llm_util.handoff_ack ----

def test_ack_uses_stored_provider_key(monkeypatch):
    blob = _seal(monkeypatch)
    key = notifier._unseal_scan_key({"ack_key_enc": blob}, "ack_key_enc")
    assert key == XAI_KEY
    fake = _FakeLLM()
    monkeypatch.setattr(notifier, "_llm_util", fake)
    monkeypatch.setattr(notifier, "_post_json", lambda *a, **k: {"ok": True})
    verdict = {"action": "ack_close", "request_id": "req-1", "text": "thanks, closing"}
    cand = {"agent_id": "agent-1", "alias": "Sam"}
    acted = notifier._apply_wake_act("http://portal", cand, "evt", verdict,
                                     quiet=True, ack_api_key=key)
    assert acted is True
    assert fake.ack["api_key"] == XAI_KEY
