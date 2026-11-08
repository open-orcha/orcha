"""The code scanner behind the QA map's features (`orcha_cli.qa.codemap.features`, ported from
the original `tests/unit/core/test_feature_map.py`): framework detection on small fixture trees and
name normalisation, plus React Router (Orcha's addition)."""

from __future__ import annotations

from pathlib import Path

import pytest

from orcha_cli.qa.codemap import features as fm

def _tree(root: Path, files: dict[str, str]) -> Path:
    for rel, text in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
    return root


def _by_key(result: fm.ScanResult) -> dict[str, fm.Feature]:
    return {f.key: f for f in result.features}


# ---------- names ----------


@pytest.mark.parametrize(
    ("raw", "key"),
    [
        ("expenses", "expenses"),
        ("add-expense", "expense"),
        ("AddExpenseScreen", "expense"),
        ("ExpenseDetailView", "expense"),
        ("ExpensesListViewController", "expenses"),
        ("edit-trip", "trip"),
        ("record-remittance", "remittance"),
        ("login", "sign-in"),
        ("forgot-password", "sign-in"),
        ("SignUp", "sign-in"),
        ("privacy-policy", "legal"),
        ("index", "home"),
        ("HomeScreen", "home"),
        ("monthly_review", "monthly-review"),
        ("Bulk M-Pesa", "bulk-m-pesa"),
    ],
)
def test_feature_key_normalises_screen_names(raw, key):
    assert fm.feature_key(raw) == key


def test_feature_name_is_human():
    assert fm.feature_name("monthly-review") == "Monthly review"
    assert fm.feature_name("sign-in") == "Sign in"
    assert fm.feature_name("home") == "Home"


def test_plurals_merge_into_the_plural_form():
    mapping = fm._merge_plurals(["expense", "expenses", "category", "categories", "trip", "status"])
    assert mapping["expense"] == "expenses"
    assert mapping["category"] == "categories"
    assert mapping["trip"] == "trip"  # no plural present: kept
    assert mapping["status"] == "status"


def test_summary_lists_screen_kinds():
    assert fm._summary(["list", "detail", "new"]) == "3 screens: list, detail, new"
    assert fm._summary(["overview"]) == "1 screen"
    assert fm._summary(["detail", "list", "detail"]) == "3 screens: list, detail"


# ---------- frameworks ----------


def test_react_router_route_objects_and_elements_nest_their_paths(tmp_path):
    root = _tree(tmp_path, {
        "web/package.json": '{"dependencies": {"react-dom": "18.3.0", "react-router-dom": "6.26.0"}}',
        "web/src/router.tsx": """import { createBrowserRouter } from "react-router-dom";
export const router = createBrowserRouter([
  { path: "/", element: <Layout />, children: [
    { index: true, element: <Home /> },
    { path: "trips", element: <Trips />, children: [{ path: ":tripId", element: <TripDetail /> }] },
    { path: "settings/profile", Component: Profile },
    { path: "*", element: <NotFound /> },
  ]},
]);
""",
        "web/src/App.tsx": """import { Routes, Route } from "react-router-dom";
export function Admin() {
  return (
    <Routes>
      <Route path="/admin" element={<AdminLayout />}>
        <Route path="users/:id/edit" element={<EditUser />} />
        <Route element={<Guard />}>
          <Route path="billing" element={<Billing />} />
        </Route>
      </Route>
    </Routes>
  );
}
""",
        "web/src/pages/Trips.tsx": "export function Trips() { return null }\n",
        "web/src/pages/TripDetail.tsx": "export function TripDetail() { return null }\n",
        "web/src/plain.ts": 'const config = { path: "/not-a-route", element: 1 };\n',
    })
    found = fm.scan_screens(root)
    routes = {s.entry: s for s in found.screens}
    assert set(routes) == {"/", "/trips", "/trips/[tripId]", "/settings/profile", "/admin", "/admin/users/[id]/edit", "/admin/billing"}
    assert {s.platform for s in found.screens} == {"react-router"}
    assert routes["/trips/[tripId]"].kind == "detail" and routes["/admin/users/[id]/edit"].kind == "edit"
    assert routes["/trips"].path == "web/src/pages/Trips.tsx"  # the component's file, when the repo has it
    assert (routes["/trips"].file, routes["/trips"].line) == ("web/src/router.tsx", 5)
    features = _by_key(fm.scan(root))
    assert {"trips", "settings", "admin"} <= set(features)
    assert features["trips"].entry == "/trips"


