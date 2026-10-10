"""A small HTTP client for a Verdikt site (stdlib only — no new runtime dependency).

Verdikt (github: Husseinovich/verdikt) is a local, single-user QA agent: a Next.js site
(`web/`, default http://localhost:3100, the Mac app on :31100) over one SQLite file, and a
worker (`bin/qa-worker`) that claims queued `run_requests` and drives Claude Code + the
verdikt MCP tools against a web URL / iOS simulator app / Android package. Orcha talks ONLY to
the site's EXISTING HTTP routes:

  GET   /api/health                 — liveness + worker heartbeat
  POST  /api/scenarios              — create a draft scenario ({app_id, name, category, target_kind})
  PATCH /api/scenarios/{id}         — set criteria / description / tags / status=validated
  GET   /api/scenarios?app_id=      — list a project's scenarios (reuse on retry)
  POST  /api/requests               — queue a run ({target_kind, locator, mode:"scenarios",
                                      scenario_ids:[…], project_id}) → {request, worker}
  PATCH /api/requests/{id}          — cancel ({status:"cancelled"})
  POST  /api/db                     — the site's read executor (the same one its own browser
                                      client uses); Orcha issues READ-ONLY `select`s on apps,
                                      run_requests, runs, scenario_results and evidence to
                                      resolve the project and read results.
  GET   /api/artifacts/qa-runs/{path} — a run's screenshot / frame / recording (streamed by the
                                      portal's artifact proxy; the browser never gets this URL)
  links: {base}/runs/{run_id} (report — opened via the portal's redirect, see browser_base)

Every call has a timeout and raises VerdiktError with a human-readable message; callers turn
that into an honest `unavailable` / `failed` state (never a silent pass).
"""

from __future__ import annotations

import ipaddress
import json
import os
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

DEFAULT_TIMEOUT_S = 8.0
LOCAL_OWNER_ID = "00000000-0000-4000-8000-000000000001"  # Verdikt's single local owner


class VerdiktError(Exception):
    """A Verdikt call failed. `unreachable` distinguishes "no Verdikt answered" (connection
    refused / DNS / timeout) from "Verdikt answered with an error"."""

    def __init__(self, message: str, *, unreachable: bool = False, status: int | None = None,
                 user_message: str | None = None):
        super().__init__(message)
        self.unreachable = unreachable
        self.status = status
        # set when the message itself is written for the person configuring Verdikt (a URL
        # it refuses) — the routes may return it; every other message stays in the log
        self.user_message = user_message


# ---------------------------------------------------------------- base URL checks
#
# The base URL is user-supplied (the Verdikt settings form, the connection check) and the
# portal makes server-side requests to it, so it is checked before any request is made
# (server-side request forgery):
#   * http(s) only; no credentials, query or fragment; a plain path prefix; a valid port;
#   * never a link-local address (169.254.0.0/16 — the cloud metadata service — fe80::/10),
#     multicast, unspecified (0.0.0.0) or reserved address, nor a cloud metadata host name —
#     checked on the literal host here AND on every address the name resolves to right
#     before each request (`_check_resolved`);
#   * when ORCHA_VERDIKT_ALLOWED_HOSTS is set (comma-separated names / IPs), only those
#     hosts and loopback are allowed at all;
#   * redirects are never followed, so an allowed host can't bounce a request elsewhere.
# The URL is rebuilt from its checked parts.

ALLOWED_HOSTS_ENV = "ORCHA_VERDIKT_ALLOWED_HOSTS"
_SCHEMES = {"http": "http", "https": "https"}
_METADATA_NAMES = {"metadata", "metadata.google.internal", "metadata.goog", "instance-data",
                   "instance-data.ec2.internal", "metadata.azure.internal"}
_HOST_LABEL = re.compile(r"^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?$")
_BASE_PATH = re.compile(r"^(?:/[A-Za-z0-9_~-][A-Za-z0-9._~-]{0,63}){0,8}$")


def _allow_list() -> list[str]:
    raw = os.environ.get(ALLOWED_HOSTS_ENV) or ""
    return [h.strip().lower().strip("[]") for h in raw.split(",") if h.strip()]


def _ip_refused(ip) -> bool:
    """A destination the portal never contacts (loopback is always fine)."""
    if ip.version == 6 and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped  # ::ffff:169.254.169.254 is the IPv4 address it wraps
    if ip.is_loopback:
        return False
    return ip.is_link_local or ip.is_multicast or ip.is_unspecified or ip.is_reserved


