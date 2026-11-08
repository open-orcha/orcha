"""One Chromium session over Playwright (async API): the web lane of the QA device layer.

Adapted from `sessions/web.py` and `web_extractor.js` (next to this file), with the pieces
of the original server it needs: agent navigation limited to the allowed origins
(`recording/origins.py`, a `blocked:` result), and rate-limit / bot-wall detection with a
back-off-once-then-stop guard (`environment/site_limits.py`, slimmed: no shared pauses, no
pace setting, no stop file). The DOM is flattened by the extractor into the idb node shape, so
the tree, its `e12` refs, targets and the settle are shared with iOS and Android. Coordinates
are CSS pixels (the browser runs at device scale 1, so the screenshot is the same size).

Every screen the agent sees ends with an `events since last screen (N):` block: console
errors, uncaught page errors, failed requests, 5xx responses (and a 404 document), crashes,
failed navigations.

Not ported: API stubs and the request journal, JS/backend coverage, video,
traffic.jsonl, metrics, logs, the production read-only guard, cloud browsers, saved sessions
(cookies), appearance, file upload, network shaping, Electron/desktop, the original config.

Playwright and PIL are imported inside the functions: this module imports without the extra.
"""

from __future__ import annotations

import asyncio
import base64
import io
import re
import sys
import time
from dataclasses import asdict, dataclass
from email.utils import parsedate_to_datetime
from datetime import datetime, timezone
from collections.abc import Awaitable, Callable, Iterable, Mapping
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from orcha_cli.qa.device.base import SessionBase, SessionError
from orcha_cli.qa.device.screen import (
    EMPTY_TREE_RETRY_S,
    Probe,
    Screen,
    SignalResult,
    needs_pixels,
    now,
    poll_sleep,
    settle,
    shape_of,
)
from orcha_cli.qa.device.targets import Target, off_screen, resolve
from orcha_cli.qa.device.tree import parse_tree, screen_size, tree_hash

EXTRACTOR_JS = (Path(__file__).with_name("web_extractor.js")).read_text()
#: The same extractor over the whole page (beyond the viewport), for `full_page_tree`.
FULL_PAGE_JS = (
    "(() => { globalThis.__orchaFullPage = true; try { const nodes =\n"
    + EXTRACTOR_JS.strip().rstrip(";")
    + "\n; return nodes; } finally { globalThis.__orchaFullPage = false; } })()"
)

VIEWPORTS = {"desktop": (1280, 800), "mobile": (390, 844)}
#: Live frames (`start_live`): JPEG quality of the screencast.
LIVE_JPEG_QUALITY = 60
PRESS_KEYS = {"enter": "Enter", "escape": "Escape", "tab": "Tab", "backspace": "Backspace"}
NAV_TIMEOUT_MS = 30_000
#: After an action: how long the session waits for a navigation it may have started to load.
LOAD_WAIT_MS = 5_000
EXTRACT_TIMEOUT_S = 10.0
DEFAULT_COLOR_SCHEME = "light"
#: What a page may ask for, granted to the session's origins up front (no prompt to answer).
WEB_PERMISSIONS = ("geolocation", "notifications", "camera", "microphone", "clipboard-read", "clipboard-write")
#: A fake camera and microphone, so a page that asks for them gets a stream without a prompt.
FAKE_MEDIA_ARGS = ("--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream")

#: Installed in every page from its first script on: how many DOM mutations the page has made
#: and how long since the last one, which the settle's change signal reads (`MutationSignal`)
#: instead of extracting the page again.
MUTATION_WATCH_JS = r"""
(() => {
  if (window.__orchaMut) return;
  const s = { n: 0, last: performance.now() };
  const watch = () => {
    try {
      new MutationObserver((list) => { s.n += list.length; s.last = performance.now(); })
        .observe(document.documentElement || document, { subtree: true, childList: true, attributes: true, characterData: true });
    } catch (e) {}
  };
  if (document.documentElement) watch(); else document.addEventListener("DOMContentLoaded", watch, { once: true });
  window.__orchaMut = {
    read: () => ({ n: s.n, idle: Math.round(performance.now() - s.last), origin: performance.timeOrigin, ready: document.readyState }),
  };
})();
"""
MUTATION_READ_JS = "(_) => {" + MUTATION_WATCH_JS + "; return window.__orchaMut.read(); }"
MUTATION_POLL_S = 0.05

#: The value of the editable element at a point (or the active element).
VALUE_AT_JS = """
([x, y]) => {
  let el = (x == null) ? document.activeElement : document.elementFromPoint(x, y);
  if (!el) return null;
  if (!(el.matches('input,textarea,select,[contenteditable]'))) {
    const inner = el.querySelector('input,textarea,[contenteditable]');
    if (inner) el = inner;
    else if (document.activeElement && document.activeElement.matches('input,textarea,[contenteditable]')) el = document.activeElement;
    else return null;
  }
  if (el.isContentEditable) return el.textContent;
  if ('value' in el) return String(el.value);
  return null;
}
"""


# =============================================================================================
# Origins: where the agent may navigate (`recording/origins.py`)
# =============================================================================================

#: Console message types as the run page's log levels.
CONSOLE_LEVELS = {"error": "error", "assert": "error", "warning": "warn", "debug": "debug", "trace": "debug"}
#: The calls the run page's API tab lists; images, fonts and scripts stay out of it.
REQUEST_KINDS = {"fetch": "fetch", "xhr": "xhr", "document": "document"}
#: Rows kept between two looks: a page that logs in a tight loop must not fill the memory.
TELEMETRY_BUFFER = 2000
#: A field by this name carries a credential: its value never leaves the machine.
SECRET_FIELD = re.compile(r"pass|pwd|secret|token|auth|otp|pin\b|cvv|card|ssn|session|cookie|api[_-]?key", re.I)
_FIELD_VALUE = re.compile(r"""("?)([\w.-]+)\1(\s*[:=]\s*)("(?:[^"\\]|\\.)*"|[^&,\s{}\[\]]+)""")


def scrub_body(body: str) -> str:
    """A request body as the run page may store it: JSON or form text with credential values
    replaced, cut to 8 kB."""
    def hide(m: re.Match[str]) -> str:
        return f"{m.group(1)}{m.group(2)}{m.group(1)}{m.group(3)}\"***\"" if SECRET_FIELD.search(m.group(2)) else m.group(0)
    return _FIELD_VALUE.sub(hide, str(body))[:8000]


def scrub_url(url: str) -> str:
    """A URL with the credential values of its query replaced."""
    base, mark, query = str(url).partition("?")
    return f"{base}{mark}{scrub_body(query)}"[:4000]