def test_next_app_router_groups_by_first_meaningful_segment(tmp_path):
    root = _tree(tmp_path, {
        "package.json": '{"dependencies": {"next": "16"}}',
        "src/app/layout.tsx": "",
        "src/app/(app)/page.tsx": "",
        "src/app/(app)/expenses/page.tsx": "",
        "src/app/(app)/expenses/[id]/page.tsx": "",
        "src/app/(app)/expenses/new/page.tsx": "",
        "src/app/(app)/expenses/_components/row.tsx": "",
        "src/app/[locale]/(marketing)/pricing/page.tsx": "",
        "src/app/(auth)/login/page.tsx": "",
        "src/app/(auth)/register/page.tsx": "",
        "src/app/api/expenses/route.ts": "",
        "src/app/api/health/page.tsx": "",
        "src/app/@modal/settings/page.tsx": "",
        "src/app/[org]/team/page.tsx": "",
    })
    result = fm.scan(root)
    features = _by_key(result)
    assert "next" in result.frameworks
    assert set(features) == {"home", "expenses", "pricing", "sign-in", "settings", "team"}
    exp = features["expenses"]
    assert exp.name == "Expenses"
    assert exp.entry == "/expenses"
    assert exp.summary == "3 screens: list, detail, new"
    assert exp.paths == ["src/app/(app)/expenses"]
    assert features["pricing"].entry == "/pricing"  # [locale] and (marketing) dropped
    assert features["sign-in"].name == "Sign in"
    assert features["sign-in"].entry == "/login"
    assert features["team"].entry == "/[org]/team"
    assert features["home"].entry == "/"
    assert result.features[0].key == "home"  # Home first, then by name


def test_expo_router_and_plural_merge(tmp_path):
    root = _tree(tmp_path, {
        "app/_layout.tsx": "",
        "app/(tabs)/_layout.tsx": "",
        "app/(tabs)/index.tsx": "",
        "app/(tabs)/trips.tsx": "",
        "app/add-trip.tsx": "",
        "app/edit-trip/[id].tsx": "",
        "app/trip/[id].tsx": "",
        "app/+not-found.tsx": "",
        "app/__tests__/trips.test.tsx": "",
        "app/(auth)/sign-in.tsx": "",
    })
    result = fm.scan(root)
    features = _by_key(result)
    assert result.frameworks == ["expo"]
    assert set(features) == {"home", "trips", "sign-in"}
    trips = features["trips"]
    assert trips.entry == "/trips"
    assert trips.summary == "4 screens: list, detail, new, edit"
    assert "app/add-trip.tsx" in trips.paths and "app/trip" in trips.paths


def test_pages_router_needs_a_next_package(tmp_path):
    root = _tree(tmp_path, {
        "web/package.json": '{"dependencies": {"next": "13"}}',
        "web/pages/_app.tsx": "",
        "web/pages/index.tsx": "",
        "web/pages/orders/index.tsx": "",
        "web/pages/orders/[id].tsx": "",
        "web/pages/api/orders.ts": "",
        "web/pages/404.tsx": "",
        "vue/pages/cart.vue": "",
        "other/pages/cart.tsx": "",  # not a Next package
    })
    features = _by_key(fm.scan(root))
    assert set(features) == {"home", "orders"}
    assert features["orders"].summary == "2 screens: list, detail"