def _allowed_host(hostname: str) -> str | None:
    """The canonical (lower-case; an IP re-serialized by `ipaddress`) form of `hostname`
    when the portal may contact it, else None."""
    name = (hostname or "").strip().lower().rstrip(".")
    if not name:
        return None
    try:
        ip = ipaddress.ip_address(name)
    except ValueError:
        ip = None
    allow = _allow_list()
    if ip is not None:
        if ip.version == 6 and ip.ipv4_mapped is not None:
            ip = ip.ipv4_mapped
        if _ip_refused(ip):
            return None
        if allow and not ip.is_loopback and str(ip) not in allow:
            return None
        return str(ip)
    if name in _METADATA_NAMES or not all(_HOST_LABEL.match(x) for x in name.split(".")):
        return None
    if allow and name != "localhost" and name not in allow:
        return None
    return name


def _check_resolved(base: str) -> None:
    """Refuse a host NAME that resolves to a refused address (a DNS name pointing at the
    metadata service). An unresolvable name is left to the request itself (unreachable)."""
    host = urllib.parse.urlsplit(base).hostname or ""
    try:
        ipaddress.ip_address(host)
        return  # a literal was already checked by normalize_base
    except ValueError:
        pass
    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except (OSError, UnicodeError):
        return
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0].split("%", 1)[0])
        except ValueError:
            continue
        if _ip_refused(ip):
            raise VerdiktError(f"Verdikt host {host!r} resolves to {ip}, which Orcha never contacts",
                               user_message=f"Verdikt host {host!r} resolves to an address Orcha never contacts")


def normalize_base(url: str) -> str:
    """The Verdikt base URL, checked and rebuilt from its parts: http(s), an allowed host
    (see above), an optional port and a plain path prefix — no credentials, query or
    fragment. Raises VerdiktError with a user-facing message otherwise."""
    u = (url or "").strip().rstrip("/")
    if not u:
        raise VerdiktError("no Verdikt URL configured", user_message="no Verdikt URL configured")
    shape_msg = f"Verdikt URL must be http(s)://host[:port], got {url!r}"
    shape = VerdiktError(shape_msg, user_message=shape_msg)
    p = urllib.parse.urlsplit(u)
    scheme = _SCHEMES.get(p.scheme.lower())
    if not scheme or not p.netloc or p.username is not None or p.password is not None or p.query or p.fragment:
        raise shape
    try:
        port = p.port
    except ValueError:
        raise shape from None
    if not _BASE_PATH.match(p.path) or any(seg in (".", "..") for seg in p.path.split("/")):
        raise shape
    host = _allowed_host(p.hostname or "")
    if host is None:
        msg = (f"Verdikt host {p.hostname!r} is not allowed (link-local / metadata addresses are never "
               f"contacted; when {ALLOWED_HOSTS_ENV} is set, only the hosts it lists are)")
        raise VerdiktError(msg, user_message=msg)
    netloc = f"[{host}]" if ":" in host else host
    if port is not None:
        netloc += f":{int(port)}"
    return f"{scheme}://{netloc}{p.path}"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never follow a redirect: a 3xx surfaces as an HTTPError (→ VerdiktError)."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        return None


_NO_REDIRECT_OPENER = urllib.request.build_opener(_NoRedirect)


