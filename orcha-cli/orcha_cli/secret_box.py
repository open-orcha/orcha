"""secret_box — pure-stdlib authenticated encryption for secrets stored at rest (#294).

WHAT THIS IS FOR
----------------
Item 1 of the SETTINGS epic stores a per-container Anthropic API key in the Postgres
`containers` row so the universal LLM client (#290) can run without every operator
exporting ``ORCHA_LLM_API_KEY`` by hand. This module seals that key so the value sitting
in a DB row / backup / log dump is not a directly usable credential.

THREAT MODEL — read before trusting this (honest by design)
-----------------------------------------------------------
This is **defense-in-depth at rest, NOT a security boundary.** The master key lives in
``ORCHA_SECRET_KEY`` in the same host environment as the daemon AND the database, so
anyone with host access can decrypt. The real trust boundary is the host + the DB access
control, not this cipher. What it buys you: a leaked DB snapshot / pg_dump / log line does
not hand over a working key. That is the whole claim — no more.

CONSTRUCTION (scheme ``v1``) — encrypt-then-MAC, zero third-party deps
---------------------------------------------------------------------
Only ``hashlib``/``hmac``/``os``/``base64`` — same no-dependency contract as ``llm_util``
and ``notifier``, so this file imports UNCHANGED from both deploy contexts (host daemon as
``orcha_cli.secret_box``; portal container as top-level ``secret_box``, copied in at scaffold
alongside ``main.py`` like ``llm_util``).

  master      = ORCHA_SECRET_KEY (utf-8)
  nonce       = os.urandom(16)                              # fresh per seal
  ek          = HKDF-SHA256(master, salt=nonce, info=".../enc/v1", 32B)
  mk          = HKDF-SHA256(master, salt=nonce, info=".../mac/v1", 32B)
  keystream   = HMAC-SHA256(ek, nonce || counter)*          # CTR mode
  ciphertext  = plaintext XOR keystream
  tag         = HMAC-SHA256(mk, "v1" || nonce || ciphertext)  # authenticate scheme+nonce+ct
  blob        = "v1:" + base64(nonce || ciphertext || tag)

The ``"v1:"`` prefix makes every stored blob **self-describing**: a future Fernet/AES scheme
registers as ``"v2:"`` and ``unseal`` dispatches on the prefix, so the upgrade is data-loss
free — old rows keep decrypting under v1, new rows write v2. (Helm GO ruling, req a2dde155.)
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
from typing import Mapping, Optional

_SCHEME = "v1"
_MASTER_ENV = "ORCHA_SECRET_KEY"
_OVERRIDE_ENV = "ORCHA_LLM_API_KEY"  # env override wins over any stored key (read path)
_NONCE_LEN = 16
_TAG_LEN = 32
_HASH = hashlib.sha256


# ----------------------------------------------------------------------- errors


class SecretBoxError(Exception):
    """Base for any seal/unseal failure."""


class MissingMasterKey(SecretBoxError):
    """ORCHA_SECRET_KEY is not set — encrypted persistence is disabled (honest, not silent)."""


class DecryptionError(SecretBoxError):
    """Blob is malformed, uses an unknown scheme, or fails authentication (wrong key/tampered)."""


# ------------------------------------------------------------------ key handling


def master_key_present(env: Optional[Mapping[str, str]] = None) -> bool:
    """True when a non-empty ORCHA_SECRET_KEY is available — i.e. persistence is possible.

    Routes use this to return an HONEST 'persistence disabled' error instead of 500ing when
    the operator hasn't configured a master key (the env-override read path still works)."""
    e = os.environ if env is None else env
    return bool(e.get(_MASTER_ENV))


def _master_key(env: Optional[Mapping[str, str]] = None) -> bytes:
    e = os.environ if env is None else env
    raw = e.get(_MASTER_ENV)
    if not raw:
        raise MissingMasterKey(
            f"{_MASTER_ENV} is not set; encrypted secret storage is disabled. "
            f"Set {_MASTER_ENV} in the daemon/portal environment to enable it."
        )
    return raw.encode("utf-8")


def _hkdf(ikm: bytes, *, salt: bytes, info: bytes, length: int = 32) -> bytes:
    """HKDF (RFC 5869) over SHA-256: extract-then-expand. length<=32 needs one expand block."""
    prk = hmac.new(salt, ikm, _HASH).digest()  # extract
    okm = b""
    block = b""
    counter = 1
    while len(okm) < length:
        block = hmac.new(prk, block + info + bytes([counter]), _HASH).digest()  # expand
        okm += block
        counter += 1
    return okm[:length]


