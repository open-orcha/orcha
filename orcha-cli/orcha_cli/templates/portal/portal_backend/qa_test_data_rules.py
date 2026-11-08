"""Where a project's data is for: its country, phone format and money, inferred from the
project's own texts. No model is called."""

from __future__ import annotations

import json
import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Iterable

MAX_RECORDS = 100
MAX_FIELDS = 20
MAX_VALUE = 500
FORMATS = ("data", "examples", "seed", "stub")


class TestDataError(ValueError):
    """Records that break a rule; str(e) lists every problem, so the model can fix them at once."""


@dataclass(frozen=True)
class Locale:
    code: str
    country: str
    language: str
    currency: tuple[str, ...]  # symbols and codes, the first is the one to show
    phone: str  # a regex over the number with spaces, dashes, dots and brackets removed
    phone_example: str
    postcode: str | None = None
    postcode_example: str | None = None
    cities: tuple[str, ...] = ()
    dialling: str = ""


LOCALES: dict[str, Locale] = {
    l.code: l
    for l in (
        Locale("PT", "Portugal", "pt-PT", ("€", "EUR"), r"^(\+351)?9[1236]\d{7}$", "+351 912 345 678", r"^\d{4}-\d{3}$", "1100-053", ("Lisboa", "Lisbon", "Porto", "Braga", "Coimbra", "Faro", "Setúbal"), "+351"),
        Locale("TZ", "Tanzania", "sw-TZ", ("TSh", "TZS", "Tsh"), r"^(\+255|0)[67]\d{8}$", "+255 754 123 456", r"^\d{5}$", "11101", ("Dar es Salaam", "Arusha", "Dodoma", "Mwanza", "Zanzibar", "Moshi", "Mbeya"), "+255"),
        Locale("KE", "Kenya", "en-KE", ("KSh", "KES", "Ksh"), r"^(\+254|0)[17]\d{8}$", "+254 712 345 678", r"^\d{5}$", "00100", ("Nairobi", "Mombasa", "Kisumu", "Nakuru", "Eldoret"), "+254"),
        Locale("UG", "Uganda", "en-UG", ("USh", "UGX"), r"^(\+256|0)7\d{8}$", "+256 772 123 456", None, None, ("Kampala", "Entebbe", "Jinja", "Gulu"), "+256"),
        Locale("RW", "Rwanda", "rw-RW", ("RWF", "FRw"), r"^(\+250|0)7[2389]\d{7}$", "+250 788 123 456", None, None, ("Kigali", "Butare", "Musanze"), "+250"),
        Locale("ET", "Ethiopia", "am-ET", ("Br", "ETB"), r"^(\+251|0)9\d{8}$", "+251 911 234 567", r"^\d{4}$", "1000", ("Addis Ababa", "Dire Dawa", "Bahir Dar"), "+251"),
        Locale("NG", "Nigeria", "en-NG", ("₦", "NGN"), r"^(\+234|0)[789][01]\d{8}$", "+234 803 123 4567", r"^\d{6}$", "100001", ("Lagos", "Abuja", "Kano", "Ibadan", "Port Harcourt"), "+234"),
        Locale("ZA", "South Africa", "en-ZA", ("R", "ZAR"), r"^(\+27|0)[6-8]\d{8}$", "+27 82 123 4567", r"^\d{4}$", "8001", ("Johannesburg", "Cape Town", "Durban", "Pretoria"), "+27"),
        Locale("EG", "Egypt", "ar-EG", ("E£", "EGP", "ج.م"), r"^(\+20|0)1[0125]\d{8}$", "+20 100 123 4567", r"^\d{5}$", "11511", ("Cairo", "Alexandria", "Giza"), "+20"),
        Locale("AE", "United Arab Emirates", "ar-AE", ("AED", "د.إ"), r"^(\+971|0)5\d{8}$", "+971 50 123 4567", None, None, ("Dubai", "Abu Dhabi", "Sharjah"), "+971"),
        Locale("GB", "United Kingdom", "en-GB", ("£", "GBP"), r"^(\+44|0)7\d{9}$", "+44 7700 900123", r"^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$", "SW1A 1AA", ("London", "Manchester", "Birmingham", "Leeds", "Glasgow", "Edinburgh", "Bristol"), "+44"),
        Locale("US", "United States", "en-US", ("$", "USD", "US$"), r"^(\+1)?[2-9]\d{2}[2-9]\d{6}$", "+1 415 555 0132", r"^\d{5}(-\d{4})?$", "94103", ("New York", "San Francisco", "Chicago", "Austin", "Seattle", "Los Angeles", "Boston"), "+1"),
        Locale("BR", "Brazil", "pt-BR", ("R$", "BRL"), r"^(\+55)?\d{2}9\d{8}$", "+55 11 91234-5678", r"^\d{5}-?\d{3}$", "01310-100", ("São Paulo", "Rio de Janeiro", "Belo Horizonte", "Salvador"), "+55"),
        Locale("DE", "Germany", "de-DE", ("€", "EUR"), r"^(\+49|0)1[5-7]\d{8,9}$", "+49 151 23456789", r"^\d{5}$", "10115", ("Berlin", "München", "Munich", "Hamburg", "Köln", "Frankfurt"), "+49"),
        Locale("FR", "France", "fr-FR", ("€", "EUR"), r"^(\+33|0)[67]\d{8}$", "+33 6 12 34 56 78", r"^\d{5}$", "75011", ("Paris", "Lyon", "Marseille", "Toulouse", "Bordeaux"), "+33"),
        Locale("ES", "Spain", "es-ES", ("€", "EUR"), r"^(\+34)?[67]\d{8}$", "+34 612 345 678", r"^\d{5}$", "28013", ("Madrid", "Barcelona", "Valencia", "Sevilla", "Bilbao"), "+34"),
        Locale("IT", "Italy", "it-IT", ("€", "EUR"), r"^(\+39)?3\d{8,9}$", "+39 312 345 6789", r"^\d{5}$", "00184", ("Roma", "Rome", "Milano", "Milan", "Napoli", "Torino"), "+39"),
        Locale("NL", "Netherlands", "nl-NL", ("€", "EUR"), r"^(\+31|0)6\d{8}$", "+31 6 12345678", r"^\d{4}\s?[A-Z]{2}$", "1012 AB", ("Amsterdam", "Rotterdam", "Utrecht", "Den Haag"), "+31"),
        Locale("IN", "India", "en-IN", ("₹", "INR", "Rs"), r"^(\+91|0)?[6-9]\d{9}$", "+91 98765 43210", r"^\d{6}$", "560001", ("Mumbai", "Delhi", "Bengaluru", "Bangalore", "Chennai", "Hyderabad"), "+91"),
    )
}