class VerdiktClient:
    def __init__(self, base_url: str, *, timeout: float = DEFAULT_TIMEOUT_S, opener=None):
        self.base = normalize_base(base_url)
        self.timeout = timeout
        self._open = opener or _NO_REDIRECT_OPENER.open

    # ---------------------------------------------------------------- transport
    def _call(self, method: str, path: str, body: Any = None) -> Any:
        _check_resolved(self.base)
        url = self.base + path
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(url, data=data, method=method,
                                     headers={"Content-Type": "application/json", "Accept": "application/json"})
        try:
            with self._open(req, timeout=self.timeout) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                payload = json.loads(e.read() or b"{}")
                err = payload.get("error")
                detail = err.get("message") if isinstance(err, dict) else (err or "")
            except Exception:  # noqa: BLE001
                pass
            raise VerdiktError(f"Verdikt {method} {path} → HTTP {e.code}" + (f": {detail}" if detail else ""),
                               status=e.code) from e
        except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, OSError) as e:
            reason = getattr(e, "reason", e)
            raise VerdiktError(f"Verdikt is not reachable at {self.base} ({reason})", unreachable=True) from e
        try:
            return json.loads(raw or b"null")
        except ValueError as e:
            raise VerdiktError(f"Verdikt {method} {path} returned non-JSON") from e

    def select(self, table: str, filters: list[dict], *, select: str = "*", order: list[dict] | None = None,
               limit: int | None = None) -> list[dict]:
        """A READ-ONLY query through the site's /api/db executor."""
        ast = {"table": table, "op": "select", "select": select, "filters": filters,
               "order": order or [], "limit": limit}
        res = self._call("POST", "/api/db", ast)
        if isinstance(res, dict) and res.get("error"):
            err = res["error"]
            raise VerdiktError(f"Verdikt query on {table} failed: {err.get('message') if isinstance(err, dict) else err}")
        data = res.get("data") if isinstance(res, dict) else None
        if data is None:
            return []
        return data if isinstance(data, list) else [data]

    # ---------------------------------------------------------------- API
    def health(self) -> dict:
        h = self._call("GET", "/api/health")
        if not isinstance(h, dict) or not h.get("ok"):
            raise VerdiktError("Verdikt health check did not report ok")
        return h

    def projects(self) -> list[dict]:
        return self.select("apps", [], select="id,slug,name,archived_at",
                           order=[{"column": "created_at", "ascending": True}], limit=200)

    def project_by_slug(self, slug: str) -> dict | None:
        rows = self.select("apps", [{"column": "slug", "op": "eq", "value": slug}],
                           select="id,slug,name,archived_at", limit=1)
        return rows[0] if rows else None

    def scenarios(self, app_id: str) -> list[dict]:
        res = self._call("GET", "/api/scenarios?app_id=" + urllib.parse.quote(app_id))
        return (res or {}).get("scenarios") or []

    def create_scenario(self, app_id: str, name: str, *, category: str, target_kind: str) -> dict:
        res = self._call("POST", "/api/scenarios",
                         {"app_id": app_id, "name": name, "category": category, "target_kind": target_kind})
        sc = (res or {}).get("scenario")
        if not sc or not sc.get("id"):
            raise VerdiktError("Verdikt did not return the created scenario")
        return sc

    def update_scenario(self, scenario_id: str, fields: dict) -> dict:
        res = self._call("PATCH", "/api/scenarios/" + urllib.parse.quote(scenario_id), fields)
        return (res or {}).get("scenario") or {}

    def queue_request(self, body: dict) -> dict:
        res = self._call("POST", "/api/requests", body)
        req = (res or {}).get("request")
        if not req or not req.get("id"):
            raise VerdiktError("Verdikt did not return the queued request")
        return {"request": req, "worker": (res or {}).get("worker")}

    def cancel_request(self, request_id: str) -> dict:
        return self._call("PATCH", "/api/requests/" + urllib.parse.quote(request_id), {"status": "cancelled"})

    def request(self, request_id: str) -> dict | None:
        rows = self.select("run_requests", [{"column": "id", "op": "eq", "value": request_id}],
                           select="id,status,run_id,error,waiting_reason,started_at,finished_at,claimed_by,created_at",
                           limit=1)
        return rows[0] if rows else None

    def child_requests(self, request_id: str) -> list[dict]:
        return self.select("run_requests", [{"column": "parent_request_id", "op": "eq", "value": request_id}],
                           select="id,status,run_id,error")

    def runs_for_requests(self, request_ids: list[str]) -> list[dict]:
        if not request_ids:
            return []
        return self.select("runs", [{"column": "request_id", "op": "in", "value": request_ids}],
                           select="id,status,started_at,ended_at,video_path,counts,request_id",
                           order=[{"column": "created_at", "ascending": True}])

    def runs(self, run_ids: list[str]) -> list[dict]:
        if not run_ids:
            return []
        return self.select("runs", [{"column": "id", "op": "in", "value": run_ids}],
                           select="id,status,started_at,ended_at,video_path,counts,request_id")

    def scenario_results(self, run_ids: list[str], scenario_id: str) -> list[dict]:
        if not run_ids:
            return []
        return self.select("scenario_results", [
            {"column": "run_id", "op": "in", "value": run_ids},
            {"column": "scenario_id", "op": "eq", "value": scenario_id},
        ])

    def evidence(self, run_id: str) -> list[dict]:
        return self.select("evidence", [{"column": "run_id", "op": "eq", "value": run_id}],
                           select="run_id,seq,severity,label,note,png_path,step_seq",
                           order=[{"column": "seq", "ascending": True}], limit=50)

    def frames(self, run_id: str, limit: int = 4) -> list[dict]:
        """The last few step frames (screenshots) of a run, used when it recorded no evidence."""
        return self.select("steps", [{"column": "run_id", "op": "eq", "value": run_id}],
                           select="run_id,seq,frame_path",
                           order=[{"column": "seq", "ascending": False}], limit=limit)

    # ---------------------------------------------------------------- links
    # These are SERVER-side URLs (the base Orcha reaches Verdikt at — e.g.
    # http://host.docker.internal:31970 from inside the portal container). They are stored on
    # the verdikt_runs row but never handed to the browser: screenshots / the recording are
    # streamed through the portal (`open_artifact`), and the report link goes through a portal
    # redirect that rewrites a Docker-only host (`browser_base`).
    def report_url(self, run_id: str) -> str:
        return f"{self.base}/runs/{urllib.parse.quote(run_id)}"

    def artifact_url(self, path: str) -> str:
        return f"{self.base}/api/artifacts/qa-runs/" + "/".join(urllib.parse.quote(p) for p in path.split("/"))

    def open_artifact(self, path: str, *, range_header: str | None = None, timeout: float | None = None):
        """GET one run artifact from Verdikt's `/api/artifacts/qa-runs/<path>`; returns the open
        response (the caller streams and closes it). `path` must already have passed
        `safe_artifact_path`. Raises VerdiktError (`status` set for an HTTP error)."""
        headers = {"Accept": "*/*"}
        if range_header:
            headers["Range"] = range_header
        _check_resolved(self.base)
        req = urllib.request.Request(self.artifact_url(path), method="GET", headers=headers)
        try:
            return self._open(req, timeout=timeout or self.timeout)
        except urllib.error.HTTPError as e:
            e.close()
            raise VerdiktError(f"Verdikt artifact → HTTP {e.code}", status=e.code) from e
        except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, OSError) as e:
            reason = getattr(e, "reason", e)
            raise VerdiktError(f"Verdikt is not reachable at {self.base} ({reason})", unreachable=True) from e


