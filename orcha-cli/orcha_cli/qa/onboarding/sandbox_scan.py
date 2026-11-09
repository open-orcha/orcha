"""Which sandboxed services an app's repository shows, per platform: in-app purchases, payments,
email and SMS. It answers the We found sheet's Test data line. Reads only.

What counts as ready is deliberately narrow, because a sandbox called ready would be believed:

- **Purchases** are never ready from the repository alone. A `.storekit` file (and a scheme that
  uses it) is only loaded when Xcode runs the app, and Play billing needs license testers the
  repository cannot show. Both are evidence, and a person decides.
- **Payments** are ready when an environment file holds Stripe *test* keys; a live key is
  reported, never treated as a sandbox. Key values are never kept, only which file has which
  prefix.
- **Email** is ready when the backend sends mail to a sink (Mailpit, MailHog, Mailtrap, a log or
  console mailer) and the app runs locally: a staging site uses its own mail settings.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlsplit
from orcha_cli.qa.onboarding import ignored

SKIP_DIRS = frozenset({
    "node_modules", ".git", ".svn", ".hg", "build", "Build", "dist", ".next", "out", "Pods", "DerivedData", ".build", ".derived",
    ".gradle", ".idea", ".venv", "venv", "__pycache__", "vendor", ".claude", ".expo", "coverage", "tmp", "outputs", "__MACOSX",
})
MAX_FILES = 40_000
MAX_DEPTH = 10
MAX_READ_BYTES = 512 * 1024
MAX_SOURCE_READS = 6000

_SOURCE_EXTS = {"swift", "m", "mm", "kt", "java", "dart", "ts", "tsx", "js", "jsx", "mjs"}
_MANIFEST = re.compile(r"^(package\.json|requirements[\w.-]*\.txt|pyproject\.toml|composer\.json|Gemfile|Podfile|Package\.swift|pubspec\.yaml|build\.gradle(\.kts)?|libs\.versions\.toml)$")
_COMPOSE = re.compile(r"^(docker-)?compose[\w.-]*\.ya?ml$", re.I)
_SETTINGS = re.compile(r"^(settings[\w.-]*\.py|mail\.php|mailer\.ts|mailer\.js|config\.ya?ml)$", re.I)
_ENV_FILE = re.compile(r"^\.env(\.(local|development|dev|test|testing|staging|example))?$|^\.env\..*\.local$", re.I)

_PURCHASE_CALL = re.compile(r"\b(Product\.products\(|SKProductsRequest|SKPaymentQueue|Transaction\.(updates|currentEntitlements)|Purchases\.configure)")
_MAIL_SENDER_CODE = re.compile(r"\b(nodemailer|@sendgrid/mail|from [\"']resend[\"']|postmark|mailgun)\b")
_PLAY_BILLING = re.compile(r"com\.android\.billingclient|billing-ktx|\bbilling\s*=|revenuecat", re.I)
_STRIPE_USED = re.compile(r"[\"'@/]stripe\b|\bstripe[\s=<>~^\"']|StripePaymentSheet|stripe-android|flutter_stripe", re.I)
_MAIL_SENDER_DEP = re.compile(r"nodemailer|@sendgrid|\"resend\"|postmark|mailgun|django-anymail|symfony/mailer", re.I)
_SMS_DEP = re.compile(r"twilio|africastalking|vonage|messagebird", re.I)
_MAIL_SINK_SERVICE = re.compile(r"\b(mailpit|mailhog|maildev|inbucket|smtp4dev)\b", re.I)
_STRIPE_TEST = re.compile(r"\b(pk|sk|rk)_test_[A-Za-z0-9]")
_STRIPE_LIVE = re.compile(r"\b(pk|sk|rk)_live_[A-Za-z0-9]")
_MAIL_SETTING = re.compile(r"^\s*(MAIL_MAILER|MAIL_HOST|EMAIL_HOST|SMTP_HOST|MAIL_DRIVER|EMAIL_BACKEND)\s*=", re.M)
_MAIL_SINKS = (
    re.compile(r"^\s*MAIL_(MAILER|DRIVER)\s*=\s*[\"']?(log|array)\b", re.M),
    re.compile(r"^\s*(MAIL_HOST|EMAIL_HOST|SMTP_HOST)\s*=\s*[\"']?(localhost|127\.0\.0\.1|mailpit|mailhog|maildev|sandbox\.smtp\.mailtrap\.io|smtp\.mailtrap\.io)\b", re.M),
    re.compile(r"^\s*EMAIL_BACKEND\s*=\s*[\"']?[\w.]*(console|locmem|filebased|dummy)", re.M),
)
_SMS_SETTING = re.compile(r"^\s*(TWILIO_|AFRICASTALKING_|AT_API_KEY|VONAGE_)", re.M)
_MAIL_CONFIG = re.compile(r"EMAIL_BACKEND|MAIL_MAILER|smtp", re.I)
_DJANGO_SINK = re.compile(r"EMAIL_BACKEND\s*=\s*[\"'][\w.]*(console|locmem|filebased)")


def _files(root: Path) -> list[str]:
    out: list[str] = []
    skip = ignored.matcher(root)
    for dirpath, dirnames, filenames in os.walk(root):
        depth = len(Path(dirpath).relative_to(root).parts)
        dirnames[:] = [] if depth >= MAX_DEPTH else [d for d in dirnames if d not in SKIP_DIRS and not d.endswith((".xcarchive", ".app")) and not skip(os.path.join(dirpath, d))]
        for name in filenames:
            if len(out) >= MAX_FILES:
                return out
            out.append((Path(dirpath) / name).relative_to(root).as_posix())
    return out


def _read(root: Path, rel: str) -> Optional[str]:
    path = root / rel
    try:
        if path.stat().st_size > MAX_READ_BYTES:
            return None
        return path.read_text(errors="ignore")
    except OSError:
        return None


def read_signals(root: Path, files: list[str]) -> dict[str, Any]:
    """Everything the repository shows, before it is split by platform."""
    s: dict[str, Any] = {
        "storekit": {"files": [], "schemes": [], "imports": False}, "play_billing": None,
        "stripe": {"used": None, "test_keys": None, "live_keys": None}, "email": {"sender": None, "sink": None}, "sms": None,
    }
    email, stripe, storekit = s["email"], s["stripe"], s["storekit"]
    reads = 0
    for path in files:
        base = path.rsplit("/", 1)[-1]
        ext = base.rsplit(".", 1)[-1].lower() if "." in base[1:] else ""
        if ext == "storekit":
            storekit["files"].append(path)
            continue
        source = ext in _SOURCE_EXTS
        manifest = bool(_MANIFEST.match(base))
        compose = bool(_COMPOSE.match(base))
        settings = bool(_SETTINGS.match(base))
        env_file = bool(_ENV_FILE.match(base))
        if not (source or manifest or compose or settings or env_file or ext == "xcscheme"):
            continue
        if source and reads > MAX_SOURCE_READS:
            continue
        text = _read(root, path)
        reads += 1
        if not text:
            continue
        if ext == "xcscheme":
            if "StoreKitConfigurationFileReference" in text:
                storekit["schemes"].append(re.sub(r"\.xcscheme$", "", base))
        elif source:
            # In-app purchase calls, not `import StoreKit` alone (a review prompt imports it too).
            if ext == "swift" and _PURCHASE_CALL.search(text):
                storekit["imports"] = True
            if not email["sender"] and _MAIL_SENDER_CODE.search(text):
                email["sender"] = path
        elif manifest:
            if not s["play_billing"] and _PLAY_BILLING.search(text) and re.search(r"gradle|toml", base):
                s["play_billing"] = path
            if not stripe["used"] and _STRIPE_USED.search(text):
                stripe["used"] = path
            if not email["sender"] and _MAIL_SENDER_DEP.search(text):
                email["sender"] = path
            if not s["sms"] and _SMS_DEP.search(text):
                s["sms"] = path
        elif compose:
            if not email["sink"] and _MAIL_SINK_SERVICE.search(text):
                email["sink"] = f"{path} runs a mail sink"
        elif env_file:
            if not stripe["test_keys"] and _STRIPE_TEST.search(text):
                stripe["test_keys"] = path
            if not stripe["live_keys"] and _STRIPE_LIVE.search(text):
                stripe["live_keys"] = path
            if not email["sender"] and _MAIL_SETTING.search(text):
                email["sender"] = path
            sink = next((m.group(0) for m in (p.search(text) for p in _MAIL_SINKS) if m), None)
            if sink and not email["sink"]:
                key, _, value = sink.partition("=")
                email["sink"] = f"{path} ({key.strip()}={value.strip().strip(chr(34) + chr(39))})"
            if not s["sms"] and _SMS_SETTING.search(text):
                s["sms"] = path
        elif settings:
            if not email["sender"] and _MAIL_CONFIG.search(text):
                email["sender"] = path
            hit = _DJANGO_SINK.search(text)
            if not email["sink"] and hit:
                email["sink"] = f"{path} (a {hit.group(1)} mail backend)"
    return s


def runs_locally(kind: str, locator: Optional[str]) -> bool:
    """The app runs on this machine, so its backend's local settings are the ones in the repository."""
    if kind in ("ios", "android"):
        return False
    loc = (locator or "").strip()
    if not loc or not re.match(r"https?://", loc, re.I):
        return bool(loc)
    host = urlsplit(loc).hostname or ""
    return host in ("localhost", "127.0.0.1", "0.0.0.0") or host.endswith((".local", ".test"))


