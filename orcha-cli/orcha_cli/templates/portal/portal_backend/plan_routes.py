"""Plan gating (Orcha Cloud local run — see docs/orcha-cloud-local-run.md,
'Addendum — plan gating'). Local run is the FREE SOLO tier; hosted boxes set
ORCHA_PLAN=team. No license keys / billing here — this is the env-driven
switch the addendum calls out as v1's entire enforcement mechanism.

Team-only features stay VISIBLE as entry points everywhere (nav, pages) but
render a paywall (frontend PremiumGate) and are refused server-side (402) —
the server is the actual enforcer; the frontend gate is UX, not security."""

import logging
import os

from fastapi import HTTPException, Request

from portal_backend.application import app

PLAN_ENV = "ORCHA_PLAN"
UPGRADE_URL_ENV = "ORCHA_UPGRADE_URL"
DEFAULT_UPGRADE_URL = "https://orcha.nursoftai.com/#pricing"
VALID_PLANS = ("solo", "team")

_LOG = logging.getLogger("orcha.plan")
_warned_unknown_plan = False  # log the "unknown ORCHA_PLAN value" warning once


def resolve_plan() -> str:
    """The active plan: env ORCHA_PLAN, 'solo' or 'team'. Unset or any other
    value defaults to 'solo' (the safe/free default) — an unrecognized value
    warns once per process rather than silently unlocking team features."""
    global _warned_unknown_plan
    raw = (os.environ.get(PLAN_ENV) or "").strip().lower()
    if not raw:
        return "solo"
    if raw in VALID_PLANS:
        return raw
    if not _warned_unknown_plan:
        _LOG.warning(
            "%s=%r is not a recognized plan (expected 'solo' or 'team') — "
            "defaulting to 'solo'",
            PLAN_ENV,
            raw,
        )
        _warned_unknown_plan = True
    return "solo"


def resolve_upgrade_url() -> str:
    """The upgrade CTA target: env ORCHA_UPGRADE_URL, else the pricing page."""
    return (os.environ.get(UPGRADE_URL_ENV) or "").strip() or DEFAULT_UPGRADE_URL


def plan_features(plan: str) -> dict:
    """The feature-flag map for a plan. Today: members (team-only)."""
    return {"members": plan == "team"}


@app.get("/api/plan")
def get_plan(request: Request):
    """The active plan, its feature flags, and where to upgrade. Open/unauthenticated
    — the frontend fetches this once per page load (extensions identity seam) to
    decide whether to render team-gated UI (Members roster) or the PremiumGate."""
    plan = resolve_plan()
    return {
        "plan": plan,
        "features": plan_features(plan),
        "upgrade_url": resolve_upgrade_url(),
    }


def require_feature(feature: str) -> None:
    """Raise 402 when the active plan lacks `feature`. Call as the FIRST check
    in any team-gated mutation route — server-side enforcement backing the
    frontend PremiumGate (belt-and-braces: the frontend gate is UX only)."""
    plan = resolve_plan()
    if plan_features(plan).get(feature):
        return
    labels = {
        "members": "team members",
    }
    label = labels.get(feature, feature)
    raise HTTPException(
        402,
        {
            "premium": feature,
            "message": f"{label.capitalize()} is a Team plan feature — "
            "upgrade to Orcha Cloud Team to use it.",
            "upgrade_url": resolve_upgrade_url(),
        },
    )