BLANK_PAGE = "about:blank"
WEB_SCHEMES = frozenset({"http", "https"})


def origin_of(url: str) -> str:
    """`scheme://host[:port]`, lowercased (`http://localhost:3000`, `file://`)."""
    p = urlsplit((url or "").strip())
    return f"{p.scheme.lower()}://{p.netloc.lower()}"


def hostname_label(url: str) -> str:
    """The hostname (with port) without a leading `www.`; the scheme when there is no host."""
    p = urlsplit(url)
    host = p.hostname or ""
    if host.startswith("www."):
        host = host[4:]
    if host and p.port:
        host = f"{host}:{p.port}"
    return host or p.scheme or "web"


def _bare_host(netloc: str) -> str:
    host = netloc.lower().rsplit("@", 1)[-1]
    return host[4:] if host.startswith("www.") else host


def same_site_redirect(start_url: str, landed_url: str) -> str | None:
    """The landing origin when opening the start URL redirected to the site's own canonical
    address (`example.com` <-> `www.example.com`, `http` -> `https`); None for anything else."""
    a, b = urlsplit((start_url or "").strip()), urlsplit((landed_url or "").strip())
    if a.scheme.lower() not in WEB_SCHEMES or b.scheme.lower() not in WEB_SCHEMES:
        return None
    landed = origin_of(landed_url)
    if landed == origin_of(start_url) or not a.hostname or not b.hostname:
        return None
    if a.scheme.lower() == "https" and b.scheme.lower() == "http":
        return None  # a downgrade is never the site's own address
    default = {"http": 80, "https": 443}
    try:
        pa, pb = a.port or default[a.scheme.lower()], b.port or default[b.scheme.lower()]
    except ValueError:
        return None
    if a.scheme.lower() == b.scheme.lower() and pa != pb:
        return None
    if a.scheme.lower() != b.scheme.lower() and (a.port or b.port):
        return None
    return landed if _bare_host(a.hostname) == _bare_host(b.hostname) else None


def navigation_decision(url: str, *, session_origin: str | None, extra: Iterable[str] = ()) -> str | None:
    """None when the agent may open `url`; otherwise the `blocked: ...` text. Allowed: `http(s)`
    on the session origin or an allowed one, exactly `about:blank`, and `file://` only when the
    session started on a `file://` page. An allowlist, never a denylist: a browser nests schemes
    (`view-source:file:`, `blob:`) and a list of forbidden ones misses the wrapper. Where the app
    itself navigates is not restricted (it shows as `locked_app_violation: true`)."""
    url = (url or "").strip()
    if url == BLANK_PAGE:
        return None
    scheme = urlsplit(url).scheme.lower()
    allowed = {o for o in [session_origin, *extra] if o}
    if scheme in WEB_SCHEMES or (scheme == "file" and session_origin == "file://"):
        if origin_of(url) in allowed:
            return None
        listed = ", ".join(sorted(allowed | {BLANK_PAGE}))
        return (
            f"blocked: {url} is outside the allowed origins ({listed}). The app may navigate there on its "
            "own (you will see locked_app_violation: true), but you may not; if the work needs this origin, "
            "a person has to add it to the target's allowed origins. This is a policy refusal, not a "
            "failure: do not retry it."
        )
    return (
        f"blocked: scheme {scheme or 'none'!r} is not allowed for agent navigation "
        "(http(s) on an allowed origin, or about:blank)"
    )


# =============================================================================================
# Rate limits and bot walls (`environment/site_limits.py`, slimmed)
# =============================================================================================

RATE_LIMITED = "rate_limited"
BOT_BLOCKED = "bot_blocked"
STOPPED_TEXT = {
    RATE_LIMITED: "Stopped: the site rate-limited us",
    BOT_BLOCKED: "Stopped: the site blocked us (bot protection)",
}
BLOCKED_REASON = {
    RATE_LIMITED: "needs setup: the site rate-limited us",
    BOT_BLOCKED: "needs setup: the site blocked us (bot protection)",
}
DEFAULT_WAIT_S = 60.0
BOT_WAIT_S = 15.0
MAX_WAIT_S = 90.0
MIN_WAIT_S = 5.0
#: The least gap between actions once the session has backed off.
SLOWED_GAP_S = 5.0
#: A page with more visible text than this is the app, not an interstitial.
INTERSTITIAL_MAX_CHARS = 1500
_SECOND_LEVEL = frozenset({"co", "com", "org", "net", "ac", "gov", "edu", "or", "ne", "go"})


@dataclass(frozen=True)
class SiteSignal:
    """One sign that the site is limiting or walling us."""

    kind: str  # RATE_LIMITED | BOT_BLOCKED
    source: str  # status | header | page
    detail: str
    site: str | None = None
    retry_after_s: float | None = None

    def as_dict(self) -> dict[str, Any]:
        return {k: v for k, v in asdict(self).items() if v is not None}


def host_of(url: str | None) -> str:
    raw = (url or "").strip()
    if not raw:
        return ""
    if "://" not in raw:
        raw = f"http://{raw}"
    try:
        return (urlsplit(raw).hostname or "").lower()
    except ValueError:
        return ""


def registrable_domain(host: str) -> str:
    """`example.com` for `api.staging.example.com`, `example.co.uk` for `www.example.co.uk`."""
    import ipaddress

    host = (host or "").lower().strip(".")
    try:
        ipaddress.ip_address(host.strip("[]"))
        return host
    except ValueError:
        pass
    labels = host.split(".")
    if len(labels) <= 2:
        return host
    if len(labels[-1]) == 2 and labels[-2] in _SECOND_LEVEL:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


def site_of(url: str | None) -> str:
    host = host_of(url)
    return registrable_domain(host) if host else ""


def retry_after_seconds(value: Any, at: datetime | None = None) -> float | None:
    """`Retry-After` in seconds (delta-seconds or an HTTP date); None when absent or unreadable."""
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if re.fullmatch(r"\d+(?:\.\d+)?", text):
        return max(0.0, float(text))
    try:
        when = parsedate_to_datetime(text)
    except (TypeError, ValueError, IndexError):
        return None
    if when is None:
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return max(0.0, (when - (at or datetime.now(timezone.utc))).total_seconds())


def _vendor_mark(h: dict[str, str], status: int, document: bool) -> str | None:
    if h.get("cf-mitigated", "").lower() == "challenge":
        return "Cloudflare"
    if "x-amzn-waf-action" in h:
        return "AWS WAF"
    if "x-datadome" in h or "x-datadome-cid" in h:
        return "DataDome"
    server = h.get("server", "").lower()
    if "akamaighost" in server and status == 403:
        return "Akamai"
    if server == "cloudflare" and document and status in (403, 503):
        return "Cloudflare"
    return None


