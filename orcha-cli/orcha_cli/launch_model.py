"""Apply server admission state instead of an earlier discovery snapshot."""


def admitted_candidate(candidate, admission):
    """Older servers omit these fields; new servers authoritatively choose the next run."""
    refreshed = dict(candidate)
    for key in ("model", "model_runtime", "reasoning_effort"):
        if key in admission:
            refreshed[key] = admission[key]
    if admission.get("cold_required") or refreshed.get("model") != candidate.get("model"):
        refreshed["cold_required"] = True
        refreshed["session_id"] = None
    return refreshed
