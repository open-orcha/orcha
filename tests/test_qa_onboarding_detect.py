"""QA onboarding's detection (orcha_cli/qa/onboarding, a port of the original onboarding_map, repolib,
folder_scan and test_import): fixture repos built here, so what the "We found" sheet says about
apps, ids, URLs, tests, CI and backends is pinned without a real project."""
import ast
import json
import pathlib
import subprocess

import pytest

from orcha_cli.qa import onboarding
from orcha_cli.qa.onboarding import backends, ci, folder_scan, found, repolib, risk, tests_scan

PACKAGE = pathlib.Path(onboarding.__file__).parent


def write(root, files):
    for rel, text in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text if isinstance(text, str) else json.dumps(text))


PBX = """
PRODUCT_BUNDLE_IDENTIFIER = com.acme.shop;
PRODUCT_BUNDLE_IDENTIFIER = com.acme.shop.widgets;
PRODUCT_BUNDLE_IDENTIFIER = com.acme.shopUITests;
PRODUCT_BUNDLE_IDENTIFIER = "com.acme.shop.$(SUFFIX)";
productType = "com.apple.product-type.application";
"""
PLAYWRIGHT_UI = """import { test, expect } from '@playwright/test';
test('signs in', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByText('Welcome')).toBeVisible();
});
test.skip('later', async ({ page }) => { await page.goto('/x'); });
"""
PLAYWRIGHT_API = """import { test, expect } from '@playwright/test';
test('health', async ({ request }) => {
  const r = await request.get('/api/health');
  expect(r.status()).toBe(200);
});
test('pdf', async ({ page }) => {
  const r = await page.request.get('/api/export');
  expect(r.status()).toBe(200);
});
"""
XCUI = """import XCTest
final class CartUITests: XCTestCase {
    func testCheckoutShowsTotal() {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.staticTexts["Your cart"].exists)
    }
    func testOwnScreens() {
        let cart = CartScreen(app: app)
        cart.assertVisible()
    }
    func testUnit() {
        XCTAssertEqual(1 + 1, 2)
    }
}
"""


@pytest.fixture
def monorepo(tmp_path):
    root = tmp_path / "shop"
    write(root, {
        "apps/mobile/package.json": {"name": "mobile", "dependencies": {"expo": "1", "react-native": "1"}},
        "apps/mobile/app.json": {"expo": {"name": "Shop", "ios": {"bundleIdentifier": "com.acme.shop"},
                                          "android": {"package": "com.acme.shop.app"}}},
        "apps/mobile/.env.development": "EXPO_PUBLIC_API_URL=http://localhost:8000\n",
        "apps/mobile/.env.production": "EXPO_PUBLIC_API_URL=https://user:hunter2@api.acme.com/v1?key=secret\n",
        "apps/mobile/src/pay.ts": 'export const apiBase = "https://api.stripe.com/v1";\n',
        "apps/web/package.json": {"name": "web", "private": True, "dependencies": {"next": "1"},
                                  "scripts": {"dev": "next dev -p 4100"}},
        "apps/web/.env": "NEXT_PUBLIC_API_URL=https://staging.acme.com\n",
        "apps/web/e2e/login.spec.ts": PLAYWRIGHT_UI,
        "apps/web/e2e/health.spec.ts": PLAYWRIGHT_API,
        "apps/api/artisan": "#!/usr/bin/env php\n",
        "apps/api/composer.json": {"require": {"laravel/framework": "11"}},
        "apps/api/package.json": {"private": True, "devDependencies": {"vite": "1"}, "scripts": {"dev": "vite"}},
        "apps/mobile/maestro/login.yaml": "appId: com.acme.shop\n---\n- launchApp\n- tapOn: Login\n- runFlow: sub.yaml\n",
        "apps/mobile/maestro/sub.yaml": "appId: com.acme.shop\n---\n- tapOn: Next\n",
        "examples/demo/package.json": {"name": "demo", "private": True, "dependencies": {"vite": "1"},
                                       "scripts": {"dev": "vite"}},
        ".github/workflows/ci.yml": "jobs:\n  e2e:\n    steps:\n      - run: pnpm playwright test\n    env:\n      BASE_URL: http://localhost:${PORT}\n",
        ".github/workflows/e2e.yml": "jobs:\n  e2e:\n    steps:\n      - run: npx playwright test\n    env:\n      BASE_URL: https://preview.acme.com\n",
    })
    subprocess.run(["git", "-C", str(root), "init", "-q"], check=True)
    subprocess.run(["git", "-C", str(root), "add", "."], check=True)
    write(root, {"web-back/package.json": {"name": "old", "private": True, "dependencies": {"next": "1"},
                                           "scripts": {"dev": "next dev"}}})  # a leftover copy git does not track
    return root


