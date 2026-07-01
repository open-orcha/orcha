"""Auth v1 (#271 capability tokens): unit tests for the shared token primitives.

Pure-stdlib module, no DB — mirrors secret_box's role: one module shared by the
CLI (mint at init / connect / `orcha token`) and the portal (verify in the auth
middleware), via the same dual-context import trick.
"""
import re

from orcha_cli import auth_tokens


def test_mint_carries_kind_prefix():
    assert auth_tokens.mint("human").startswith("orcha_h_")
    assert auth_tokens.mint("ai").startswith("orcha_a_")
    assert auth_tokens.mint("daemon").startswith("orcha_d_")


def test_mint_rejects_unknown_kind():
    try:
        auth_tokens.mint("robot")
    except ValueError:
        return
    raise AssertionError("mint('robot') should raise ValueError")


def test_mint_is_unique_and_urlsafe():
    toks = {auth_tokens.mint("ai") for _ in range(64)}
    assert len(toks) == 64
    for t in toks:
        # prefix + >=32 bytes of urlsafe-b64 entropy, no padding surprises
        assert re.fullmatch(r"orcha_a_[A-Za-z0-9_-]{40,}", t), t


def test_hash_is_deterministic_sha256_hex():
    t = auth_tokens.mint("human")
    h1, h2 = auth_tokens.hash_token(t), auth_tokens.hash_token(t)
    assert h1 == h2
    assert re.fullmatch(r"[0-9a-f]{64}", h1)


def test_matches_constant_time_verify():
    t = auth_tokens.mint("ai")
    assert auth_tokens.matches(t, auth_tokens.hash_token(t))
    assert not auth_tokens.matches(t + "x", auth_tokens.hash_token(t))
    assert not auth_tokens.matches("", auth_tokens.hash_token(t))


def test_root_token_derivation_is_deterministic_per_key():
    r1 = auth_tokens.derive_root("master-key-A")
    r2 = auth_tokens.derive_root("master-key-A")
    r3 = auth_tokens.derive_root("master-key-B")
    assert r1 == r2
    assert r1 != r3
    assert r1.startswith("orcha_d_")  # the root credential IS the daemon principal


def test_is_root_verifies_and_rejects():
    key = "master-key-A"
    root = auth_tokens.derive_root(key)
    assert auth_tokens.is_root(root, key)
    assert not auth_tokens.is_root(root, "master-key-B")
    assert not auth_tokens.is_root(auth_tokens.mint("daemon"), key)
    assert not auth_tokens.is_root("", key)
