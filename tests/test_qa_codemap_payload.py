"""The code map as the `POST /api/containers/{cid}/qa/map/import` body (`orcha_cli.qa.codemap`,
docs/orcha-qa-plan.md): its shape, what each platform keeps of a repo that holds an iOS app, an
Android app and a Next.js web app (`tests/fixtures/qa_codemap/homes`), and `detect_platforms`."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from orcha_cli.qa.codemap import build_payload, counts, detect_platforms

HOMES = Path(__file__).resolve().parent / "fixtures" / "qa_codemap" / "homes"


def _tree(root: Path, files: dict[str, str]) -> Path:
    for rel, text in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
    return root


def _nodes(body: dict, kind: str) -> dict[str, dict]:
    return {n["key"]: n for n in body["nodes"] if n["kind"] == kind}


def _edges(body: dict, kind: str) -> set[tuple[str, str]]:
    return {(e["from_key"], e["to_key"]) for e in body["edges"] if e["kind"] == kind}


@pytest.fixture(scope="module")
def ios() -> dict:
    return build_payload(HOMES, "ios")


@pytest.fixture(scope="module")
def android() -> dict:
    return build_payload(HOMES, "android")


@pytest.fixture(scope="module")
def web() -> dict:
    return build_payload(HOMES, "web")


# ---------- shape ----------


def test_the_body_is_the_import_contract(ios, android, web):
    for body, platform in ((ios, "ios"), (android, "android"), (web, "web")):
        assert set(body) == {"platform", "source", "replace_source", "features", "nodes", "edges"}
        assert (body["platform"], body["source"], body["replace_source"]) == (platform, "code", True)
        json.dumps(body)  # plain JSON, nothing to coerce
        for f in body["features"]:
            assert set(f) == {"key", "name", "summary", "entry", "paths"}
        for n in body["nodes"]:
            assert set(n) == {"kind", "key", "label", "feature_key", "state", "sources", "evidence", "detail"}
            assert n["kind"] in ("screen", "endpoint", "entity", "flow")
            assert (n["state"], n["sources"]) == ("declared", ["code"])
            assert n["evidence"] and all(set(p) == {"path", "line"} for p in n["evidence"])
        nodes = {(n["kind"], n["key"]) for n in body["nodes"]}
        for e in body["edges"]:
            assert set(e) == {"kind", "from_kind", "from_key", "to_kind", "to_key", "label", "sources", "evidence", "detail"}
            assert e["kind"] in ("navigates", "calls", "reads", "writes", "steps")
            # Every end is a node of the same body.
            assert (e["from_kind"], e["from_key"]) in nodes and (e["to_kind"], e["to_key"]) in nodes
        features = {f["key"] for f in body["features"]}
        assert {n["feature_key"] for n in body["nodes"] if n["feature_key"]} <= features


def test_the_body_is_deterministic(ios):
    assert build_payload(HOMES, "ios") == ios


def test_an_unknown_platform_is_refused_and_an_odd_repo_is_empty(tmp_path):
    with pytest.raises(ValueError):
        build_payload(HOMES, "desktop")
    body = build_payload(tmp_path / "missing", "ios")
    assert (body["features"], body["nodes"], body["edges"]) == ([], [], [])


# ---------- iOS ----------


def test_ios_keeps_the_swift_app_only(ios):
    screens = _nodes(ios, "screen")
    assert set(screens) == {"listings", "listing-detail", "new-listing", "settings"}  # the tab bar is no screen
    listings = screens["listings"]
    assert listings["label"] == "Listings" and listings["feature_key"] == "listings"
    assert listings["evidence"] == [{"path": "ios/Homes/Features/Listings/ListingsView.swift", "line": 4}]
    assert (listings["detail"]["platform"], listings["detail"]["framework"]) == ("ios", "swiftui")
    assert listings["detail"]["title"] == "Listings"
    assert {"Open listing", "Add listing"} <= set(listings["detail"]["texts"])
    assert "ios/Homes/Features/Listings/ListingsModel.swift" in listings["detail"]["files"]
    assert screens["settings"]["detail"]["links"] == [{"uri": "homes://settings", "kind": "scheme", "label": "settings"}]
    # Neither the Android app's nor the web app's facts.
    assert set(_nodes(ios, "endpoint")) == {"GET /v1/listings"}
    assert not [k for k in screens if k.startswith("/")]


def test_ios_edges_navigation_tabs_calls_and_data(ios):
    assert _edges(ios, "navigates") == {
        ("listings", "listing-detail"), ("listings", "new-listing"), ("listings", "settings"), ("settings", "listings"),
    }
    labels = {(e["from_key"], e["to_key"]): e["label"] for e in ios["edges"]}
    assert labels[("listings", "listing-detail")] == "Open listing"
    assert labels[("listings", "settings")] == "Settings tab"
    # The view model only the listings screen renders makes the call: the screen calls it.
    assert _edges(ios, "calls") == {("listings", "GET /v1/listings")}
    assert _nodes(ios, "endpoint")["GET /v1/listings"]["feature_key"] == "listings"
    assert _edges(ios, "reads") == {("listings", "listing")} and _edges(ios, "writes") == {("new-listing", "listing")}
    entity = _nodes(ios, "entity")["listing"]
    assert entity["detail"] == {"store": "swiftdata", "fields": ["title", "createdAt"]}


def test_ios_features(ios):
    features = {f["key"]: f for f in ios["features"]}
    assert set(features) == {"listings", "settings"}
    assert features["listings"]["name"] == "Listings" and features["listings"]["entry"] == "ListingsView"
    assert features["listings"]["summary"] == "3 screens: Listing detail, Listings, New listing"


# ---------- Android ----------


def test_android_keeps_the_kotlin_app_only(android):
    screens = _nodes(android, "screen")
    assert set(screens) == {"/listings", "/listing/*"}
    assert screens["/listing/*"]["label"] == "Listing detail"
    assert screens["/listings"]["detail"]["framework"] == "compose"
    assert screens["/listings"]["detail"]["texts"] == ["Listings near you"]
    assert _edges(android, "navigates") == {("/listings", "/listing/*")}
    endpoints = _nodes(android, "endpoint")
    assert set(endpoints) == {"GET /v1/listings", "POST /v1/listings/*/favorite"}
    assert endpoints["GET /v1/listings"]["detail"]["handler"] == "listings"
    assert not _nodes(android, "entity")
    assert [f["key"] for f in android["features"]] == ["listings"]


def test_the_body_fits_the_import_route_limits(tmp_path):
    # 40 features on one phone: the import route takes 30, the ones with the most code stay.
    files = {"App/HomesApp.swift": "import SwiftUI\n@main\nstruct HomesApp: App {\n    var body: some Scene { WindowGroup { RootView() } }\n}\n"}
    views = [f"Topic{chr(65 + i // 26)}{chr(65 + i % 26)}View" for i in range(40)]
    files["App/RootView.swift"] = "import SwiftUI\nstruct RootView: View {\n    var body: some View { TabView {\n" + "".join(
        f"        {v}().tabItem {{ Text(\"{v}\") }}\n" for v in views) + "    } }\n}\n"
    for v in views:
        files[f"App/Features/{v[:-4]}/{v}.swift"] = f"import SwiftUI\nstruct {v}: View {{ var body: some View {{ Text(\"Hi\") }} }}\n"
    body = build_payload(_tree(tmp_path, files), "ios")
    assert len(_nodes(body, "screen")) == 40 and len(body["features"]) == 30
    features = {f["key"] for f in body["features"]}
    assert all(n["feature_key"] in features or n["feature_key"] is None for n in body["nodes"])
    assert all(len(e["label"]) <= 200 for e in body["edges"])


def test_counts(ios, android, web):
    assert counts(ios) == {
        "screens": 4, "endpoints": 1, "entities": 1, "features": 2, "edges": 7,
        "edges_calls": 1, "edges_navigates": 4, "edges_reads": 1, "edges_writes": 1,
    }
    assert counts(android)["screens"] == 2 and counts(android)["edges"] == 1
    assert counts(web) == {"screens": 2, "endpoints": 1, "entities": 0, "features": 2, "edges": 2, "edges_calls": 1, "edges_navigates": 1}


# ---------- the web ----------


def test_web_keeps_the_next_app_keyed_by_route(web):
    screens = _nodes(web, "screen")
    assert set(screens) == {"/", "/listings/*"}
    detail = screens["/listings/*"]
    assert detail["label"] == "Listings detail" and detail["evidence"] == [{"path": "web/app/listings/[id]/page.tsx", "line": 1}]
    assert (detail["detail"]["route"], detail["detail"]["platform"], detail["detail"]["framework"]) == ("/listings/*", "web", "next")
    assert _edges(web, "navigates") == {("/", "/listings/*")}
    assert {(e["from_key"], e["to_key"]): e["label"] for e in web["edges"]}[("/", "/listings/*")] == "Open listing"
    # The page's fetch and the route handler that answers it are one endpoint.
    endpoint = _nodes(web, "endpoint")["GET /api/stats"]
    assert endpoint["detail"]["side"] == "both" and endpoint["feature_key"] == "home"
    assert _edges(web, "calls") == {("/", "GET /api/stats")}
    assert not _nodes(web, "entity")  # the SwiftData model is iOS's


def test_a_node_server_and_prisma_are_the_webs(tmp_path):
    root = _tree(tmp_path, {
        "web/package.json": '{"dependencies": {"react-dom": "18.3.0", "react-router-dom": "6.26.0"}}',
        "web/src/main.tsx": """import { createBrowserRouter } from "react-router-dom";