#: Fields that never show on screen: the only place a run tag may go.
HIDDEN_FIELDS = frozenset({
    "notes", "note", "internal_note", "internal_notes", "external_id", "external_ref", "ref", "reference", "source",
    "metadata", "meta", "client_ref", "idempotency_key", "run_tag", "test_tag", "tag", "created_by", "import_ref",
})
#: Field names that hold a secret: refused in any proposal.
SECRET_FIELD = re.compile(r"pass(word|wd|code)?$|^pin$|secret|token|api[_-]?key|apikey|credential|private[_-]?key|otp|cvv|cvc|card[_-]?number|^pan$|session[_-]?id|cookie|authorization|bearer", re.I)

_PHONE_KEY = re.compile(r"phone|mobile|^tel$|telefone|telem[oó]vel|^cell|msisdn|whatsapp|simu", re.I)
_POSTCODE_KEY = re.compile(r"post_?code|postal|^zip|zip_?code|c[oó]digo_?postal|^cep$|plz", re.I)
_MONEY_KEY = re.compile(r"price|amount|total|cost|fee|rent|salary|pre[cç]o|valor|bei|kodi", re.I)
_NAME_KEY = re.compile(r"name|title|label|store|shop|merchant|listing|product|company|business|owner|customer|driver|plate|headline", re.I)
_EMAIL_KEY = re.compile(r"e-?mail", re.I)

