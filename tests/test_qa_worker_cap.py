"""A Quality run's worker gets room to finish: its device session dies with the worker, so the
20-minute checkpoint and replacement would start the run over (orcha_cli/notifier_wake_worker.py)."""

from __future__ import annotations

from types import SimpleNamespace

from orcha_cli import notifier, notifier_wake_worker as wake


def services(answer):
    return SimpleNamespace(_get_json=lambda url: answer, QUALITY_CAP_SECS=notifier.QUALITY_CAP_SECS)


def test_a_run_task_and_a_handed_off_task_get_the_quality_cap():
    long = notifier.QUALITY_CAP_SECS
    assert wake.worker_cap("http://x", "t", 1200.0, services({"is_run_task": True})) == long
    assert wake.worker_cap("http://x", "t", 1200.0, services({"is_run_task": False, "requests": [{"qa_task_id": "t"}]})) == long


def test_ordinary_work_keeps_its_cap():
    assert wake.worker_cap("http://x", "t", 1200.0, services({"is_run_task": False, "requests": [{"qa_task_id": "other"}]})) == 1200.0
    assert wake.worker_cap("http://x", "t", 1200.0, services(None)) == 1200.0
    assert wake.worker_cap("http://x", None, 1200.0, services({"is_run_task": True})) == 1200.0