def test_a_monorepo_sheet(monorepo):
    sheet = found.read_folder(monorepo)
    assert sheet["repo"] == {"path": str(monorepo), "name": "shop"}
    by = {p["kind"]: p for p in sheet["platforms"]}
    assert list(by) == ["ios", "android", "web"]
    assert by["ios"]["app_id"] == "com.acme.shop" and by["ios"]["stack"] == "React Native (Expo)"
    assert by["ios"]["path"] == "apps/mobile" and by["android"]["app_id"] == "com.acme.shop.app"
    # the tracked frontend, not the backend beside it, the untracked copy or the sample
    assert by["web"]["path"] == "apps/web" and by["web"]["app_id"] == "http://localhost:4100"
    assert {"path": "apps/web", "stack": "Next.js"}.items() <= next(a for a in sheet["apps"] if a["path"] == "apps/web").items()
    assert next(a for a in sheet["apps"] if a["path"] == "web-back")["tracked"] is False
    assert next(a for a in sheet["apps"] if a["path"] == "examples/demo")["sample"] is True
    # the API tests and the skipped-name duplicate logic: UI tests only; a Maestro subflow is no test
    tests = {t["framework"]: t for t in sheet["tests"]}
    assert tests["playwright"] == {"framework": "playwright", "count": 2, "path": "apps/web/e2e"}
    assert tests["maestro"]["count"] == 1
    assert sheet["ci"] == [{"provider": "GitHub Actions", "path": ".github/workflows/ci.yml"},
                           {"provider": "GitHub Actions", "path": ".github/workflows/e2e.yml"}]
    # a URL still holding a ${variable} is no environment
    assert sheet["environments"] == [{"name": "Local", "base_url": "http://localhost:4100"},
                                     {"name": "CI", "base_url": "https://preview.acme.com"}]
    assert sheet["defaults"] == {"device": "A simulator", "test_data": "Each test starts on a fresh install"}


def test_backends_strip_credentials_and_ignore_payment_providers(monorepo):
    sheet = found.read_folder(monorepo)
    urls = {(tuple(b["platforms"]), b["url"], b["build"], b["production"]) for b in sheet["backends"]}
    assert (("ios", "android"), "http://localhost:8000", "checkout", False) in urls
    assert (("ios", "android"), "https://api.acme.com/v1", "release", True) in urls
    assert (("web",), "https://staging.acme.com", "any", False) in urls or \
        (("web",), "https://staging.acme.com", "checkout", False) in urls
    text = json.dumps(sheet)
    assert "hunter2" not in text and "secret" not in text and "api.stripe.com" not in text


def test_native_repo_ids(tmp_path):
    root = tmp_path / "native"
    write(root, {
        "Shop-iOS/Shop.xcodeproj/project.pbxproj": PBX,
        "Shop-macOS/ShopMac.xcodeproj/project.pbxproj": 'PRODUCT_BUNDLE_IDENTIFIER = com.acme;\nproductType = "com.apple.product-type.application";\n',
        "android/build.gradle.kts": "// root\n",
        "android/app/build.gradle.kts": 'plugins { id("com.android.application") }\nandroid { defaultConfig { applicationId = "com.acme.shop.android" } }\n',
        "android/settings.gradle.kts": "",
        "ShopUITests/CartUITests.swift": XCUI,
    })
    sheet = found.read_folder(root)
    by = {p["kind"]: p for p in sheet["platforms"]}
    assert by["ios"]["app_id"] == "com.acme.shop" and by["ios"]["path"] == "Shop-iOS"
    assert by["android"]["app_id"] == "com.acme.shop.android" and by["android"]["stack"] == "Native Android"
    assert "web" not in by
    assert sheet["tests"] == [{"framework": "xcuitest", "count": 2, "path": "ShopUITests"}]
    assert sheet["backend_unknown"]["ios"] == "No backend address in its code or config"