def _path_of(url: str) -> str:
    m = re.match(r"^[a-z][a-z0-9+.-]*://[^/]+(/[^?#]*)?", url or "", re.I)
    path = (m.group(1) if m else "") or "/"
    return path if len(path) <= 60 else path[:59] + "…"


def classify_response(url: str, status: int | None, headers: Mapping[str, Any] | None = None, *,
                      app_sites: Iterable[str] = (), document: bool = False) -> SiteSignal | None:
    """A signal for one response of the app's own site (`app_sites`, registrable domains): 429 is
    a rate limit, any error status with `Retry-After` one too, a 403/503 with a bot-protection
    vendor's mark a bot wall. A plain 403/503 is left to the page (`classify_page`)."""
    if not isinstance(status, int) or status < 400:
        return None
    host = host_of(url)
    site = registrable_domain(host) if host else ""
    sites = {s for s in app_sites if s}
    if sites and site not in sites:
        return None
    h = {str(k).lower(): str(v) for k, v in (headers or {}).items()}
    retry = retry_after_seconds(h.get("retry-after"))
    where = f"{host}{_path_of(url)}" if host else _path_of(url)
    wait_note = f", Retry-After {int(round(retry))} s" if retry is not None else ""
    if status == 429:
        return SiteSignal(RATE_LIMITED, "status", f"HTTP 429 Too Many Requests from {where}{wait_note}", site or None, retry)
    vendor = _vendor_mark(h, status, document) if status in (403, 503) else None
    if vendor:
        return SiteSignal(BOT_BLOCKED, "status", f"HTTP {status} {vendor} challenge on {where}", site or None, retry)
    if retry is not None:
        return SiteSignal(RATE_LIMITED, "header", f"HTTP {status} with Retry-After {int(round(retry))} s from {where}", site or None, retry)
    return None


_TITLE_RULES: tuple[tuple[str, re.Pattern[str], str], ...] = (
    (BOT_BLOCKED, re.compile(r"^\s*just a moment\b", re.I), 'Cloudflare "Just a moment" check'),
    (BOT_BLOCKED, re.compile(r"attention required!?\s*\|\s*cloudflare", re.I), 'Cloudflare "Attention Required!" page'),
    (BOT_BLOCKED, re.compile(r"^\s*(?:ddos-guard|pardon our interruption)\b", re.I), "a bot-protection page"),
    (RATE_LIMITED, re.compile(r"\btoo many requests\b|\brate[- ]limit(?:ed)?\b", re.I), "a rate-limit page"),
)
_BODY_RULES: tuple[tuple[str, re.Pattern[str]], ...] = (
    (RATE_LIMITED, re.compile(r"\b(?:you(?:'|’)ve|you have|you've|you are|you're|you were) been rate[- ]limited\b|\byou(?:'|’)re being rate[- ]limited\b", re.I)),
    (RATE_LIMITED, re.compile(r"\brate[- ]limit(?:ed| exceeded| reached)\b", re.I)),
    (RATE_LIMITED, re.compile(r"\btoo many requests\b", re.I)),
    (BOT_BLOCKED, re.compile(r"\bchecking (?:if the site connection is secure|your browser)\b", re.I)),
    (BOT_BLOCKED, re.compile(r"\bverify(?:ing)? (?:that )?you are (?:a )?human\b|\bare you a (?:human|robot)\b|\bi(?:'|’)?m not a robot\b", re.I)),
    (BOT_BLOCKED, re.compile(r"\b(?:h|re)captcha\b|\bcomplete the security check\b", re.I)),
    (BOT_BLOCKED, re.compile(r"\bsorry, you have been blocked\b|\byou (?:have been|are|were) blocked\b", re.I)),
    (BOT_BLOCKED, re.compile(r"\bpardon our interruption\b|\bpress (?:&|and) hold\b", re.I)),
    (BOT_BLOCKED, re.compile(r"\benable javascript and cookies to continue\b", re.I)),
    (BOT_BLOCKED, re.compile(r"\baccess denied\b.{0,200}\b(?:you don(?:'|’)?t have permission to access|reference\s*#)", re.I | re.S)),
)
_ACCESS_DENIED = re.compile(r"\baccess denied\b|\brequest blocked\b|\bforbidden\b", re.I)


def _sentence_around(text: str, start: int, end: int) -> str:
    left = max(text.rfind(".", 0, start), text.rfind("!", 0, start), text.rfind("\n", 0, start)) + 1
    stops = [i for i in (text.find(".", end), text.find("!", end), text.find("\n", end)) if i >= 0]
    right = min(stops) + 1 if stops else len(text)
    out = " ".join(text[left:right].split()).strip()
    return out if len(out) <= 120 else out[:119] + "…"


def classify_page(title: str | None, texts: Iterable[Any] = (), *, document_status: int | None = None,
                  site: str | None = None) -> SiteSignal | None:
    """A signal when the page on screen is a rate-limit or bot wall, from its title and visible
    texts. Body phrases count only on a short page (an interstitial), so an app's own "too many
    requests" toast on a full page never ends a session; "Access denied" only with a 403/503."""
    t = " ".join(str(title or "").split())
    parts = [" ".join(str(x).split()) for x in texts if isinstance(x, str) and x.strip()]
    body = "\n".join(dict.fromkeys(parts))
    for kind, pattern, what in _TITLE_RULES:
        if kind == BOT_BLOCKED and pattern.search(t):
            return SiteSignal(kind, "page", f'{what} (title "{t[:80]}")', site)
    if len(body) > INTERSTITIAL_MAX_CHARS:
        return None
    for kind, pattern in _BODY_RULES:
        m = pattern.search(body)
        if m:
            return SiteSignal(kind, "page", f'the page says "{_sentence_around(body, m.start(), m.end())}"', site)
    for kind, pattern, what in _TITLE_RULES:
        if kind == RATE_LIMITED and pattern.search(t):
            return SiteSignal(kind, "page", f'{what} (title "{t[:80]}")', site)
    if document_status in (403, 503):
        m = _ACCESS_DENIED.search(t) or _ACCESS_DENIED.search(body)
        if m:
            seen = t if _ACCESS_DENIED.search(t) else _sentence_around(body, m.start(), m.end())
            return SiteSignal(BOT_BLOCKED, "page", f'HTTP {document_status} page says "{seen[:120]}"', site)
    return None


