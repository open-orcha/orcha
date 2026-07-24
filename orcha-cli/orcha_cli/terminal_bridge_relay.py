"""Relay terminal frames and normalize websocket transport compatibility."""

from urllib.parse import parse_qs, urlparse


async def relay(bridge, ws, master_fd, rec, run_id, api_base, aid):
    """Relay PTY output and websocket input until either endpoint closes."""
    import asyncio

    loop = asyncio.get_event_loop()
    stop = asyncio.Event()
    pty_died = {"value": False}

    async def pty_to_ws():
        while not stop.is_set():
            readable = await loop.run_in_executor(
                None, bridge._wait_readable, master_fd
            )
            if stop.is_set():
                break
            if not readable:
                continue
            data = bridge._read_fd(master_fd)
            if not data:
                pty_died["value"] = True
                stop.set()
                break
            text = data.decode("utf-8", "replace")
            await safe_send(ws, bridge.make_frame("stdout", data=text))
            if run_id:
                rec["chunks"].append(text)
                rec["len"] += len(text)
                while (
                    rec["len"] > 2 * bridge.LIVE_RUN_OUTPUT_CAP
                    and len(rec["chunks"]) > 1
                ):
                    rec["len"] -= len(rec["chunks"].pop(0))

    async def renew():
        while not stop.is_set():
            await asyncio.sleep(bridge.LIVE_RENEW_SECS)
            if not stop.is_set():
                bridge.renew_live_lease(api_base, aid)

    reader = asyncio.ensure_future(pty_to_ws())
    renewer = asyncio.ensure_future(renew())
    try:
        async for raw in ws:
            bridge.apply_client_frame(bridge.parse_frame(raw), master_fd)
    except Exception:  # noqa: BLE001, S110 - transport errors end the relay
        pass
    finally:
        stop.set()
        renewer.cancel()
        try:
            timeout = bridge.PTY_SELECT_TIMEOUT * 5 + 1.0
            await asyncio.wait_for(asyncio.shield(reader), timeout=timeout)
        except Exception:  # noqa: BLE001 - cancellation is a cleanup backstop
            reader.cancel()
    return not pty_died["value"]


async def safe_send(ws, message):
    """Send a frame without letting a closed socket block cleanup."""
    try:
        await ws.send(message)
    except Exception:  # noqa: BLE001, S110 - socket may already be closed
        pass


async def safe_close(ws):
    """Close a websocket without letting transport errors block cleanup."""
    try:
        await ws.close()
    except Exception:  # noqa: BLE001, S110 - socket may already be closed
        pass


def parse_query(path):
    """Return the first value for each terminal URL query parameter."""
    query = parse_qs(urlparse(path).query)
    return {key: values[0] for key, values in query.items() if values}


def websocket_path(ws):
    """Read the request target across supported ``websockets`` versions."""
    path = getattr(ws, "path", None)
    if path:
        return path
    request = getattr(ws, "request", None)
    return (getattr(request, "path", "") or "") if request is not None else ""
