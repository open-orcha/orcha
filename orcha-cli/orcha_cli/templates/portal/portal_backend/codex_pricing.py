"""Estimate the dollar cost of a Codex agent run from its token usage.

Claude Code reports `total_cost_usd` itself on its terminal stream-json `result` event; the Codex
CLI reports only token counts (`turn.completed` usage). So a Codex run's cost is ESTIMATED here
from the agent's model and a small per-model price table.

THE TABLE IS AN ESTIMATE. It is OpenAI's public API list price per 1M tokens (input, cached
input, output) as best known when written; it is not read from a bill and goes stale when prices
change. Verify against https://openai.com/api/pricing and edit here. A model that is not listed
gets NO cost (None) — tokens are still recorded — never a guessed $0.

Token convention (matches the Claude fields): `input_tokens` is the UNCACHED input,
`cache_read_input_tokens` the cached input, `output_tokens` the output (reasoning included, as
OpenAI bills it). The daemon's log parser does that split (notifier_process._usage_from_log).
"""

from __future__ import annotations

from typing import Optional

# model id -> (input, cached input, output) USD per 1M tokens. ESTIMATES — see module docstring.
CODEX_PRICES_PER_MTOK: dict[str, tuple[float, float, float]] = {
    "gpt-5.5": (5.00, 0.50, 30.00),
    "gpt-5.4": (2.50, 0.25, 15.00),
    "gpt-5.4-mini": (0.75, 0.075, 4.50),
    "gpt-5.3-codex": (1.75, 0.175, 14.00),
    "gpt-5.2": (1.75, 0.175, 14.00),
    "gpt-5.2-codex": (1.75, 0.175, 14.00),
    "gpt-5.1": (1.25, 0.125, 10.00),
    "gpt-5.1-codex": (1.25, 0.125, 10.00),
    "gpt-5": (1.25, 0.125, 10.00),
    "gpt-5-codex": (1.25, 0.125, 10.00),
    "gpt-5-mini": (0.25, 0.025, 2.00),
}


def _count(value) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
        return 0
    return int(value)


def estimate_codex_cost_usd(
    model: Optional[str],
    *,
    input_tokens=None,
    cache_read_input_tokens=None,
    output_tokens=None,
) -> Optional[float]:
    """Estimated USD for one Codex run, or None when the model is unpriced or no tokens arrived."""
    if not model:
        return None
    price = CODEX_PRICES_PER_MTOK.get(str(model).strip().lower())
    if price is None:
        return None
    if input_tokens is None and cache_read_input_tokens is None and output_tokens is None:
        return None
    fresh, cached, out = price
    cost = (
        _count(input_tokens) * fresh
        + _count(cache_read_input_tokens) * cached
        + _count(output_tokens) * out
    ) / 1_000_000
    return round(cost, 6)