def test_xcodegen_flutter_and_what_is_no_app(tmp_path):
    write(tmp_path, {
        "ios/project.yml": "name: Shop\noptions:\n  bundleIdPrefix: com.acme\ntargets:\n  Shop:\n    type: application\n    platform: iOS\n  ShopTests:\n    type: bundle.unit-test\n    platform: iOS\n",
        "mobile/pubspec.yaml": "name: shop\ndependencies:\n  flutter:\n    sdk: flutter\n",
        "mobile/lib/main.dart": "void main() {}\n",
        "packages/ui/package.json": {"name": "ui", "main": "index.js", "dependencies": {"react-native": "1"}},
        "packages/plugin/pubspec.yaml": "name: p\ndependencies:\n  flutter:\n    sdk: flutter\nflutter:\n  plugin:\n    platforms: {}\n",
        "desk/package.json": {"name": "desk", "private": True, "dependencies": {"electron": "1", "vite": "1"}},
    })
    apps = {a.path: a for a in repolib.app_dirs(tmp_path)}
    assert apps["ios"].bundle_id == "com.acme.Shop" and apps["ios"].stack == "Native iOS"
    assert apps["mobile"].kinds == ["mobile"] and apps["mobile"].stack == "Flutter"
    assert apps["desk"].kinds == ["desktop"]  # never mistaken for a Vite site
    assert "packages/ui" not in apps and "packages/plugin" not in apps


def test_symlinks_stay_inside(tmp_path):
    outside = tmp_path / "outside"
    write(outside, {"package.json": {"private": True, "dependencies": {"next": "1"}}})
    root = tmp_path / "repo"
    write(root, {"README.md": "x"})
    (root / "linked").symlink_to(outside, target_is_directory=True)
    assert found.read_folder(root)["platforms"] == []


def test_folder_scan_finds_projects_and_extras(tmp_path):
    write(tmp_path, {
        "a/package.json": {"private": True, "dependencies": {"next": "1"}},
        "group/b/manage.py": "",
        "group/b/requirements.txt": "django==5\n",
        "c/Package.swift": 'platforms: [.iOS(.v17)], targets: [.executableTarget(name: "c")]',
        "node_modules/x/package.json": {"dependencies": {"next": "1"}},
    })
    got = folder_scan.scan_folder(tmp_path)
    assert got["root_is_project"] is False
    names = {p["rel_path"]: p for p in got["projects"]}
    assert set(names) == {"a", "group/b", "c"}
    assert names["group/b"]["stacks"] == ["Django"] and names["group/b"]["urls"] == ["http://localhost:8000"]
    assert names["c"]["platforms"] == ["ios"]


@pytest.mark.parametrize("framework,body,yes", [
    ("playwright", "await page.goto('/'); await expect(page.getByRole('button')).toBeVisible();", True),
    ("playwright", "await loginPage.open();", True),
    ("playwright", "const r = await request.get('/x'); expect(r.ok()).toBeTruthy();", False),
    ("playwright", "const r = await page.request.get('/x');", False),
    ("playwright", "", False),
    ("cypress", "cy.visit('/'); cy.contains('Hi');", True),
    ("cypress", "cy.request('/x');", False),
    ("detox", "await element(by.id('x')).tap();", True),
    ("espresso", 'onView(withText("Hi")).check(matches(isDisplayed()))', True),
    ("espresso", "assertEquals(1, 1)", False),
    ("xcuitest", 'app.buttons["Save"].tap()', True),
    ("xcuitest", "XCTAssertEqual(1, 1)", False),
    ("xcuitest", 'let s = XCUIScreen.main.screenshot(); add(XCTAttachment(screenshot: s)); XCUIApplication().launch()', False),
    ("maestro", "- launchApp\n", True),
    ("gherkin", "Given a thing\n", True),
    ("jest", "expect(page.title).toBe('x')", False),
])
def test_has_screens(framework, body, yes):
    assert tests_scan.has_screens(tests_scan.SourceTest("p", "n", 1, framework, body)) is yes


def test_scan_reads_describe_each_and_gherkin(tmp_path):
    write(tmp_path, {
        "e2e/a.spec.ts": """import { test } from '@playwright/test';
test.describe('Cart', () => {
  test.each([1, 2])('adds %s', async ({ page }) => { await page.goto('/'); });
  test('empties', async ({ page }) => { await page.click('x'); });
});
""",
        "features/pay.feature": "Feature: Pay\n  Scenario: Card\n    Given a cart\n  Scenario Outline: Other\n    Given <x>\n",
        "node_modules/z/a.spec.ts": "test('no', () => {})",
    })
    inv = tests_scan.scan(tmp_path)
    names = sorted((t.framework, t.name) for t in inv.tests)
    assert names == [("gherkin", "Card"), ("gherkin", "Other"), ("playwright", "Cart > adds %s"), ("playwright", "Cart > empties")]