def _keystream(ek: bytes, nonce: bytes, n: int) -> bytes:
    """HMAC-SHA256 in counter mode: KS = HMAC(ek, nonce||ctr) for ctr=0,1,... truncated to n."""
    out = bytearray()
    counter = 0
    while len(out) < n:
        out += hmac.new(ek, nonce + counter.to_bytes(8, "big"), _HASH).digest()
        counter += 1
    return bytes(out[:n])


# ------------------------------------------------------------------ seal / unseal


def seal(plaintext: str, *, env: Optional[Mapping[str, str]] = None) -> str:
    """Encrypt ``plaintext`` -> ``"v1:<base64>"``. Raises MissingMasterKey if no master key."""
    master = _master_key(env)
    nonce = os.urandom(_NONCE_LEN)
    ek = _hkdf(master, salt=nonce, info=f"orcha-secret-box/enc/{_SCHEME}".encode())
    mk = _hkdf(master, salt=nonce, info=f"orcha-secret-box/mac/{_SCHEME}".encode())
    pt = plaintext.encode("utf-8")
    ks = _keystream(ek, nonce, len(pt))
    ct = bytes(a ^ b for a, b in zip(pt, ks))
    tag = hmac.new(mk, _SCHEME.encode() + nonce + ct, _HASH).digest()
    return f"{_SCHEME}:" + base64.b64encode(nonce + ct + tag).decode("ascii")


def unseal(blob: str, *, env: Optional[Mapping[str, str]] = None) -> str:
    """Decrypt a ``"v1:<base64>"`` blob -> plaintext. Raises DecryptionError on any mismatch.

    Authentication is verified (encrypt-then-MAC) BEFORE decrypting, with a constant-time tag
    compare, so a wrong master key or a tampered ciphertext fails closed rather than returning
    garbage."""
    master = _master_key(env)
    try:
        scheme, b64 = blob.split(":", 1)
    except (ValueError, AttributeError):
        raise DecryptionError("malformed secret blob: missing scheme prefix")
    if scheme != _SCHEME:
        raise DecryptionError(f"unsupported secret scheme {scheme!r} (this build knows {_SCHEME!r})")
    try:
        raw = base64.b64decode(b64, validate=True)
    except (ValueError, TypeError) as e:
        raise DecryptionError(f"malformed secret blob: bad base64 ({e})")
    if len(raw) < _NONCE_LEN + _TAG_LEN:
        raise DecryptionError("malformed secret blob: too short")
    nonce, ct, tag = raw[:_NONCE_LEN], raw[_NONCE_LEN:-_TAG_LEN], raw[-_TAG_LEN:]
    mk = _hkdf(master, salt=nonce, info=f"orcha-secret-box/mac/{_SCHEME}".encode())
    expected = hmac.new(mk, _SCHEME.encode() + nonce + ct, _HASH).digest()
    if not hmac.compare_digest(tag, expected):
        raise DecryptionError("authentication failed: wrong master key or tampered ciphertext")
    ek = _hkdf(master, salt=nonce, info=f"orcha-secret-box/enc/{_SCHEME}".encode())
    ks = _keystream(ek, nonce, len(ct))
    return bytes(a ^ b for a, b in zip(ct, ks)).decode("utf-8")


# --------------------------------------------------------------------- read path


def last4(key: str) -> str:
    """Last 4 chars of a key, for the masked display hint. Short keys -> what's available."""
    return key[-4:] if key else ""


def resolve_llm_key(stored_blob: Optional[str], *,
                    env: Optional[Mapping[str, str]] = None) -> Optional[str]:
    """The READ PATH (#294 deliverable). Return the effective LLM API key, or None.

    Precedence — env override > DB-stored (decrypted) > None:
      1. ``ORCHA_LLM_API_KEY`` env  — operator override, always wins (mirrors llm_util's own
         precedence; lets ops force a key without touching the DB).
      2. ``stored_blob`` decrypted  — the per-container key sealed via :func:`seal`.
      3. ``None``                   — caller passes this straight to ``llm_util`` as ``api_key=``,
         which then keeps its own provider-env fallback (ANTHROPIC_API_KEY).

    A stored blob that cannot be decrypted (no master key / corrupt / tampered) is treated as
    'no stored key' rather than raising, so a bad row degrades to the env/None fallback instead
    of breaking every read. Triage call-site wiring is downstream (#288/#290) — this function is
    the read path those callers will use after fetching the row's ``llm_api_key_enc``."""
    e = os.environ if env is None else env
    override = e.get(_OVERRIDE_ENV)
    if override:
        return override
    if stored_blob:
        try:
            return unseal(stored_blob, env=e)
        except SecretBoxError:
            return None
    return None
