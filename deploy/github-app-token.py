#!/usr/bin/env python3
"""Mint a short-lived GitHub App installation token (stdlib + the openssl binary).

The app's private key NEVER leaves the host — sandboxes only ever see the
1-hour tokens this mints. Used by bootstrap-clone.sh (clone/install Orcha on a
fresh box) and by the github-token-refresh systemd timer (keep a fresh token in
each workspace so sandboxed agents can pull/push/PR as the app bot).

    python3 github-app-token.py --pem auth/github-app.pem --app-id 12345 \
        [--repo owner/name]        # scope the token to one repo; when several
                                   # installations exist, ALSO auto-selects the
                                   # one whose account login matches `owner`
        [--installation-id N]      # skip auto-discovery
        [--list-installations]     # print JSON [{"id": .., "owner": ..}] and exit

Prints the token to stdout; everything else goes to stderr.
App id lives in auth/github-app.json (key "id") after setup-github.py.
"""
from __future__ import annotations

import argparse
import base64
import json
import pathlib
import subprocess
import sys
import time
import urllib.error
import urllib.request

API = "https://api.github.com"


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def app_jwt(pem: pathlib.Path, app_id: str) -> str:
    now = int(time.time())
    header = b64url(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    payload = b64url(json.dumps(
        {"iat": now - 60, "exp": now + 540, "iss": app_id}).encode())
    signing_input = f"{header}.{payload}".encode()
    sig = subprocess.run(
        ["openssl", "dgst", "-sha256", "-sign", str(pem)],
        input=signing_input, capture_output=True, check=True).stdout
    return f"{header}.{payload}.{b64url(sig)}"


def gh(path: str, jwt: str, method: str = "GET", body: dict | None = None) -> dict | list:
    req = urllib.request.Request(
        API + path, method=method,
        headers={"Authorization": f"Bearer {jwt}",
                 "Accept": "application/vnd.github+json",
                 "User-Agent": "orcha-cloud-token"},
        data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def _login(inst: dict) -> str:
    return (inst.get("account") or {}).get("login") or ""


def installations_summary(installs: list) -> list:
    """The --list-installations payload: [{"id": 123, "owner": "acme"}, ...]."""
    return [{"id": inst.get("id"), "owner": _login(inst)} for inst in installs]


def pick_installation(installs: list, owner: str | None = None) -> dict:
    """Pick the installation to mint from.

    owner given (from --repo owner/name) → the installation whose account login
    matches case-insensitively; no match is a 404-style LookupError naming the
    owners the app IS installed on. owner None → installs[0] (legacy behavior).
    """
    if not installs:
        raise LookupError(
            "the app is installed on nothing — install it on your repos first "
            "(the app's page → Install App).")
    if owner is None:
        return installs[0]
    for inst in installs:
        if _login(inst).lower() == owner.lower():
            return inst
    available = ", ".join(sorted(_login(i) or "?" for i in installs))
    raise LookupError(
        f"no installation found for owner {owner!r} — the app is installed on: "
        f"{available}. Install the app on that org/user, or pass --installation-id.")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pem", required=True, type=pathlib.Path)
    ap.add_argument("--app-id", required=True)
    ap.add_argument("--installation-id", default=None)
    ap.add_argument("--repo", default=None,
                    help="owner/name to scope the token to (also selects the "
                         "owner's installation when several exist)")
    ap.add_argument("--list-installations", action="store_true",
                    help='print JSON [{"id": .., "owner": ..}] of the app\'s '
                         "installations and exit")
    args = ap.parse_args()

    if args.repo and "/" not in args.repo:
        print(f"error: --repo must be owner/name, got {args.repo!r}", file=sys.stderr)
        return 1

    jwt = app_jwt(args.pem, args.app_id)

    if args.list_installations:
        print(json.dumps(installations_summary(gh("/app/installations", jwt))))
        return 0

    inst = args.installation_id
    if inst is None:
        installs = gh("/app/installations", jwt)
        owner = args.repo.split("/", 1)[0] if args.repo else None
        try:
            chosen = pick_installation(installs, owner)
        except LookupError as e:
            print(f"error: {e}", file=sys.stderr)
            return 1
        inst = chosen["id"]
        if owner is None and len(installs) > 1:
            print(f"note: {len(installs)} installations; using {inst} "
                  f"({_login(chosen)}). Pass --repo owner/name or "
                  f"--installation-id to pick.", file=sys.stderr)
    body: dict = {}
    if args.repo:
        body = {"repositories": [args.repo.split("/", 1)[1]]}
    try:
        tok = gh(f"/app/installations/{inst}/access_tokens", jwt, "POST", body)
    except urllib.error.HTTPError as e:
        print(f"error: token mint failed ({e.code}): {e.read().decode()[:300]}",
              file=sys.stderr)
        return 1
    print(tok["token"])
    print(f"expires: {tok.get('expires_at')}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
