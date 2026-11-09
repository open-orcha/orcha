"""Read-only scan of an app repository for sign-in signals, used by onboarding to pre-select
methods ("We found Sign in with Apple and email login in your code."). Never writes.

What counts as the app's own sign-in, and when the scan is sure enough to pre-select:

- Tests, fixtures, mocks and docs mention sign-in to exercise or describe it, and developer
  tooling (`scripts/`, `tools/`, `bin/`, CI) signs in against a local stack to check it; none of
  them adds a signal (`not_app_code`). Nor does a file that names many ways to sign in at once
  (`CATALOGUE` or more signal kinds): that is a list of them (a detector, a docs page), not a
  sign-in screen.
- When several files show the same signal, the one cited is the app's own: a file under its
  source folders (`src/`, `app/`, `lib/`, ...) first, then a sign-in screen (`sign-in.tsx`,
  `LoginView.swift`) before a file that only calls the API (`evidence_rank`).
- More distinct methods than an app usually offers (`MAX_SURE`) is a guess, not a finding:
  `sure` is False, `preselect` is empty and the summary says so, so the person picks.
- A password field, a one-time code field or an authenticator string alone (`WEAK`) says a form
  exists, not how the app signs in: only methods a sign-in library or API backs are pre-selected.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any
from orcha_cli.qa.onboarding import ignored

SKIP_DIRS = frozenset({
    "node_modules", ".git", "Pods", "build", "DerivedData", ".next", "dist", "vendor", ".venv", "venv",
    "__pycache__", ".gradle", ".build", "Carthage", "out", "coverage", ".expo", ".turbo", "target",
})
TEXT_EXTS = frozenset({
    ".swift", ".m", ".mm", ".h", ".kt", ".kts", ".java", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
    ".dart", ".py", ".rb", ".go", ".vue", ".svelte", ".html", ".xml", ".plist", ".gradle",
    ".yaml", ".yml", ".podspec", ".resolved", ".entitlements", ".php", ".cs",
})
TEXT_NAMES = frozenset({"Podfile", "Package.swift", "Cartfile", "Gemfile", "pubspec.yaml", "package.json"})
MAX_FILES = 4000
MAX_BYTES = 512 * 1024

# (signal id, method, label for the summary, pattern)
_SIGNALS: list[tuple[str, str, str, re.Pattern[str]]] = [
    ("apple", "social", "Sign in with Apple", re.compile(r"ASAuthorizationAppleID|SignInWithAppleButton|sign_in_with_apple|expo-apple-authentication|@invertase/react-native-apple-authentication|AppleProvider\(")),
    ("google", "social", "Google Sign-In", re.compile(r"\bGIDSignIn\b|import GoogleSignIn|@react-native-google-signin|google_sign_in|com\.google\.android\.gms\.auth|GoogleProvider\(|GoogleAuthProvider")),
    ("sso", "social", "single sign-on", re.compile(r"ASWebAuthenticationSession|AzureADProvider\(|OktaProvider\(|@okta/|msal-browser|MSALPublicClientApplication|samlify")),
    ("auth0", "social", "Auth0", re.compile(r"@auth0/|react-native-auth0|import Auth0|Auth0\.webAuth|auth0_flutter")),
    ("clerk", "email_password", "Clerk", re.compile(r"@clerk/|ClerkProvider")),
    ("firebase", "email_password", "Firebase Auth", re.compile(r"import FirebaseAuth|firebase/auth|@react-native-firebase/auth|firebase_auth|FirebaseAuth\.getInstance")),
    ("email_password", "email_password", "email login", re.compile(r"signInWithEmailAndPassword|signInWithPassword|createUserWithEmailAndPassword|CredentialsProvider\(|Credentials\(\{|signIn\(['\"]credentials['\"]")),
    ("phone", "phone_sms", "phone sign-in", re.compile(r"signInWithPhoneNumber|PhoneAuthProvider|verifyPhoneNumber|signInWithOtp\(\{\s*phone")),
    ("email_code", "email_code", "email codes or magic links", re.compile(r"signInWithOtp|EmailProvider\(|sendSignInLinkToEmail|isSignInWithEmailLink|signInWithMagicLink")),
    ("supabase", "email_password", "Supabase Auth", re.compile(r"supabase\.auth\.|@supabase/auth|supabase_flutter")),
    ("nextauth", "email_password", "NextAuth", re.compile(r"next-auth|NextAuth\(|@auth/core")),
    ("password_field", "email_password", "a password field", re.compile(r"\bSecureField\b|type=[\"']password[\"']|textContentType\s*[(=:]?\s*\.?password|isSecureTextEntry\s*=\s*true|inputType=\"textPassword\"|secureTextEntry|PasswordVisualTransformation|obscureText:\s*true")),
    ("one_time_code", "email_code", "one-time code fields", re.compile(r"\.oneTimeCode|autocomplete=[\"']one-time-code[\"']|autoComplete=[\"']one-time-code[\"']|AutofillHints\.oneTimeCode|textContentType=\"oneTimeCode\"")),
    ("totp", "username_2fa", "authenticator codes", re.compile(r"['\"]otpauth['\"]|speakeasy|\bpyotp\b|otplib|TOTPGenerator")),
]
_STOREKIT = re.compile(r"import StoreKit|SKPaymentQueue|Product\.products\(for:|\.purchase\(\)|SubscriptionStoreView|StoreView\(")
_REVENUECAT = re.compile(r"import RevenueCat|Purchases\.configure|react-native-purchases|purchases_flutter|com\.revenuecat")
_LAUNCH_ARG_CALL = re.compile(r"(?:ProcessInfo\.processInfo\.arguments|CommandLine\.arguments)[^\n]{0,80}?[\"'](-?[A-Za-z][\w.-]{1,40})[\"']")
_LAUNCH_ARG_WORD = re.compile(r"premium|plus|pro\b|uitest|ui-test|ui_test|mock|debug|signedin|loggedin|demo", re.I)

_SUMMARY_ORDER = ["apple", "google", "sso", "auth0", "clerk", "firebase", "supabase", "nextauth", "email_password", "phone", "email_code", "totp"]

#: A file with this many signal kinds lists ways to sign in rather than offering them.
CATALOGUE = 6
#: More methods than this and the scan is not sure which the app uses: it pre-selects none.
MAX_SURE = 3
#: Signals that show a form, not the app's way of signing in: never pre-selected on their own.
WEAK = frozenset({"password_field", "one_time_code", "totp"})
_TEST_PATH = re.compile(
    r"(^|/)(?i:tests?|__tests__|e2e|spec|specs|fixtures?|__fixtures__|__mocks__|mocks?|testdata|test-data|docs?|examples?|stories)(/|$)"
    r"|[A-Za-z0-9]Tests?/|\.(test|spec|stories)\.[A-Za-z]+$|(^|/)test_[^/]+\.py$|_test\.(py|go|dart)$|Tests?\.(swift|kt|java)$",
)


#: Folders of UI tests an app's repository keeps beside it, which `_TEST_PATH` does not name.
_UI_TEST_DIR = re.compile(r"(^|/)(?:maestro|\.maestro|detox|cypress|playwright|integration_test|androidTest)(/|$)", re.I)
#: Developer tooling: scripts run by hand or in CI (often against a local stack), release lanes.
#: Never shipped in the app, so never its sign-in or its backend (#468).
TOOLING_DIRS = frozenset({
    "scripts", "script", "tools", "tool", "tooling", "devtools", "bin", "ci", ".github", ".circleci", ".husky", "fastlane",
})
#: Folders where an app keeps its own code. A tooling-named folder inside one (`src/scripts/`) is
#: the app's code, not tooling.
SOURCE_DIRS = frozenset({
    "src", "source", "sources", "app", "lib", "pages", "components", "screens", "views", "features", "modules",
})
_SIGN_IN_NAME = re.compile(r"sign[-_ ]?in|log[-_ ]?in", re.I)


def is_test_path(rel: str) -> bool:
    """A test, fixture, mock, story or doc: it mentions sign-in, it does not offer it."""
    return bool(_TEST_PATH.search(rel.replace(os.sep, "/")))


def is_tooling_path(rel: str) -> bool:
    """A file in a developer tooling folder (`scripts/check.ts`, `apps/mobile/scripts/seed.ts`,
    `tools/`, `bin/`, CI), unless that folder sits inside the app's source (`src/scripts/`)."""
    for part in rel.replace(os.sep, "/").lower().split("/")[:-1]:
        if part in SOURCE_DIRS:
            return False
        if part in TOOLING_DIRS:
            return True
    return False