import { Trips } from "./Trips";
export const router = createBrowserRouter([{ path: "/trips", element: <Trips /> }]);
""",
        "web/src/Trips.tsx": 'export function Trips() { const load = () => fetch("/api/trips"); return null }\n',
        "server/package.json": '{"dependencies": {"express": "4.19.0", "@prisma/client": "5.0.0"}}',
        "server/src/index.ts": """import express from "express";
import { prisma } from "./db";
const app = express();
app.get("/api/trips", async (_req, res) => res.json(await prisma.trip.findMany()));
""",
        "server/prisma/schema.prisma": "model Trip {\n  id String @id\n  title String\n}\n",
        "mobile/package.json": '{"dependencies": {"expo": "51.0.0", "expo-router": "3.5.0"}}',
        "mobile/app/_layout.tsx": "export default function Layout() { return null }\n",
        "mobile/app/trips.tsx": 'export default function Trips() { fetch("https://api.x.test/api/trips"); return null }\n',
    })
    assert detect_platforms(root) == ["ios", "android", "web"]
    web = build_payload(root, "web")
    assert set(_nodes(web, "screen")) == {"/trips"}
    assert _nodes(web, "screen")["/trips"]["detail"]["framework"] == "react-router"
    assert _nodes(web, "endpoint")["GET /api/trips"]["detail"]["side"] == "both"
    assert _edges(web, "calls") == {("/trips", "GET /api/trips")}
    assert _edges(web, "reads") == {("GET /api/trips", "trip")}
    assert _nodes(web, "entity")["trip"]["detail"]["store"] == "prisma"
    # The phones keep the Expo screen and its call, never the server's route or model.
    ios = build_payload(root, "ios")
    assert set(_nodes(ios, "screen")) == {"/trips"} and _nodes(ios, "screen")["/trips"]["detail"]["framework"] == "expo"
    assert _nodes(ios, "endpoint")["GET /api/trips"]["detail"]["side"] == "client"
    assert not _nodes(ios, "entity")


def test_an_expo_app_with_react_native_web_is_on_the_web_until_a_web_app_is(tmp_path):
    expo = {
        "package.json": '{"dependencies": {"expo": "51.0.0", "expo-router": "3.5.0", "react-native-web": "0.19.0"}}',
        "app/_layout.tsx": "export default function Layout() { return null }\n",
        "app/index.tsx": "export default function Home() { return null }\n",
    }
    root = _tree(tmp_path / "expo", expo)
    assert set(_nodes(build_payload(root, "web"), "screen")) == {"/"}
    assert set(_nodes(build_payload(root, "android"), "screen")) == {"/"}
    both = _tree(tmp_path / "both", {
        **{f"mobile/{k}": v for k, v in expo.items()},
        "site/package.json": '{"dependencies": {"next": "14.0.0"}}',
        "site/app/about/page.tsx": "export default function About() { return null }\n",
    })
    web = build_payload(both, "web")
    assert {k: n["detail"]["framework"] for k, n in _nodes(web, "screen").items()} == {"/about": "next"}
    assert set(_nodes(build_payload(both, "ios"), "screen")) == {"/"}


# ---------- cross-platform apps ----------


def test_a_react_native_app_in_a_monorepo_ignores_the_web_app(tmp_path):
    root = _tree(tmp_path, {
        "apps/mobile/package.json": '{"dependencies": {"expo": "51.0.0", "expo-router": "3.5.0"}}',
        "apps/mobile/app/_layout.tsx": "export default function Layout() { return null }\n",
        "apps/mobile/app/index.tsx": 'export default function Home() { fetch("https://api.fleet.test/trips"); return null }\n',
        "apps/web/package.json": '{"dependencies": {"next": "14.0.0"}}',
        "apps/web/lib/api.ts": 'export const stats = () => fetch("https://api.fleet.test/stats");\n',
    })
    assert detect_platforms(root) == ["ios", "android", "web"]
    for platform in ("ios", "android"):
        body = build_payload(root, platform)
        assert set(_nodes(body, "screen")) == {"/"}
        assert set(_nodes(body, "endpoint")) == {"GET /trips"}
        assert _edges(body, "calls") == {("/", "GET /trips")}
    # The Expo app has no react-native-web: the web map is the web app's alone.
    web = build_payload(root, "web")
    assert not _nodes(web, "screen") and set(_nodes(web, "endpoint")) == {"GET /stats"}


def test_a_flutter_screen_gives_way_to_the_native_one_on_its_phone(tmp_path):
    pubspec = "name: homes\ndependencies:\n  flutter:\n    sdk: flutter\n"
    root = _tree(tmp_path, {
        "flutter/pubspec.yaml": pubspec,
        "flutter/lib/main.dart": "import 'package:flutter/material.dart';\nvoid main() => runApp(MaterialApp(home: HomeScreen()));\n",
        "flutter/lib/screens/home_screen.dart": "import 'package:flutter/material.dart';\nclass HomeScreen extends StatelessWidget {\n  Widget build(BuildContext context) => Text('Welcome home');\n}\n",
        "ios/Homes/HomesApp.swift": "import SwiftUI\n@main\nstruct HomesApp: App {\n    var body: some Scene { WindowGroup { FeedView() } }\n}\n",
        "ios/Homes/FeedView.swift": "import SwiftUI\nstruct FeedView: View {\n    var body: some View { Text(\"Feed\") }\n}\n",
    })
    ios = {n["key"]: n["detail"]["framework"] for n in build_payload(root, "ios")["nodes"] if n["kind"] == "screen"}
    android = {n["key"]: n["detail"]["framework"] for n in build_payload(root, "android")["nodes"] if n["kind"] == "screen"}
    assert ios == {"feed": "swiftui"}
    assert android == {"home": "flutter"}


# ---------- detect_platforms ----------


def test_detect_platforms_on_the_fixture_and_on_odd_repos(tmp_path):
    assert detect_platforms(HOMES) == ["ios", "android", "web"]
    assert detect_platforms(tmp_path / "missing") == []
    assert detect_platforms(_tree(tmp_path / "go", {"main.go": "package main"})) == []
    assert detect_platforms(_tree(tmp_path / "web", {"package.json": '{"dependencies": {"next": "14"}}'})) == ["web"]
    assert detect_platforms(_tree(tmp_path / "api", {"package.json": '{"dependencies": {"express": "4"}}'})) == []


def test_detect_platforms_reads_the_project_files(tmp_path):
    assert detect_platforms(_tree(tmp_path / "xc", {"App.xcodeproj/project.pbxproj": "", "App/ContentView.swift": ""})) == ["ios"]
    assert detect_platforms(_tree(tmp_path / "droid", {"app/src/main/AndroidManifest.xml": "<manifest/>"})) == ["android"]
    flutter = "name: x\ndependencies:\n  flutter:\n    sdk: flutter\n"
    assert detect_platforms(_tree(tmp_path / "fl", {"pubspec.yaml": flutter, "android/build.gradle": ""})) == ["android"]
    assert detect_platforms(_tree(tmp_path / "fl2", {"pubspec.yaml": flutter})) == ["ios", "android"]
    rn = '{"dependencies": {"react-native": "0.74.0"}}'
    assert detect_platforms(_tree(tmp_path / "rn", {"package.json": rn, "ios/Podfile": "", "android/build.gradle": ""})) == ["ios", "android"]
    assert detect_platforms(_tree(tmp_path / "expo", {"package.json": '{"dependencies": {"expo": "51.0.0"}}'})) == ["ios", "android"]
    expo_web = '{"dependencies": {"expo": "51.0.0", "react-native-web": "0.19.0", "react-dom": "18.2.0"}}'
    assert detect_platforms(_tree(tmp_path / "expo-web", {"package.json": expo_web})) == ["ios", "android", "web"]
    vite = '{"dependencies": {"react-dom": "18.3.0", "react-router-dom": "6.26.0", "vite": "5.4.0"}}'
    assert detect_platforms(_tree(tmp_path / "spa", {"package.json": vite})) == ["web"]