def sandboxes_for(s: dict[str, Any], kind: str, locator: Optional[str]) -> dict[str, dict[str, Any]]:
    """The sandboxes one platform uses: `{key: {ready, evidence}}`; `ready` True, or None when a
    person has to say."""
    out: dict[str, dict[str, Any]] = {}
    kit, stripe, email = s["storekit"], s["stripe"], s["email"]
    if kind == "ios" and (kit["files"] or kit["imports"]):
        if kit["files"]:
            scheme = f", used by the {kit['schemes'][0]} scheme" if kit["schemes"] else ""
            evidence = f"{kit['files'][0]}{scheme}: Xcode loads it, a build installed for testing does not"
        else:
            evidence = "the app sells in-app purchases (StoreKit) and the repository has no StoreKit configuration"
        out["purchases"] = {"ready": None, "evidence": evidence}
    if kind == "android" and s["play_billing"]:
        out["purchases"] = {"ready": None, "evidence": f"Play Billing in {s['play_billing']}: license testers cannot be read from the repository"}
    if stripe["test_keys"]:
        out["payments"] = {"ready": True, "evidence": f"Stripe test keys in {stripe['test_keys']}"}
    elif stripe["live_keys"] or stripe["used"]:
        out["payments"] = {"ready": None, "evidence": f"live Stripe keys in {stripe['live_keys']}, no test keys" if stripe["live_keys"] else f"Stripe in {stripe['used']}, no test keys found"}
    if email["sender"] or email["sink"]:
        if email["sink"] and runs_locally(kind, locator):
            out["email"] = {"ready": True, "evidence": email["sink"]}
        else:
            out["email"] = {"ready": None, "evidence": f"{email['sink']}, for local runs only" if email["sink"] else f"the app sends email ({email['sender']}), no sink found"}
    if s["sms"]:
        out["sms"] = {"ready": None, "evidence": f"an SMS provider in {s['sms']}"}
    return out


def detect(root: str | os.PathLike[str], platforms: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """`{kind: {key: {ready, evidence}}}` for the platforms found; a platform with none is left out."""
    base = Path(root)
    signals = read_signals(base, _files(base))
    out = {p["kind"]: sandboxes_for(signals, p["kind"], p.get("app_id")) for p in platforms}
    return {k: v for k, v in out.items() if v}