def test_react_navigation_screens(tmp_path):
    root = _tree(tmp_path, {
        "src/navigation/RootNavigator.tsx": (
            "import { createNativeStackNavigator } from '@react-navigation/native-stack';\n"
            '<Stack.Screen name="ExpenseList" component={ExpenseListScreen} />\n'
            "<Stack.Screen\n  name=\"AddExpense\"\n  component={AddExpenseScreen}\n/>\n"
            '<Tab.Screen name="Profile" component={ProfileScreen} options={{}} />\n'
        ),
        "src/screens/ExpenseListScreen.tsx": "",
        "src/screens/AddExpenseScreen.tsx": "",
        "src/routes.ts": "import x from '@react-navigation/native';\nconst screens = [{ name: 'Login', component: LoginScreen }];",
    })
    result = fm.scan(root)
    features = _by_key(result)
    assert "react-navigation" in result.frameworks
    assert set(features) == {"expense", "profile", "sign-in"}
    assert features["expense"].paths == ["src/screens/AddExpenseScreen.tsx", "src/screens/ExpenseListScreen.tsx"]
    assert features["expense"].summary == "2 screens: list, new"


def test_android_activities_and_compose_routes(tmp_path):
    root = _tree(tmp_path, {
        "app/src/main/AndroidManifest.xml": (
            '<manifest xmlns:android="x" package="com.acme.fleet">\n'
            '<application><activity android:name=".MainActivity"/>\n'
            '<activity android:name=".trucks.TrucksActivity"/>\n'
            '<activity android:name="com.yalantis.ucrop.UCropActivity"/></application></manifest>'
        ),
        "app/src/main/java/com/acme/fleet/trucks/TrucksActivity.kt": "class TrucksActivity",
        "app/src/main/java/com/acme/fleet/nav/NavGraph.kt": (
            'composable("drivers") { }\ncomposable(route = "drivers/{id}") { }\ncomposable<SettingsRoute> { }\n'
        ),
        "app/build/intermediates/AndroidManifest.xml": '<activity android:name=".GhostActivity"/>',
    })
    result = fm.scan(root)
    features = _by_key(result)
    assert {"android", "compose"} <= set(result.frameworks)
    assert set(features) == {"trucks", "drivers", "settings"}
    assert features["trucks"].paths == ["app/src/main/java/com/acme/fleet/trucks/TrucksActivity.kt"]
    assert features["drivers"].summary == "2 screens: overview, detail"
    assert features["drivers"].entry == "drivers"


def test_swiftui_views_group_by_feature_folder(tmp_path):
    root = _tree(tmp_path, {
        "Fleet/FleetApp.swift": "@main struct FleetApp: App {}",
        "Fleet/ContentView.swift": "struct ContentView: View {}",
        "Fleet/Features/Expenses/Views/ExpenseListView.swift": "struct ExpenseListView: View {}\nstruct RowView: View {}",
        "Fleet/Features/Expenses/Views/ExpenseDetailView.swift": "struct ExpenseDetailView: View {}",
        "Fleet/Features/Expenses/Edit/EditExpenseView.swift": "struct EditExpenseView: View {}",
        "Fleet/Features/Settings/SettingsView.swift": "struct SettingsView: View {}",
        "Fleet/Components/BadgeView.swift": "struct BadgeView: View {}",
        "Fleet/Legacy/OrdersViewController.swift": "class OrdersViewController: UIViewController {}",
        "FleetTests/ExpenseTests.swift": "struct FakeView: View {}",
    })
    result = fm.scan(root)
    features = _by_key(result)
    assert "swiftui" in result.frameworks and "uikit" in result.frameworks
    assert set(features) == {"expenses", "settings", "legacy"}
    exp = features["expenses"]
    assert exp.summary == "3 screens: list, detail, edit"
    assert exp.paths == ["Fleet/Features/Expenses"]
    assert exp.entry == "ExpenseListView"