def not_app_code(rel: str) -> bool:
    """Not the app's own code: a test, fixture, mock, doc, UI test or developer tooling. It may
    sign in or name a backend, but the app does not ship it, so it is never evidence."""
    rel = rel.replace(os.sep, "/")
    return is_test_path(rel) or is_tooling_path(rel) or bool(_UI_TEST_DIR.search(rel))


def evidence_rank(rel: str) -> tuple[int, int]:
    """How well a file shows the app's own sign-in, lowest best: under the app's source folders
    first, then a sign-in screen (its name says sign in or log in), then anything under an auth
    folder or named for auth, then the rest."""
    parts = rel.replace(os.sep, "/").lower().split("/")
    folders, name = parts[:-1], parts[-1]
    in_source = any(p in SOURCE_DIRS for p in folders)
    if _SIGN_IN_NAME.search(name):
        screen = 0
    elif "auth" in name or any(_SIGN_IN_NAME.search(p) or "auth" in p for p in folders):
        screen = 1
    else:
        screen = 2
    return (0 if in_source else 1, screen)


def _files(root: Path):
    count = 0
    skip = ignored.matcher(root)
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".") and not d.endswith((".xcassets", ".xcframework", ".framework")) and not skip(os.path.join(dirpath, d))]
        for name in filenames:
            path = Path(dirpath) / name
            if path.suffix == ".storekit" or path.suffix in TEXT_EXTS or name in TEXT_NAMES:
                count += 1
                if count > MAX_FILES:
                    return
                yield path


