"""Auth v1 (#271): capability-token primitives shared by the CLI and the portal.

Pure stdlib (secrets/hashlib/hmac/base64) by design — mirrors secret_box.py: the
portal container gets a copy next to main.py at scaffold time, host/pytest runs
import it from the orcha_cli package. The server stores ONLY sha256 hashes of
tokens; the plaintext is shown once at mint time and never persisted server-side.

Token shapes
------------
* minted per-agent:   orcha_<k>_<43 chars urlsafe b64 of 32 random bytes>
  where <k> is h/a/d for the principal kind (human / ai / daemon). The prefix
  exists for secret-scanner greppability, not for authorization — the kind that
  matters is the one on the agent row the token resolves to.
* derived root:       orcha_d_<43 chars urlsafe b64 HMAC-SHA256(master, PURPOSE)>
  deterministically derived from ORCHA_SECRET_KEY (the master key the CLI already
  persists to .orcha/.env — see __main__._ensure_secret_key). Host filesystem
  access is the local root of trust: whoever can read the master key owns the
  stack anyway, so the CLI and host daemons authenticate with this derived
  credential and no DB row is needed to bootstrap. Rotate by rotating the key.
"""
import base64
import hashlib
import hmac
import secrets

_PREFIX = {"human": "orcha_h_", "ai": "orcha_a_", "daemon": "orcha_d_"}

# Domain-separation constant for the derived root credential. Versioned so a
# future derivation change can coexist during a rotation window.
_ROOT_PURPOSE = b"orcha-root-credential-v1"


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def mint(kind: str) -> str:
    """Mint a fresh per-agent token for a principal kind (human|ai|daemon)."""
    try:
        prefix = _PREFIX[kind]
    except KeyError:
        raise ValueError(f"unknown principal kind {kind!r}; expected one of {sorted(_PREFIX)}")
    return prefix + _b64url(secrets.token_bytes(32))


def hash_token(token: str) -> str:
    """The server-side storable form: sha256 hex of the full token string."""
    return hashlib.sha256(token.encode()).hexdigest()


def matches(token: str, token_hash: str) -> bool:
    """Constant-time check of a presented token against a stored hash."""
    return hmac.compare_digest(hash_token(token), token_hash)


def derive_root(master_key: str) -> str:
    """The project's derived root credential (kind='daemon') — see module docstring."""
    mac = hmac.new(master_key.encode(), _ROOT_PURPOSE, hashlib.sha256).digest()
    return _PREFIX["daemon"] + _b64url(mac)


def is_root(token: str, master_key: str) -> bool:
    """Constant-time check: is `token` THIS project's derived root credential?"""
    if not token or not master_key:
        return False
    return hmac.compare_digest(token, derive_root(master_key))