def test_states_and_chrome_are_no_features_and_case_variants_are_one(tmp_path):
    """U10: the original's own repository listed "Boot", "Failed", "Port notice" and "Keyboard
    shortcuts" (its Mac app's views) as features."""
    root = _tree(tmp_path, {
        "Mac/MacApp.swift": "@main struct MacApp: App {}",
        "Mac/Sources/BootView.swift": "struct BootView: View {}",
        "Mac/Sources/FailedView.swift": "struct FailedView: View {}",
        "Mac/Sources/PortNoticeView.swift": "struct PortNoticeView: View {}",
        "Mac/Sources/KeyboardShortcutsView.swift": "struct KeyboardShortcutsView: View {}",
        "Mac/Sources/SplashScreenView.swift": "struct SplashScreenView: View {}",
        "Mac/Sources/ErrorView.swift": "struct ErrorView: View {}",
        "Mac/Sources/GitHubView.swift": "struct GitHubView: View {}",
        "Mac/Sources/Github/GithubSettingsView.swift": "struct GithubSettingsView: View {}",
        "Mac/Sources/Settings/SettingsView.swift": "struct SettingsView: View {}",
    })
    keys = set(_by_key(fm.scan(root)))
    assert keys == {"git-hub", "settings"} or keys == {"github", "settings"}
    assert fm.is_non_feature("port-notice") and fm.is_non_feature("keyboard-shortcuts") and fm.is_non_feature("boot")
    assert not fm.is_non_feature("notifications") and not fm.is_non_feature("settings")


def test_skips_dependencies_build_output_and_hidden_folders(tmp_path):
    root = _tree(tmp_path, {
        "app/_layout.tsx": "",
        "app/home.tsx": "",
        "node_modules/pkg/app/_layout.tsx": "",
        "node_modules/pkg/app/secret.tsx": "",
        ".worktrees/copy/app/_layout.tsx": "",
        ".worktrees/copy/app/ghost.tsx": "",
        ".next/server/app/ghost/page.js": "",
        "dist/app/ghost/page.js": "",
    })
    assert set(_by_key(fm.scan(root))) == {"home"}


def test_monorepo_apps_and_subdir(tmp_path):
    root = _tree(tmp_path, {
        "apps/web/package.json": '{"dependencies": {"next": "16"}}',
        "apps/web/src/app/expenses/page.tsx": "",
        "apps/mobile/app/_layout.tsx": "",
        "apps/mobile/app/expense/[id].tsx": "",
        "apps/mobile/app/payroll.tsx": "",
        "packages/ui/src/Button.tsx": "",
    })
    features = _by_key(fm.scan(root))
    assert set(features) == {"expenses", "payroll"}
    # Web and mobile screens of one feature are one feature; the web route is the entry.
    assert features["expenses"].entry == "/expenses"
    assert features["expenses"].paths == ["apps/mobile/app/expense", "apps/web/src/app/expenses"]
    only_web = _by_key(fm.scan(root, "apps/web/"))
    assert set(only_web) == {"expenses"}
    assert only_web["expenses"].paths == ["apps/web/src/app/expenses"]  # still relative to the repo


def test_file_cap_marks_the_scan_truncated(tmp_path, monkeypatch):
    _tree(tmp_path, {f"app/s{i}.tsx": "" for i in range(20)} | {"app/_layout.tsx": ""})
    monkeypatch.setattr(fm, "MAX_FILES", 5)
    result = fm.scan(tmp_path)
    assert result.truncated and result.files_seen == 5


def test_empty_or_unknown_repo_yields_nothing(tmp_path):
    _tree(tmp_path, {"README.md": "hi", "main.go": "package main"})
    result = fm.scan(tmp_path)
    assert result.features == [] and result.frameworks == []


def test_scan_is_deterministic(tmp_path):
    _tree(tmp_path, {"app/_layout.tsx": "", "app/b.tsx": "", "app/a.tsx": "", "app/add-a.tsx": ""})
    assert [f.as_dict() for f in fm.scan(tmp_path).features] == [f.as_dict() for f in fm.scan(tmp_path).features]
