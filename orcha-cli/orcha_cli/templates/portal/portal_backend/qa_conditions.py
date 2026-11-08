"""Run conditions: the state a case needs before it can be judged, on any platform.

A scenario keeps the conditions it always needs; a run, a QA request, a finding's reproduction or
a task's "Send to Quality when finished" can ask for more. The run's own conditions win key by key
(`merge`). Orcha sets what it can on the device (`native`); the agent sets up the rest with its own
tools, such as an MCP server that hands out a test account with an active subscription. A condition
that cannot be met makes the checks it touches blocked, never passed.

These are words: nothing secret goes in a condition. An account is described ("An account with an
active subscription"), never given.
"""

from __future__ import annotations

import json
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

KEYS = ("os", "locale", "text_size", "appearance", "timezone", "network", "account", "setup")
TEXT_SIZES = ("small", "default", "large", "larger", "largest")


class Conditions(BaseModel):
    """What a case needs. Every key is optional; an empty one is not asked."""

    model_config = ConfigDict(extra="forbid")

    os: Optional[str] = Field(default=None, max_length=40, description="The OS version: \"13\", \"Android 13\", \"iOS 18.2\"")
    locale: Optional[str] = Field(default=None, max_length=35, description="BCP-47 language and region: \"sw-KE\"")
    text_size: Optional[Literal["small", "default", "large", "larger", "largest"]] = None
    appearance: Optional[Literal["light", "dark"]] = None
    timezone: Optional[str] = Field(default=None, max_length=64, description="IANA: \"Africa/Nairobi\"")
    network: Optional[Literal["online", "offline", "slow"]] = None
    account: Optional[str] = Field(default=None, max_length=300, description="The kind of user, in words")
    setup: Optional[str] = Field(default=None, max_length=2000, description="Steps for the agent; may name its tools")

    @field_validator("*", mode="before")
    @classmethod
    def _blank(cls, v: Any) -> Any:
        if isinstance(v, str):
            v = " ".join(v.split()) if "\n" not in v else v.strip()
            return v or None
        return v


def clean(value: Any) -> Optional[dict[str, Any]]:
    """Stored form: only the keys asked, or None when nothing is. Accepts a model, a dict or JSON text."""
    if value is None:
        return None
    if isinstance(value, Conditions):
        data = value.model_dump()
    else:
        if isinstance(value, (bytes, bytearray)):
            value = value.decode()
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except ValueError:
                return None
        if not isinstance(value, dict):
            return None
        data = Conditions.model_validate(value).model_dump()
    out = {k: data[k] for k in KEYS if data.get(k) not in (None, "")}
    return out or None


def dumps(value: Any) -> Optional[str]:
    c = clean(value)
    return json.dumps(c, sort_keys=True) if c else None


def merge(base: Any, over: Any) -> Optional[dict[str, Any]]:
    """`over` wins key by key; a key `over` leaves empty keeps `base`'s."""
    a, b = clean(base) or {}, clean(over) or {}
    out = {**a, **b}
    return out or None


#: A few common languages and regions by name; anything else reads as its code.
_LANGUAGES = {"en": "English", "sw": "Swahili", "fr": "French", "es": "Spanish", "pt": "Portuguese", "de": "German", "ar": "Arabic",
              "zh": "Chinese", "ja": "Japanese", "ko": "Korean", "hi": "Hindi", "it": "Italian", "nl": "Dutch", "ru": "Russian",
              "tr": "Turkish", "am": "Amharic", "so": "Somali", "he": "Hebrew", "id": "Indonesian", "pl": "Polish"}
_REGIONS = {"KE": "Kenya", "TZ": "Tanzania", "UG": "Uganda", "US": "United States", "GB": "United Kingdom", "FR": "France",
            "ES": "Spain", "MX": "Mexico", "BR": "Brazil", "PT": "Portugal", "DE": "Germany", "AE": "United Arab Emirates",
            "SA": "Saudi Arabia", "CN": "China", "JP": "Japan", "IN": "India", "CA": "Canada", "AU": "Australia", "NG": "Nigeria",
            "ZA": "South Africa", "ET": "Ethiopia", "SO": "Somalia", "EG": "Egypt", "IT": "Italy", "NL": "Netherlands"}
_PLATFORM = {"ios": "iOS", "android": "Android", "web": "Web"}


def locale_words(code: str) -> str:
    """`sw-KE` -> `Swahili (Kenya)`; an unknown code reads as itself."""
    parts = code.replace("_", "-").split("-")
    lang = _LANGUAGES.get(parts[0].lower())
    region = next((_REGIONS.get(p.upper()) for p in parts[1:] if len(p) == 2), None)
    if not lang:
        return code
    return f"{lang} ({region})" if region else lang


def os_words(os: str, platform: Optional[str]) -> str:
    """"13" on Android -> "Android 13"; a value that names its OS stays."""
    name = _PLATFORM.get(platform or "")
    if name and os[:1].isdigit() and platform != "web":
        return f"{name} {os}"
    return os


def words(value: Any, platform: Optional[str] = None) -> list[str]:
    """Each condition in plain words, in a fixed order."""
    c = clean(value) or {}
    out: list[str] = []
    if c.get("os"):
        out.append(os_words(c["os"], platform))
    if c.get("locale"):
        out.append(locale_words(c["locale"]))
    if c.get("text_size"):
        out.append("Text: " + c["text_size"].title())
    if c.get("appearance"):
        out.append(c["appearance"].title())
    if c.get("timezone"):
        out.append("Time zone: " + c["timezone"])
    if c.get("network"):
        out.append({"online": "Online", "offline": "Offline", "slow": "Slow network"}[c["network"]])
    if c.get("account"):
        out.append("Account: " + c["account"])
    if c.get("setup"):
        out.append("Setup: " + c["setup"])
    return out


def native(platform: Optional[str], physical: bool = False) -> set[str]:
    """What Orcha sets on the device itself; the agent sets up the rest. `os` is checked, not set."""
    if platform == "web":
        return {"locale", "text_size", "appearance", "timezone", "network"}
    if platform == "android":
        return {"os", "locale", "text_size", "appearance"} | (set() if physical else {"network"})
    if platform == "ios":
        return {"os", "locale"} if physical else {"os", "locale", "text_size", "appearance"}
    return set()


def unavailable(platform: Optional[str], physical: bool = False) -> set[str]:
    """What a physical phone cannot be put in: pick a simulator or an emulator for these."""
    if not physical:
        return set()
    return {"ios": {"text_size", "appearance", "network", "timezone"}, "android": {"network", "timezone"}}.get(platform or "", set())


def prompt_line(value: Any) -> Optional[str]:
    """What a worker is told: pass them to start_session."""
    c = clean(value)
    if not c:
        return None
    return f"Conditions: pass conditions={json.dumps(c, separators=(',', ':'), ensure_ascii=False)} to start_session. A person asked for them."


_TABLES = frozenset({"qa_scenarios", "qa_findings", "qa_requests", "qa_sessions"})


def store(cur, table: str, row_id: str, value: Any, *, replace: bool = False) -> None:
    """Write a row's conditions. Without `replace`, nothing asked leaves what is stored."""
    if table not in _TABLES:
        raise ValueError(table)
    text = dumps(value)
    if text is None and not replace:
        return
    cur.execute(f"UPDATE {table} SET conditions=%s WHERE id=%s", (text, row_id))
