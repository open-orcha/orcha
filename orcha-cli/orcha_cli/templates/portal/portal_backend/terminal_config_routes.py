"""Expose the host-side embedded terminal bridge location."""

import os

from portal_backend.application import app

TERMINAL_WS_URL = os.environ.get("ORCHA_TERMINAL_WS_URL", "ws://127.0.0.1:8765")


@app.get("/api/terminal/config")
def terminal_config():
    """S3 §3b: where the embedded-terminal frontend (terminal.js) opens its websocket. The PTY
    bridge is a SEPARATE host-side server (not a portal route), so the browser connects directly
    to `ws_url` + `/api/agents/<aid>/terminal?actor_agent_id=<human>`. Localhost/trusted-local.
    """
    return {"ws_url": TERMINAL_WS_URL}