# The scenario lint's own patterns (orcha.scenarios.lint): a run tag shown, and junk values.
_RUN_TAG = re.compile(r"\{\{\s*tag4?\s*\}\}|\bQA-|\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{8}\b", re.I)
_TAG_PLACEHOLDER = re.compile(r"\{\{\s*tag4?\s*\}\}")
_JUNK = re.compile(
    r"^(?:test(?:ing)?|asdf+|qwerty|foo|bar|baz|lorem(?:\s+ipsum.*)?|dummy|sample|xxx+|abc|aaa+|user|name|value|placeholder|n/?a|tbd|todo)[\s_-]*\d*$"
    r"|^[A-Z][a-z]+\d{3,}$",
    re.IGNORECASE,
)
_LOREM = re.compile(r"\blorem ipsum\b", re.I)
_FAKE_MAIL = re.compile(r"@(?:example|test|invalid|localhost|mailinator)\.", re.I)
_COUNTER = re.compile(r"^(.*?\S)\s*#?\s*(\d{1,3})$")
_CURRENCY_TOKEN = re.compile(r"(R\$|US\$|E£|[€£$₦₹]|\b(?:EUR|USD|GBP|TZS|TSh|KES|KSh|UGX|USh|RWF|FRw|ETB|NGN|ZAR|EGP|AED|BRL|INR|Rs)\b)")
_COLUMN = re.compile(r"^[A-Za-z_][A-Za-z0-9_ .\-]{0,63}$")
_ENDPOINT = re.compile(r"^(GET|POST|PUT|PATCH|DELETE|ANY)\s+(/\S*|https?://\S+)$", re.I)


def _norm_key(key: str) -> str:
    return re.sub(r"[\s\-]+", "_", str(key).strip().lower())


def is_hidden(key: str) -> bool:
    return _norm_key(key) in HIDDEN_FIELDS


def is_secret_field(key: str) -> bool:
    return bool(SECRET_FIELD.search(_norm_key(key)))


def secret_keys(value: Any, path: str = "") -> list[str]:
    """Every key in `value` (nested dicts and lists) named like a secret."""
    out: list[str] = []
    if isinstance(value, dict):
        for k, v in value.items():
            p = f"{path}.{k}" if path else str(k)
            if is_secret_field(str(k)):
                out.append(p)
            out += secret_keys(v, p)
    elif isinstance(value, list):
        for i, v in enumerate(value[:200]):
            out += secret_keys(v, f"{path}[{i}]")
    return out


# ---------- the locale ----------


def locale_of(code: Any) -> Locale | None:
    return LOCALES.get(str(code or "").strip().upper()[:2])


def infer_locale(texts: Iterable[str]) -> tuple[Locale | None, str]:
    """The country the project's data is for, from its texts (the `[test_data]` memory line
    first), with what gave it away. Dialling codes and currencies weigh more than a city name."""
    score: Counter[str] = Counter()
    why: dict[str, str] = {}
    for weight, text in enumerate(texts):
        t = str(text or "")
        if not t:
            continue
        w = 3 if weight == 0 else 1  # the memory line (first) says it outright
        for loc in LOCALES.values():
            if loc.dialling and re.search(re.escape(loc.dialling) + r"[\s\d]", t):
                score[loc.code] += 3 * w
                why.setdefault(loc.code, f"phone numbers start {loc.dialling}")
            if re.search(rf"\b{re.escape(loc.code)}\b|{re.escape(loc.language)}", t):
                score[loc.code] += 2 * w
                why.setdefault(loc.code, f"says {loc.language}")
            for c in loc.cities:
                if re.search(rf"\b{re.escape(c)}\b", t, re.I):
                    score[loc.code] += 2 * w
                    why.setdefault(loc.code, f"mentions {c}")
                    break
            sym = loc.currency[0]
            if len(sym) > 1 and re.search(rf"(?<![A-Za-z]){re.escape(sym)}\b", t):
                score[loc.code] += 2 * w
                why.setdefault(loc.code, f"prices in {sym}")
        if "€" in t:
            for code in ("PT", "DE", "FR", "ES", "IT", "NL"):
                score[code] += 1
    if not score:
        return None, ""
    code, _n = score.most_common(1)[0]
    return LOCALES[code], why.get(code, "")
