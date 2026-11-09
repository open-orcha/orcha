"""What onboarding's agent steps are likely to cost, shown before anything spends (the original
`onboarding_map/estimates.py`'s typical rates; Orcha has no per-request cost history to read a
median from). The figures are list-price estimates of the agent's model use."""

from __future__ import annotations

#: What a pass costs before it touches the device and per minute after, fitted to a real overview
#: pass: $0.86 before the first screen, $3.96 in all across two worker runs.
AGENT_START = 2.00
EXPLORE_PER_MINUTE = 0.65
#: Per screen drafted for: 10 gaps cost $5.71, 8 cost $4.60 on real projects.
DRAFTING = 0.60
#: A check run: the agent getting going, then each scenario. One scenario cost $1.26 on a real project.
CHECK_START = 1.00
SCENARIO = 0.30
SCENARIO_SECONDS = 120
#: Each live pass's time budget in minutes (`onboarding_map/passes.py`).
MINUTES = {"overview": 3, "deeper": 10}
DEPTHS = ("overview", "deeper")


def depth_of(value: object) -> str:
    return value if value in DEPTHS else "overview"  # type: ignore[return-value]


def crawl(depth: str = "overview") -> float:
    return round(AGENT_START + EXPLORE_PER_MINUTE * MINUTES[depth_of(depth)], 2)


def drafting(gaps: int = 1) -> float:
    return round(DRAFTING * gaps, 2)


def check(scenarios: int = 1) -> float:
    """What one check run of this many scenarios is likely to cost."""
    return round(CHECK_START + SCENARIO * scenarios, 2)


def scenario() -> tuple[int, float]:
    """(seconds, usd) one run of a scenario takes."""
    return SCENARIO_SECONDS, SCENARIO