# ---------------------------------------------------------------- artifact allow-list

# the only artifact types Orcha surfaces (evidence PNGs, step frames, the run recording) —
# the content type is OURS, never Verdikt's, so a proxied response can't become HTML/JS
ARTIFACT_TYPES = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp",
                  "webm": "video/webm", "mp4": "video/mp4"}
_SAFE_SEGMENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")


def safe_artifact_path(path: str | None, run_id: str | None) -> str | None:
    """`path` when it is a plain relative path INSIDE Verdikt run `run_id`'s artifact folder
    (`<run_id>/evidence/001.png`, `<run_id>/frames/0003.jpg`, `<run_id>/run.webm`) with an
    image/video extension; else None. No `..`/`.` segments, no leading `/`, no backslashes,
    no percent-escapes, no query/fragment — every segment is `[A-Za-z0-9][A-Za-z0-9_.-]*`."""
    if not path or not run_id or not isinstance(path, str) or len(path) > 400:
        return None
    if not _SAFE_SEGMENT.match(run_id):
        return None
    segs = path.split("/")
    if len(segs) < 2 or segs[0] != run_id:
        return None
    if any(not _SAFE_SEGMENT.match(s) or ".." in s for s in segs):
        return None
    leaf = segs[-1]
    ext = leaf.rsplit(".", 1)[-1].lower() if "." in leaf else ""
    return path if ext in ARTIFACT_TYPES else None


def artifact_content_type(path: str) -> str:
    return ARTIFACT_TYPES.get(path.rsplit(".", 1)[-1].lower(), "application/octet-stream")


def artifact_path_from_url(base_url: str | None, url: str | None) -> str | None:
    """The artifact path inside a stored server-side artifact URL
    (`{base}/api/artifacts/qa-runs/<path>` → `<path>`), or None when `url` is not one."""
    if not url or not base_url:
        return None
    try:
        prefix = normalize_base(base_url) + "/api/artifacts/qa-runs/"
    except VerdiktError:
        return None
    if not url.startswith(prefix):
        return None
    rest = url[len(prefix):]
    if "?" in rest or "#" in rest:
        return None
    return "/".join(urllib.parse.unquote(p) for p in rest.split("/"))


# ---------------------------------------------------------------- browser-facing base

# hostnames that only resolve INSIDE a container (Docker Desktop / Podman / the default
# bridge gateway). A browser on the host reaches the same service at the host the portal
# itself was opened on.
DOCKER_HOST_ALIASES = {"host.docker.internal", "gateway.docker.internal", "docker.for.mac.localhost",
                       "docker.for.mac.host.internal", "docker.for.win.localhost", "host.containers.internal",
                       "172.17.0.1"}
_HOSTNAME = re.compile(r"^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*|\[[0-9A-Fa-f:.]+\])$")


def browser_base(base_url: str, browser_host: str | None) -> str:
    """The Verdikt base a BROWSER can open. Unchanged unless the configured host is a
    container-only alias (host.docker.internal …); then that host is replaced by the host the
    browser used to reach the portal (`browser_host`, e.g. "127.0.0.1" / "mymac.local"),
    keeping Verdikt's scheme and port. Falls back to "localhost" for an unusable host."""
    base = normalize_base(base_url)
    p = urllib.parse.urlsplit(base)
    if (p.hostname or "").lower() not in DOCKER_HOST_ALIASES:
        return base
    host = (browser_host or "").strip()
    if not host or not _HOSTNAME.match(host):
        host = "localhost"
    netloc = host + (f":{p.port}" if p.port else "")
    return urllib.parse.urlunsplit((p.scheme, netloc, p.path, "", ""))