def screen_signal(shot: Any, *, document_status: int | None = None, site: str | None = None) -> SiteSignal | None:
    if shot is None:
        return None
    texts = [v for e in getattr(shot, "elements", None) or [] for v in (e.label, e.value) if v and v.strip()]
    return classify_page(getattr(shot, "foreground_name", "") or "", texts, document_status=document_status, site=site)


def _what(kind: str) -> str:
    return "rate-limiting us" if kind == RATE_LIMITED else "blocking us with bot protection"


class SiteLimitGuard:
    """One session's back-off-once-then-stop state: `clear` -> `backing_off` (first signal) ->
    `slowed` (the wait cleared it) -> `stopped` (a second signal, or the wall still there). Never
    fights a limit: no retries, no captcha solving; the only request the session makes on its own
    is one reload of a rate-limit page after the wait."""

    def __init__(self) -> None:
        self.state = "clear"
        self.first: SiteSignal | None = None
        self.last: SiteSignal | None = None
        self.waited_s = 0.0
        self.last_action_at: float | None = None

    @property
    def stopped(self) -> bool:
        return self.state == "stopped"

    def wait_for(self, signal: SiteSignal) -> float:
        base = signal.retry_after_s if signal.retry_after_s is not None else (DEFAULT_WAIT_S if signal.kind == RATE_LIMITED else BOT_WAIT_S)
        return float(min(MAX_WAIT_S, max(MIN_WAIT_S, base)))

    def gap_before_action(self) -> float:
        if self.state not in ("slowed", "backing_off") or self.last_action_at is None:
            return 0.0
        return max(0.0, self.last_action_at + SLOWED_GAP_S - time.monotonic())

    def backoff_message(self, signal: SiteSignal, wait: float) -> str:
        return (f"site_limit: the site is {_what(signal.kind)} ({signal.detail}). The session waited {int(wait)} s "
                "before anything else: do not act, do not reload, do not retry.")

    def resumed_message(self, waited: float) -> str:
        kind = self.first.kind if self.first else RATE_LIMITED
        return (f"site_limit: the site was {_what(kind)}; after {int(waited)} s it answers again. From now on actions "
                f"are spaced at least {int(SLOWED_GAP_S)} s apart. Keep going calmly; if it happens again, the session "
                "stops. Never file the limit page as a finding.")

    def stop(self, signal: SiteSignal) -> str:
        self.state, self.last = "stopped", signal
        kind = signal.kind
        return (f"site_limit: STOPPED. {STOPPED_TEXT[kind]} ({signal.detail}). Every further action is refused: more "
                "requests only make it worse. This is not a bug in the app: do not file the limit page as a finding. "
                f"Report what is not finished as blocked with the reason \"{BLOCKED_REASON[kind]}\", then end the session.")

    def refusal(self) -> str | None:
        if not self.stopped:
            return None
        kind = (self.last or self.first).kind if (self.last or self.first) else RATE_LIMITED
        return (f"error: action refused: the session stopped because {STOPPED_TEXT[kind].removeprefix('Stopped: ')}. "
                f"Do not act. Report what is left as blocked (\"{BLOCKED_REASON[kind]}\") and end the session.")

    def record(self) -> dict[str, Any] | None:
        """What a stopped (or backed-off) session reports, for the session's result."""
        if self.first is None:
            return None
        return {"state": self.state, "first": self.first.as_dict(), **({"last": self.last.as_dict()} if self.last else {}),
                "waited_s": round(self.waited_s, 1)}


# =============================================================================================
# The session
# =============================================================================================


def _blank_png(width: int, height: int) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (max(1, width), max(1, height)), (255, 255, 255)).save(buf, format="PNG")
    return buf.getvalue()


def _first_line(e: BaseException) -> str:
    message = getattr(e, "message", None) or str(e)
    return (message.splitlines() or [type(e).__name__])[0]


