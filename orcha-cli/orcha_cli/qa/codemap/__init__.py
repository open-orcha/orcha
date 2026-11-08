"""Orcha QA's code map: what a native app's repo declares about its screens, navigation, backend
calls and data models, read deterministically (no model, no network, no build), as the body of
`POST /api/containers/{cid}/qa/map/import` (docs/orcha-qa-plan.md). Ported from the original's
`app_map/code*.py` and `exploration/feature_map.py`: SwiftUI / UIKit, Kotlin / Jetpack Compose
and Android activities, Flutter, React Native and Expo (web too with `react-native-web`), and on
the web Next.js (app and pages routers), React Router and the JS servers beside them.

    from orcha_cli.qa.codemap import build_payload, detect_platforms
    for platform in detect_platforms(repo):
        body = build_payload(repo, platform)
"""

from __future__ import annotations

from orcha_cli.qa.codemap.payload import build_payload, counts, detect_platforms

__all__ = ["build_payload", "counts", "detect_platforms"]
