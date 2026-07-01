import os

from orcha_cli import __main__ as cli


def test_usable_pairing_ip_rejects_local_addresses():
    assert cli._usable_pairing_ip("127.0.0.1") is None
    assert cli._usable_pairing_ip("0.0.0.0") is None
    assert cli._usable_pairing_ip("169.254.1.2") is None
    assert cli._usable_pairing_ip("192.168.1.24") == "192.168.1.24"


def test_export_pairing_host_sets_env_from_discovery(monkeypatch):
    monkeypatch.delenv("ORCHA_PAIRING_HOST", raising=False)
    monkeypatch.setattr(cli, "_discover_pairing_host", lambda: "192.168.1.24")

    cli._export_pairing_host()

    assert os.environ["ORCHA_PAIRING_HOST"] == "192.168.1.24"


def test_export_pairing_host_respects_operator_env(monkeypatch):
    monkeypatch.setenv("ORCHA_PAIRING_HOST", "10.0.0.5")
    monkeypatch.setattr(cli, "_discover_pairing_host", lambda: "192.168.1.24")

    cli._export_pairing_host()

    assert os.environ["ORCHA_PAIRING_HOST"] == "10.0.0.5"
