"""Orcha QA: map, explore and draft scenarios for native iOS and Android apps (docs/orcha-qa-plan.md).

Nothing here imports the `[qa]` extra (mcp, fb-idb, uiautomator2, pillow) at import time: the
device layer and the MCP server load it lazily, so `import orcha_cli` and `orcha --help` work
without it.
"""