def _join(items: list[str]) -> str:
    if len(items) <= 1:
        return "".join(items)
    return ", ".join(items[:-1]) + " and " + items[-1]


def _parts(found_labels: list[str], plan: dict[str, Any]) -> list[str]:
    parts = list(found_labels)
    if plan.get("storekit_files"):
        parts.append("a StoreKit configuration file")
    elif plan.get("revenuecat"):
        parts.append("RevenueCat subscriptions")
    elif plan.get("storekit"):
        parts.append("StoreKit purchases")
    return parts


def summary_for(found_labels: list[str], plan: dict[str, Any]) -> str:
    parts = _parts(found_labels, plan)
    return f"We found {_join(parts)} in your code." if parts else ""


def detect(repo_path: str | os.PathLike[str]) -> dict[str, Any]:
    root = Path(repo_path)
    # Each signal once, in the order first seen, from the file that shows it best (`evidence_rank`).
    best: dict[str, dict[str, str]] = {}
    plan: dict[str, Any] = {"storekit_files": [], "revenuecat": False, "storekit": False, "launch_args": []}
    for path in _files(root):
        rel = str(path.relative_to(root))
        if path.suffix == ".storekit":
            plan["storekit_files"].append(rel)
            continue
        try:
            if path.stat().st_size > MAX_BYTES:
                continue
            text = path.read_text(errors="ignore")
        except OSError:
            continue
        hits = []
        if not not_app_code(rel):
            for sid, method, label, pattern in _SIGNALS:
                if pattern.search(text):
                    # Sign in with Apple needs AuthenticationServices in Swift; other files match by API.
                    if sid == "apple" and path.suffix == ".swift" and "AuthenticationServices" not in text and "SignInWithAppleButton" not in text:
                        continue
                    hits.append((sid, method, label))
        if len(hits) < CATALOGUE:
            for sid, method, label in hits:
                if sid not in best or evidence_rank(rel) < evidence_rank(best[sid]["path"]):
                    best[sid] = {"id": sid, "method": method, "label": label, "path": rel}
        if not plan["storekit"] and _STOREKIT.search(text):
            plan["storekit"] = True
        if not plan["revenuecat"] and _REVENUECAT.search(text):
            plan["revenuecat"] = True
        for m in _LAUNCH_ARG_CALL.finditer(text):
            arg = m.group(1)
            if _LAUNCH_ARG_WORD.search(arg) and arg not in plan["launch_args"]:
                plan["launch_args"].append(arg)
    plan["storekit_files"].sort()
    signals = list(best.values())  # dicts keep insertion order: the order first seen
    methods: list[str] = []
    for s in signals:
        # A password field alone is weak, but still says the app has a form login.
        if s["method"] not in methods:
            methods.append(s["method"])
    # "email login" from a library name (Firebase, Supabase, Clerk, NextAuth) without an
    # email API seen still counts: those all default to email sign-in.
    order = {sid: i for i, sid in enumerate(_SUMMARY_ORDER)}
    labelled = sorted((s for s in signals if s["id"] in order), key=lambda s: order[s["id"]])
    labels: list[str] = []
    for s in labelled:
        label = s["label"]
        if s["id"] in ("firebase", "supabase", "nextauth", "clerk") and any(x["id"] == "email_password" for x in signals):
            continue  # say "email login" once rather than the library and the login
        if label not in labels:
            labels.append(label)
    if not labels and any(s["id"] == "password_field" for s in signals):
        labels.append("a password field")
    strong = [m for m in methods if any(s["method"] == m and s["id"] not in WEAK for s in signals)]
    sure = len(methods) <= MAX_SURE
    if not sure:
        summary = unsure_summary(labels)
    elif signals and not strong:
        summary = weak_summary(_parts(labels, plan))
    else:
        summary = summary_for(labels, plan)
    return {"methods": methods, "preselect": strong if sure else [], "sure": sure and bool(strong or not signals),
            "signals": signals, "plan": plan, "summary": summary}


def unsure_summary(labels: list[str]) -> str:
    return (f"Your code mentions {_join(labels)}: more ways to sign in than an app usually offers, so Embodent is not sure "
            "which this app uses and picked none. Choose the ones it does.")


def weak_summary(labels: list[str]) -> str:
    return (f"We found {_join(labels)} in your code but no sign-in library or API, so Embodent picked nothing. "
            "Choose how the app signs in, if it does.")
