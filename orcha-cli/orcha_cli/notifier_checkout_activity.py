"""Small transport helpers for restart-safe checkout activity reservations."""

from __future__ import annotations


def pass_fds(activity) -> tuple[int, ...]:
    """Return the reservation descriptor to inherit into a spawned writer."""
    if activity is None:
        return ()
    fileno = getattr(activity, "fileno", None)
    if not callable(fileno):
        handle = getattr(activity, "handle", None)
        fileno = getattr(handle, "fileno", None)
    if not callable(fileno):
        return ()
    try:
        descriptor = int(fileno())
    except (OSError, TypeError, ValueError):
        return ()
    return (descriptor,) if descriptor >= 0 else ()


def preserve_unregistered_writer(
    api_base,
    services,
    *,
    cwd,
    owner_key,
    agent_id,
    activity,
    identity,
):
    """Record ambiguity before releasing a stopped writer with no run row."""
    recorder = getattr(services, "_record_checkout_overlap_evidence", None)
    if not callable(recorder) or not cwd:
        return None
    evidence = recorder(
        cwd,
        owner_key,
        run_id=f"unregistered:{identity}",
        agent_id=agent_id,
        other_rows=(),
        unknown_checkout_user=True,
    )
    if evidence is not None and bool(evidence):
        releaser = getattr(services, "_release_checkout_activity", None)
        if callable(releaser):
            releaser(cwd, activity=activity)
    return evidence