class WebSession(SessionBase):
    """A Chromium page driven through Playwright. `WebSession(viewport="desktop")` then
    `await s.start(url)`; see `base.SessionBase` for the actions. `device_name` is the viewport,
    `udid` None, `app_id` the start URL. No device lock: each session has its own browser."""

    platform = "web"

    def __init__(
        self,
        *,
        viewport: str = "desktop",
        headless: bool = True,
        allowed_origins: Iterable[str] | None = None,
        on_step: Callable[[Any], Any] | None = None,
        playwright_factory: Callable[[], Any] | None = None,
        **kw: Any,
    ) -> None:
        if viewport not in VIEWPORTS:
            raise ValueError(f"viewport must be one of {', '.join(VIEWPORTS)}, got {viewport!r}")
        kw.pop("device_name", None)
        kw.pop("claim_lock", None)
        super().__init__(device_name=viewport, on_step=on_step, claim_lock=False, **kw)
        self.viewport = viewport
        self.headless = headless
        self.udid = None  # type: ignore[assignment]
        self.allowed_origins = [origin_of(o) for o in (allowed_origins or []) if str(o).strip()]
        self._playwright_factory = playwright_factory
        self.width, self.height = VIEWPORTS[viewport]
        self.origin = ""
        self.site_origins: list[str] = []
        self.playwright: Any = None
        self.browser: Any = None
        self.context: Any = None
        self.page: Any = None
        self._events: list[str] = []
        self._log_rows: list[dict[str, Any]] = []
        self._request_rows: list[dict[str, Any]] = []
        self._request_started: dict[int, float] = {}
        self._response_status: dict[int, int] = {}
        self._crashed = False
        self._recover = False
        self._mutations_ok: bool | None = None
        self._mut_mark: dict[str, Any] | None = None
        self.site_guard = SiteLimitGuard()
        self.site_signals: list[SiteSignal] = []
        self.last_document_status: int | None = None
        #: The live screencast (`start_live`): where its frames go, and its CDP session.
        self._live: Any = None
        self._live_cdp: Any = None

    # ---------- lifecycle ----------


    async def appearance_setting(self) -> str | None:
        """What this session's browser is set to: every context opens on `DEFAULT_COLOR_SCHEME`."""
        return DEFAULT_COLOR_SCHEME

    async def start(self, app_id: str, launch: bool = True) -> Screen:
        """Launch Chromium and open `app_id` (a URL with its scheme). Returns the first screen."""
        url = app_id.strip()
        if "://" not in url:
            raise SessionError(f"url must include a scheme (http:// or https://), got {url!r}")
        self.app_id, self.origin, self.app_name = url, origin_of(url), hostname_label(url)
        self.started_at = time.time()
        try:
            if self._playwright_factory is None:
                from playwright.async_api import async_playwright

                self._playwright_factory = async_playwright
        except ImportError as e:
            raise SessionError("playwright is not installed: install orcha-cli[qa], then run `playwright install chromium`") from e
        self.playwright = await self._playwright_factory().start()
        try:
            await self._launch_browser()
            self.page = await self.context.new_page()
            self._attach(self.page)
            try:
                await self.page.goto(url, wait_until="load", timeout=NAV_TIMEOUT_MS)
            except Exception as e:  # noqa: BLE001 - Playwright's error
                raise SessionError(f"could not open {url}: {_first_line(e)}") from e
            site = same_site_redirect(url, self.page.url)
            if site and site not in self.site_origins:
                self.site_origins.append(site)
                await self._grant(site)
            await self._wait_until_rendered()
        except BaseException:
            await self._shutdown()
            raise
        shot = await self._after_look(self.last_screen) if self.last_screen is not None else await self._capture(0)
        self._mark_seen(shot)
        return shot

    async def _launch_browser(self) -> None:
        try:
            self.browser = await self.playwright.chromium.launch(
                headless=self.headless, args=list(FAKE_MEDIA_ARGS) if self.auto_allow_permissions else [],
            )
        except Exception as e:  # noqa: BLE001
            raise SessionError(f"chromium failed to launch (run `playwright install chromium`): {_first_line(e)}") from e
        self.context = await self.browser.new_context(
            viewport={"width": self.width, "height": self.height}, device_scale_factor=1,
            ignore_https_errors=True, color_scheme=DEFAULT_COLOR_SCHEME,
        )
        self.context.on("response", self._watch_site_limit)
        try:
            await self.context.add_init_script(MUTATION_WATCH_JS)
        except Exception:  # noqa: BLE001 - the settle then polls the tree
            pass
        await self._grant(self.origin)

    async def _grant(self, origin: str) -> None:
        if not self.auto_allow_permissions or not origin.startswith(("http://", "https://")):
            return
        for name in WEB_PERMISSIONS:
            try:
                await self.context.grant_permissions([name], origin=origin)
            except Exception:  # noqa: BLE001 - a permission this browser does not know
                continue

    async def _teardown(self, terminate: bool) -> None:
        await self._shutdown()

    async def start_live(self, writer: Any) -> bool:
        """Stream the page into `writer` (a `live_frames.LiveFrameWriter`) with a CDP
        screencast: Chromium sends a JPEG whenever the page repaints, each acked so the next
        one comes. False when the screencast could not start; the page then shows the frame of
        each step."""
        self._live = writer
        if await self._start_screencast():
            return True
        self._live = None
        return False

    async def stop_live(self) -> None:
        cdp, self._live_cdp, self._live = self._live_cdp, None, None
        if cdp is None:
            return
        try:
            await cdp.send("Page.stopScreencast")
            await cdp.detach()
        except Exception:  # noqa: BLE001 - the page or browser may already be gone
            pass

    async def _start_screencast(self) -> bool:
        try:
            cdp = await self.context.new_cdp_session(self.page)
            cdp.on("Page.screencastFrame", lambda event: self._on_screencast_frame(cdp, event))
            await cdp.send(
                "Page.startScreencast",
                {
                    "format": "jpeg",
                    "quality": LIVE_JPEG_QUALITY,
                    "maxWidth": max(1, self.width),
                    "maxHeight": max(1, self.height),
                    "everyNthFrame": 1,
                },
            )
        except Exception as e:  # noqa: BLE001 - live frames are a nicety; the session goes on
            print(f"live screencast unavailable: {type(e).__name__}: {e}", file=sys.stderr)
            return False
        self._live_cdp = cdp
        return True

    def _on_screencast_frame(self, cdp: Any, event: dict[str, Any]) -> None:
        writer = self._live
        if writer is not None and cdp is self._live_cdp:
            try:
                writer.offer(base64.b64decode(event.get("data") or ""))
            except (ValueError, TypeError):
                pass
        # Chromium sends the next frame only once this one is acked.
        asyncio.ensure_future(self._ack_frame(cdp, event.get("sessionId")))

    @staticmethod
    async def _ack_frame(cdp: Any, session_id: Any) -> None:
        try:
            await cdp.send("Page.screencastFrameAck", {"sessionId": session_id})
        except Exception:  # noqa: BLE001 - a closed page or stopped screencast
            pass

    async def _shutdown(self) -> None:
        for obj, name in ((self.context, "close"), (self.browser, "close"), (self.playwright, "stop")):
            if obj is None:
                continue
            try:
                await getattr(obj, name)()
            except Exception:  # noqa: BLE001 - teardown
                pass
        self.context = self.browser = self.playwright = self.page = None

    async def _ensure_alive(self) -> None:
        """Relaunch Chromium once if it went away; recreate the page after a crash or close."""
        if self.playwright is None:
            raise SessionError("the session has ended; start a new one")
        if not self.browser.is_connected():
            await self._launch_browser()
            self._recover = True
        if self._recover or self.page is None or self.page.is_closed():
            self._recover = self._crashed = False
            try:
                if self.page is not None and not self.page.is_closed():
                    await self.page.close()
            except Exception:  # noqa: BLE001
                pass
            await self._new_page(self.app_id)

    async def _new_page(self, url: str) -> None:
        self.page = await self.context.new_page()
        self._attach(self.page)
        if self._live is not None:  # the screencast belonged to the page that went away
            await self._start_screencast()
        await self._goto(url)

    async def _goto(self, url: str) -> str | None:
        """Navigate; the error's first line when it failed (also said in the events block)."""
        try:
            await self.page.goto(url, wait_until="load", timeout=NAV_TIMEOUT_MS)
        except Exception as e:  # noqa: BLE001 - Playwright's error
            why = _first_line(e)
            self._push_event("navigation", f"navigation failed: {url} ({why})")
            return why
        return None

    async def _load_settled(self) -> None:
        """Wait for a navigation the last input may have started; a quiet page returns at once."""
        try:
            await self.page.wait_for_load_state("load", timeout=LOAD_WAIT_MS)
        except Exception:  # noqa: BLE001
            pass

    # ---------- page events ----------

    def _attach(self, page: Any) -> None:
        page.on("console", self._on_console)
        page.on("pageerror", self._on_pageerror)
        page.on("request", self._on_request)
        page.on("requestfailed", self._on_requestfailed)
        page.on("requestfinished", self._on_requestfinished)
        page.on("response", self._on_response)
        page.on("crash", self._on_crash)

    def _short(self, url: str) -> str:
        if self.origin and url.startswith(self.origin):
            return url[len(self.origin):] or "/"
        return url

    def _push_event(self, kind: str, text: str) -> None:
        self._events.append(text if text.startswith(kind) else f"{kind}: {text}")

    # ---------- what the run page records (every line and call, not only the agent's events) ----

    def _log_row(self, level: str, source: str, text: str, detail: dict[str, Any] | None = None) -> None:
        if len(self._log_rows) >= TELEMETRY_BUFFER or not text:
            return
        self._log_rows.append({"at": time.time(), "level": level, "source": source, "text": text[:8000],
                               **({"detail": detail} if detail else {})})

    def _request_row(self, request: Any, status: int | None, failure: str | None) -> None:
        started = self._request_started.pop(id(request), None)
        kind = REQUEST_KINDS.get(getattr(request, "resource_type", ""))
        if kind is None or len(self._request_rows) >= TELEMETRY_BUFFER:
            return
        body = None
        try:
            body = request.post_data
        except Exception:  # noqa: BLE001 - a binary body has no text form
            pass
        at = started if started is not None else time.time()
        self._request_rows.append({
            "at": at, "kind": kind, "method": request.method, "url": scrub_url(request.url), "status": status,
            "duration_ms": int((time.time() - at) * 1000) if started is not None else None, "failure": failure,
            **({"request_body": scrub_body(body)} if body else {}),
        })

    def drain_telemetry(self) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """What the page logged and sent since the last call: (log rows, request rows)."""
        logs, requests = self._log_rows, self._request_rows
        self._log_rows, self._request_rows = [], []
        return logs, requests

    def _on_request(self, request: Any) -> None:
        self._request_started[id(request)] = time.time()

    def _on_requestfinished(self, request: Any) -> None:
        self._request_row(request, self._response_status.pop(id(request), None), None)

    def _on_console(self, msg: Any) -> None:
        self._log_row(CONSOLE_LEVELS.get(msg.type, "info"), "console", msg.text)
        if msg.type != "error":
            return
        loc = msg.location or {}
        where = f" ({self._short(loc['url']).rsplit('/', 1)[-1]}:{loc.get('lineNumber', 0)})" if loc.get("url") else ""
        self._push_event("console.error", f"{msg.text}{where}")

    def _on_pageerror(self, error: Any) -> None:
        text = getattr(error, "message", None) or str(error)
        self._log_row("error", "console", text.splitlines()[0] if text else "uncaught exception")
        self._push_event("pageerror", text.splitlines()[0] if text else "uncaught exception")

    def _on_requestfailed(self, request: Any) -> None:
        self._log_row("error", "network", f"{request.method} {self._short(request.url)} {request.failure or 'failed'}")
        self._response_status.pop(id(request), None)
        self._request_row(request, None, str(request.failure or "failed"))
        self._push_event("requestfailed", f"{request.method} {self._short(request.url)} {request.failure or 'failed'}")

    def _on_response(self, response: Any) -> None:
        status = response.status
        self._response_status[id(response.request)] = status
        if status >= 400:
            self._log_row("error" if status >= 500 else "warn", "network",
                          f"{response.request.method} {self._short(response.url)}", {"status": status})
        if status >= 500 or (status == 404 and response.request.resource_type == "document"):
            self._push_event(f"response {status}", f"{response.request.method} {self._short(response.url)}")

    def _on_crash(self, _page: Any) -> None:
        self._crashed = True
        self._log_row("error", "crash", "page crashed")
        self._push_event("crash", "page crashed")

    def _watch_site_limit(self, response: Any) -> None:
        """A 429, a `Retry-After` or a bot-protection challenge on the app's own site."""
        try:
            request = response.request
            document = request.resource_type == "document"
            if document and self.page is not None and response.frame == self.page.main_frame:
                self.last_document_status = int(response.status)
            signal = classify_response(response.url, int(response.status), response.headers,
                                       app_sites=[site_of(self.app_id)], document=document)
            if signal is not None:
                self.site_signals.append(signal)
        except Exception:  # noqa: BLE001 - detection must never break a page event
            pass

    def drain_events(self) -> str:
        """The events block since the last screen the agent saw ("" when none)."""
        if not self._events:
            return ""
        lines = [f"events since last screen ({len(self._events)}):", *self._events]
        self._events = []
        return "\n".join(lines)

    # ---------- perception ----------

    async def _extract(self, js: str = EXTRACTOR_JS) -> list[dict] | None:
        try:
            raw = await asyncio.wait_for(self.page.evaluate(js), timeout=EXTRACT_TIMEOUT_S)
        except Exception:  # noqa: BLE001
            return None
        return raw if isinstance(raw, list) else None

    async def _screenshot(self) -> bytes | None:
        try:
            return await self.page.screenshot(type="png", timeout=10_000)
        except Exception:  # noqa: BLE001
            return None

    def _allowed(self) -> set[str]:
        return {self.origin, *self.site_origins, *self.allowed_origins}

    async def _capture(self, settle_s: float = 0.0) -> Screen:
        if self._crashed:
            self._recover = True  # the next action recreates the page
            png = _blank_png(self.width, self.height)
            shot = Screen(png=png, raw=[], elements=[], tree_hash=tree_hash([]), size=(self.width, self.height),
                          foreground="crashed", foreground_name="crashed", locked_app_violation=True, tree_available=False)
            self.last_screen = shot
            return shot
        await self._ensure_alive()
        deadline = time.time() + settle_s
        while True:
            png, raw = await asyncio.gather(self._screenshot(), self._extract())
            if png is None:
                png = _blank_png(self.width, self.height)
            available = raw is not None
            elements = parse_tree(raw or [])
            if len(elements) > 1 or time.time() >= deadline:
                break
            await poll_sleep(EMPTY_TREE_RETRY_S)
        w, h = screen_size(elements)
        if w > 0 and h > 0:
            self.width, self.height = w, h
        url = self.page.url
        current = origin_of(url)
        title = elements[0].label if elements and elements[0].type == "Application" else ""
        shot = Screen(
            png=png, raw=raw or [], elements=elements, tree_hash=tree_hash(elements), size=(self.width, self.height),
            foreground=current, foreground_name=title or "untitled",
            locked_app_violation=self.lock_app and available and url != BLANK_PAGE and current not in self._allowed(),
            tree_available=available, url=url,
        )
        self.last_screen = shot
        return shot

    async def probe(self) -> Probe:
        """A settle poll: the tree only, the frame only when the tree cannot describe the page."""
        if self._crashed:
            return Probe(elements=[], tree_available=False, png=_blank_png(self.width, self.height))
        await self._ensure_alive()
        raw = await self._extract()
        elements = parse_tree(raw or [])
        available = raw is not None
        png = await self._screenshot() if needs_pixels(elements, available) else None
        return Probe(elements=elements, tree_available=available, png=png)

    async def full_page_tree(self) -> list[Any] | None:
        """The whole page's elements, beyond the viewport (nothing scrolls, `last_screen` stays);
        None when the page cannot be read."""
        if self._crashed:
            return None
        await self._ensure_alive()
        raw = await self._extract(FULL_PAGE_JS)
        return parse_tree(raw) if raw is not None else None

    async def _mutations(self) -> dict[str, Any] | None:
        if self._mutations_ok is False or self._crashed:
            return None
        try:
            out = await asyncio.wait_for(self.page.evaluate(MUTATION_READ_JS, 0), timeout=2)
        except Exception:  # noqa: BLE001 - a page mid-navigation answers on the next read
            return None
        if not isinstance(out, dict) or "n" not in out:
            self._mutations_ok = False
            return None
        self._mutations_ok = True
        return out

    async def _mark_mutations(self) -> None:
        """The mutation count before an input, so the settle counts only what it did."""
        self._mut_mark = await self._mutations() if self._mutations_ok is not False else None

    def change_signal(self, after: str) -> Any:
        if self._mutations_ok is False or self._crashed:
            return None
        mark, self._mut_mark = self._mut_mark, None
        return MutationSignal(self, mark)

    async def _after_look(self, shot: Screen) -> Screen:
        """The screen the agent sees: a rate limit or bot wall handled first (wait once, then stop),
        and the page events since the last screen appended."""
        shot = await super()._after_look(shot)
        settled, notes = shot.settled, list(shot.notes)
        shot, note = await self._site_limit_check(shot)
        if note:
            notes.insert(0, note)
        shot.settled, shot.notes = settled, notes
        events = self.drain_events()
        if events:
            shot.extra = f"{shot.extra}\n\n{events}" if shot.extra else events
        return shot

    async def _site_limit_check(self, shot: Screen) -> tuple[Screen, str | None]:
        guard = self.site_guard
        if guard.stopped:
            self.site_signals.clear()
            return shot, "site_limit: " + (guard.refusal() or "").removeprefix("error: action refused: ")
        signal = self._take_site_signal(shot)
        if signal is None:
            return shot, None
        if guard.state != "clear":
            return shot, guard.stop(signal)
        guard.state, guard.first = "backing_off", signal
        wait = guard.wait_for(signal)
        self._record("wait", {"ms": int(wait * 1000), "site_limit": signal.kind, "source": "harness"},
                     f"waited {int(wait)} s: {signal.detail}", on=shot)
        await asyncio.sleep(wait)
        guard.waited_s += wait
        self.site_signals.clear()  # what the page's own polling met during the window is the same limit
        if signal.kind == RATE_LIMITED and signal.source == "page":
            try:
                await self.page.reload(wait_until="load", timeout=NAV_TIMEOUT_MS)
            except Exception as e:  # noqa: BLE001
                self._push_event("navigation", f"reload after the rate-limit wait failed ({_first_line(e)})")
        try:
            shot = await self._capture(0)
        except Exception:  # noqa: BLE001 - the earlier screen stands
            pass
        still = self._take_site_signal(shot)
        first = guard.backoff_message(signal, wait)
        if still is not None:
            return shot, first + "\n" + guard.stop(still)
        guard.state = "slowed"
        return shot, first + "\n" + guard.resumed_message(wait)

    def _take_site_signal(self, shot: Screen) -> SiteSignal | None:
        signals, self.site_signals = list(self.site_signals), []
        page = screen_signal(shot, document_status=self.last_document_status, site=site_of(self.app_id) or None) \
            if shot.foreground in self._allowed() else None
        # A response's signal first: it carries the `Retry-After` the wait should honour.
        return (signals[-1] if signals else None) or page

    # ---------- actions ----------

    async def _act(self, kind: str, args: dict[str, Any], fn: Callable[[], Awaitable[str]], *, target: Target | None = None) -> str:
        refused = self.site_guard.refusal()
        if refused:
            return refused
        gap = self.site_guard.gap_before_action()
        if gap > 0:
            await asyncio.sleep(gap)
        try:
            return await super()._act(kind, args, fn, target=target)
        finally:
            self.site_guard.last_action_at = time.monotonic()

    async def open_url(self, url: str) -> str:
        """Navigate to `url`: only on the session's origins (else a `blocked:` result)."""
        blocked = navigation_decision(url, session_origin=self.origin, extra=[*self.site_origins, *self.allowed_origins])
        if blocked:
            self._record("open_url", {"url": url}, blocked)
            return blocked
        return await super().open_url(url)

    async def launch_app(self, app_id: str | None = None) -> str:
        """Open the start URL again, or the given URL (same origin policy as `open_url`)."""
        dest = (app_id or self.app_id).strip()
        if dest.lower().startswith(("http://", "https://", "file:", "javascript:", "data:", "blob:", "view-source:")):
            blocked = navigation_decision(dest, session_origin=self.origin, extra=[*self.site_origins, *self.allowed_origins])
            if blocked:
                self._record("launch", {"app_id": dest}, blocked)
                return blocked
        else:
            dest = self.app_id
        return await super().launch_app(dest)

    async def _tap(self, target: Target, long_press_ms: int | None) -> str:
        await self._ensure_alive()
        await self._mark_mutations()
        shot = self.last_screen or await self._capture(0)
        point, how = resolve(target, shot.elements)
        if point is None:
            return f"tap failed: {how}"
        away = off_screen(point, self.width, self.height, unit="px")
        if away:
            return f"error: {away}"
        error = await self._send_tap(point, long_press_ms)
        if error:
            return f"tap failed: {error}"
        await self._load_settled()
        verb = f"long-pressed {long_press_ms}ms" if long_press_ms else "tapped"
        return f"{verb} at {point} via {how}"

    async def _send_tap(self, point: tuple[int, int], long_press_ms: int | None = None) -> str | None:
        x, y = point
        try:
            if long_press_ms:
                await self.page.mouse.move(x, y)
                await self.page.mouse.down()
                await asyncio.sleep(long_press_ms / 1000)
                await self.page.mouse.up()
            else:
                await self.page.mouse.click(x, y)
        except Exception as e:  # noqa: BLE001
            return f"click failed: {_first_line(e)}"
        return None

    async def _swipe_points(self, x1: int, y1: int, x2: int, y2: int, duration_ms: int) -> str:
        """A swipe is a wheel scroll (touch semantics: swiping up scrolls the page down)."""
        await self._ensure_alive()
        await self._mark_mutations()
        dx, dy = x1 - x2, y1 - y2
        try:
            await self.page.mouse.move(x1, y1)
            await self.page.mouse.wheel(dx, dy)
        except Exception as e:  # noqa: BLE001
            return f"swipe failed: {_first_line(e)}"
        return f"swiped ({x1},{y1})->({x2},{y2}): scrolled by ({dx},{dy})"

    async def _press(self, key: str) -> str:
        await self._ensure_alive()
        await self._mark_mutations()
        if key in PRESS_KEYS:
            await self.page.keyboard.press(PRESS_KEYS[key])
            await self._load_settled()
            return f"pressed {key}"
        if key == "back":
            try:
                await self.page.go_back(wait_until="load", timeout=NAV_TIMEOUT_MS)
            except Exception as e:  # noqa: BLE001
                return f"back failed: {_first_line(e)}"
            await self._load_settled()
            return f"pressed back; now at {self.page.url}"
        if key == "home":
            why = await self._goto(self.app_id)
            return f"press failed: could not open {self.app_id} ({why})" if why else f"pressed home; now at {self.page.url}"
        return "error: key must be one of back, home, enter, escape, tab, backspace"

    async def _open_url(self, url: str) -> str:
        await self._ensure_alive()
        await self._mark_mutations()
        why = await self._goto(url)
        return f"open_url failed: {url} ({why})" if why else f"opened {url}"

    async def _launch(self, app_id: str) -> str:
        await self._ensure_alive()
        await self._mark_mutations()
        why = await self._goto(app_id)
        return f"launch failed: {app_id} ({why})" if why else f"launched {app_id}"

    async def _terminate(self, app_id: str) -> str:
        """Close the page and open a fresh one at the start URL (in-page state goes, cookies stay)."""
        await self._ensure_alive()
        try:
            await self.page.close()
        except Exception:  # noqa: BLE001
            pass
        await self._new_page(self.app_id)
        return f"terminated {app_id}; a fresh page is open at {self.page.url}"

    # ---------- text ----------

    async def _focus(self, target: Target) -> tuple[tuple[int, int] | None, str | None]:
        """Click the target; `(point, error)`. No locator: the focused element already."""
        if not target.has_locator:
            return None, None
        shot = self.last_screen or await self._capture(0)
        point, how = resolve(target, shot.elements)
        if point is None:
            return None, how
        away = off_screen(point, self.width, self.height, what="field", unit="px")
        if away:
            return None, away
        error = await self._send_tap(point)  # the click focuses the field before it returns
        return (None, error) if error else (point, None)

    async def _value_at(self, point: tuple[int, int] | None) -> str | None:
        try:
            val = await self.page.evaluate(VALUE_AT_JS, [point[0], point[1]] if point else [None, None])
        except Exception:  # noqa: BLE001
            return None
        return None if val is None else str(val)

    async def _type_text(self, target: Target, text: str) -> str:
        await self._ensure_alive()
        await self._mark_mutations()
        before = self.last_screen
        point, err = await self._focus(target)
        if err:
            return f"type failed: {err}"
        typed_on = shape_of(before) if before else None
        try:
            await self.page.keyboard.type(text, delay=20)
        except Exception as e:  # noqa: BLE001
            return f"type failed: {_first_line(e)}"
        await settle(self, after="type", before_shape=typed_on)
        after = self.last_screen
        assert after is not None
        after.settled = self.last_settled
        value = await self._value_at(point)
        if value is not None:
            ok = value.endswith(text)
            return f"typed {text!r}; verified: {str(ok).lower()}; field value now {value!r}"
        changed = before is not None and after.tree_hash != before.tree_hash
        hint = "screen changed after typing, check the screenshot" if changed else "screen unchanged"
        return f"typed {text!r}; verified: unknown (field not readable; {hint})"

    async def _clear_text(self, target: Target) -> str:
        await self._ensure_alive()
        await self._mark_mutations()
        before = self.last_screen
        point, err = await self._focus(target)
        if err:
            return f"clear failed: {err}"
        await self.page.keyboard.press("ControlOrMeta+A")
        await self.page.keyboard.press("Backspace")
        await settle(self, after="clear", before_shape=shape_of(before) if before else None)
        if self.last_screen is not None:
            self.last_screen.settled = self.last_settled
        value = await self._value_at(point)
        cleared = value == ""
        return f"sent select-all+delete; cleared: {str(cleared).lower()}; field value now {value if value is not None else '?'!r}"