def test_ci_proposal_names_secrets_never_their_values(tmp_path):
    write(tmp_path, {".github/workflows/e2e.yml": """jobs:
  e2e:
    env:
      API_TOKEN: ${{ secrets.TOKEN }}
      REGION: eu
    steps:
      - run: pnpm dev &
      - run: npx playwright test
"""})
    got = ci.propose(tmp_path)
    assert got["secrets"] == ["API_TOKEN"] and got["env"] == ["REGION"]
    assert got["serve"] == "pnpm dev" and got["platforms"] == ["web"]
    assert "secrets.TOKEN" not in json.dumps(got)


def test_risk_ranks_money_above_a_plain_screen():
    nodes = [
        {"id": "1", "kind": "screen", "key": "checkout", "label": "Checkout", "detail": {"code": {"title": "Pay"}},
         "evidence": {"code": [{"path": "Checkout.swift", "line": 1}]}},
        {"id": "2", "kind": "screen", "key": "about", "label": "About", "detail": {}, "evidence": {}},
        {"id": "3", "kind": "endpoint", "key": "DELETE /api/cart", "label": "x", "detail": {"code": {"method": "DELETE"}},
         "evidence": {"code": [{"path": "Checkout.swift", "line": 9}]}},
    ]
    edges = [{"kind": "navigates", "from_node_id": "2", "to_node_id": "1"}]
    g = risk.Graph(nodes, edges)
    got = risk.rank(g, [nodes[0], nodes[1]])
    assert got["1"].score >= risk.CRITICAL and "Handles money" in got["1"].reasons[0]
    assert any(r.startswith("Deletes data: DELETE /api/cart") for r in got["1"].reasons)
    assert got["2"].score == risk.BASE and got["2"].reasons == ["Nothing in the code marks it as risky"]


def test_link_tests_says_why():
    screens = [{"id": "1", "kind": "screen", "key": "cart", "label": "Cart", "detail": {}},
               {"id": "2", "kind": "screen", "key": "/orders", "label": "Orders", "detail": {}},
               {"id": "3", "kind": "screen", "key": "settings", "label": "Settings",
                "detail": {"code": {"title": "Preferences"}}}]
    tests = [tests_scan.SourceTest("e2e/cart.spec.ts", "adds an item", 3, "playwright", "x"),
             tests_scan.SourceTest("e2e/a.spec.ts", "lists", 4, "playwright", "await page.goto('/orders')"),
             tests_scan.SourceTest("e2e/b.spec.ts", "edits", 5, "playwright", "getByText('Preferences')")]
    got = risk.link_tests(tests, screens)
    assert got["cart"][0]["evidence"] == "Its name says Cart"
    assert got["/orders"][0]["evidence"] == "It opens /orders"
    assert got["settings"][0] == {"framework": "playwright", "name": "edits", "path": "e2e/b.spec.ts", "line": 5,
                                  "evidence": 'It looks for "Preferences"'}


def test_a_missing_folder_is_a_sentence():
    with pytest.raises(FileNotFoundError, match="no folder"):
        found.read_folder("/no/such/folder/here")


def test_backend_url_cleaning():
    assert backends.clean_url("https://u:p@x.test:8443/a/?k=1#f") == "https://x.test:8443/a"
    assert backends.clean_url("http://<your-ip>:54321") is None
    assert backends.clean_url("https://${HOST}/x") is None


def test_package_is_stdlib_only_and_offline():
    """It runs without the [qa] extra, and detection never touches the network."""
    allowed = {"__future__", "collections", "dataclasses", "ipaddress", "json", "os", "pathlib", "plistlib", "re",
               "subprocess", "sys", "time", "typing", "urllib", "orcha_cli"}
    for path in PACKAGE.glob("*.py"):
        tree = ast.parse(path.read_text())
        assert ast.get_docstring(tree), path.name
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom):
                names = [node.module or ""]
            else:
                continue
            for name in names:
                assert name.split(".")[0] in allowed, f"{path.name} imports {name}"
                assert name != "urllib.request", path.name
        assert "from __future__ import annotations" in path.read_text() or path.name == "__init__.py", path.name