class MutationSignal:
    """The settle's change signal on the web: the page's DOM mutation counter, read every
    `MUTATION_POLL_S` (a few numbers, where an extraction walks the DOM). Moved: more mutations
    than before the input, or a new document. Still: no mutation for the quiet window, with the
    document past loading."""

    source = "mutations"

    def __init__(self, session: WebSession, mark: dict[str, Any] | None):
        self.session = session
        self.mark = mark

    async def wait(self, *, change_s: float, quiet_s: float, max_s: float) -> SignalResult | None:
        started = now()
        base = self.mark or await self.session._mutations()
        if base is None:
            return None

        def moved(cur: dict[str, Any]) -> bool:
            return cur.get("origin") != base.get("origin") or int(cur.get("n") or 0) > int(base.get("n") or 0)

        first: float | None = None
        cur = base
        while True:
            got = await self.session._mutations()
            if got is None:
                return None
            cur = got
            if moved(cur):
                first = now() - started
                break
            if now() - started >= change_s:
                return SignalResult(changed=False, still=True, first_s=None, took_s=now() - started)
            await poll_sleep(MUTATION_POLL_S)
        if max_s <= 0:
            return SignalResult(changed=True, still=True, first_s=first, took_s=now() - started)
        deadline = now() + max_s
        while True:
            idle = float(cur.get("idle") or 0) / 1000
            if idle >= quiet_s and cur.get("ready") != "loading":
                return SignalResult(changed=True, still=True, first_s=first, took_s=now() - started)
            if now() >= deadline:
                return SignalResult(changed=True, still=False, first_s=first, took_s=now() - started)
            await poll_sleep(max(MUTATION_POLL_S, min(quiet_s - idle, deadline - now())))
            got = await self.session._mutations()
            if got is None:
                return None
            cur = got


def chromium_installed() -> bool:
    """Whether Playwright and its Chromium are installed (for `orcha qa doctor` and the tests)."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return False
    try:
        with sync_playwright() as pw:
            return Path(pw.chromium.executable_path).exists()
    except Exception:  # noqa: BLE001
        return False

