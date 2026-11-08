"""Ways into a native app read from its code (`orcha_cli.qa.codemap.code_links`, ported from
the original `tests/unit/app_map/test_app_map_code_links.py`): iOS URL
schemes (sign-in callback schemes left out), associated domains, SwiftUI URL handlers and the
routers and parsers they call, links the app's own code spells; Android manifest intent filters,
Compose `navDeepLink`, launcher shortcuts and the destination a shortcut's extra navigates to;
`match_screen`, `fill`; and the import payload carrying links on screens."""

from __future__ import annotations

from pathlib import Path

import pytest

from orcha_cli.qa.codemap import code, code_links
from orcha_cli.qa.codemap.payload import payload_from_facts
from orcha_cli.qa.codemap.code_links import CodeLink, fill, is_concrete, match_screen, params

PLIST = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleURLTypes</key>
  <array>
    <dict><key>CFBundleURLSchemes</key><array><string>{scheme}</string></array></dict>
    <dict><key>CFBundleURLSchemes</key><array><string>com.googleusercontent.apps.1234-abcd</string><string>fb123456</string></array></dict>
  </array>
</dict>
</plist>
"""

ENTITLEMENTS = """<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>com.apple.developer.associated-domains</key>
  <array>
    <string>applinks:{host}</string>
    <string>appclips:{host}</string>
    <string>webcredentials:{host}</string>
  </array>
</dict>
</plist>
"""


def _tree(root: Path, files: dict[str, str]) -> Path:
    for rel, text in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
    return root


def _uris(links: list[CodeLink], platform: str | None = None) -> dict[str, CodeLink]:
    return {link.uri or f"intent:{link.action}:{dict(link.extras)}": link for link in links if platform is None or link.platform == platform}


# ---------- iOS ----------


def test_ios_onopenurl_switch_gives_a_link_per_branch_with_its_screen(tmp_path):
    root = _tree(tmp_path, {
        "Tally/Info.plist": PLIST.format(scheme="tally"),
        "Tally/TallyApp.swift": """
import SwiftUI
@main struct TallyApp: App {
    @State private var route: Route?
    var body: some Scene {
        WindowGroup {
            ContentView()
                .onOpenURL { url in
                    switch url.host {
                    case "settings":
                        route = .settings
                        SettingsView()
                    case "history", "log":
                        HistoryView()
                    default:
                        break
                    }
                }
        }
    }
}
""",
    })
    links = code_links.extract(root)
    by = _uris(links)
    assert by["tally://settings"].screen_key == "settings"
    assert by["tally://settings"].kind == "scheme" and by["tally://settings"].platform == "ios"
    assert by["tally://history"].screen_key == "history"
    assert "tally://log" in by
    # Sign-in callback schemes only hand the URL to an SDK: never a way in.
    assert not any("googleusercontent" in (u or "") or (u or "").startswith("fb") for u in by)
    assert by["tally://settings"].path == "Tally/TallyApp.swift" and by["tally://settings"].line > 1


def test_ios_router_and_url_parser_are_followed_and_the_apps_own_link_wins(tmp_path):
    """Nyumbani's shape: `.onOpenURL` -> `router.handleUniversalLink(url)` -> `DeepLink(url:)`,
    which looks for "property-details"; a widget spells the link with a real locale."""
    root = _tree(tmp_path, {
        "Homes/Resources/Info.plist": PLIST.format(scheme="com.googleusercontent.apps.99-xyz"),
        "Homes/Resources/Homes.entitlements": ENTITLEMENTS.format(host="homes.example.com"),
        "Homes/App/HomesApp.swift": """
import SwiftUI
@main struct HomesApp: App {
    let router = Router()
    var body: some Scene {
        WindowGroup {
            RootView()
                // Universal Links: a shared listing (https://homes.example.com/{lang}/listing-details/{slug})
                .onOpenURL { url in
                    if !router.handleUniversalLink(url) { GIDSignIn.sharedInstance.handle(url) }
                }
        }
    }
}
""",
        "Homes/App/Router.swift": """
final class Router {
    func handleUniversalLink(_ url: URL) -> Bool {
        guard let link = DeepLink(url: url) else { return false }
        resolve(link)
        return true
    }
    private func resolve(_ link: DeepLink) { }
}
""",
        "Homes/Core/DeepLink.swift": """
enum DeepLink {
    case listing(slug: String)
    init?(url: URL) {
        guard let host = url.host(), host == "homes.example.com" else { return nil }
        let segments = url.pathComponents.filter { $0 != "/" }
        guard let marker = segments.firstIndex(of: "listing-details"), segments.indices.contains(marker + 1) else { return nil }
        self = .listing(slug: segments[marker + 1])
    }
}
""",
        "Homes/Core/Badge.swift": """
enum Badge {
    static func resolve(status: String) -> Badge { if status == "success" { return .ok }; return .no }
}
""",
        "HomesWidgets/SavedWidget.swift": """
struct SavedWidget {
    static func link(for listing: Listing) -> URL {
        URL(string: "https://homes.example.com/en/listing-details/\\(listing.slug)?share=true")!
    }
}
""",
        "HomesTests/DeepLinkTests.swift": 'let u = URL(string: "https://homes.example.com/en/listing-details/fixture-slug")!',
    })
    links = code_links.extract(root, screens={"listing-detail": "ListingDetail", "settings": "Settings"})
    ios = [link for link in links if link.platform == "ios"]
    uris = [link.uri for link in ios]
    # The widget's link (code, a real locale) beats the comment's `{lang}` template; tests are fixtures.
    assert "https://homes.example.com/en/listing-details/{slug}" in uris
    assert not any("fixture-slug" in (u or "") for u in uris)
    assert not any("{lang}" in (u or "") for u in uris)
    link = next(x for x in ios if x.uri == "https://homes.example.com/en/listing-details/{slug}")
    assert link.kind == "universal" and link.screen_key == "listing-detail" and link.label == "listing-details"
    # A comparison that is not about the URL ("success") is no path word; the OAuth scheme is out.
    assert not any("success" in (u or "") for u in uris)
    assert not any((u or "").startswith("com.googleusercontent") for u in uris)


def test_ios_generated_links_on_every_host_when_the_code_spells_none(tmp_path):
    root = _tree(tmp_path, {
        "App/Info.plist": PLIST.format(scheme="shop"),
        "App/App.entitlements": ENTITLEMENTS.format(host="shop.example.com"),
        "App/ShopApp.swift": """
struct ShopApp: App {
    var body: some Scene {
        WindowGroup { Home().onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
            guard let url = activity.webpageURL else { return }
            if url.path.hasPrefix("/orders") { OrdersView() }
        } }
    }
}
""",
    })
    by = _uris(code_links.extract(root))
    assert by["https://shop.example.com/orders"].screen_key == "orders"
    assert by["shop:///orders"].kind == "scheme"


def test_ios_app_with_no_scheme_and_no_domain_declares_nothing(tmp_path):
    """Snug Log's iOS app: an App Intents app with no URL types and no associated domains."""
    root = _tree(tmp_path, {
        "SnugLog/Info.plist": PLIST.replace("<key>CFBundleURLTypes</key>", "<key>Unused</key>").format(scheme="x"),
        "SnugLog/SnugLog.entitlements": '<plist version="1.0"><dict><key>com.apple.developer.siri</key><true/></dict></plist>',
        "SnugLog/App.swift": "struct SnugLogApp: App { var body: some Scene { WindowGroup { ContentView() } } }",
        "fastlane/test_output/SnugLog.xcresult/Info.plist": PLIST.format(scheme="leaked"),
    })
    assert code_links.extract(root) == []


def test_ios_a_declared_scheme_with_no_handler_still_opens_the_app(tmp_path):
    root = _tree(tmp_path, {"Runner/Info.plist": PLIST.format(scheme="homes")})
    by = _uris(code_links.extract(root))
    assert list(by) == ["homes://"] and by["homes://"].screen_key is None


# ---------- Android ----------

MANIFEST = """<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <application android:label="Homes">
    <activity android:name=".MainActivity" android:exported="true">
      <intent-filter>
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />
        <data android:scheme="homes" android:host="homes.example.com"/>
      </intent-filter>
      <intent-filter android:autoVerify="true">
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.BROWSABLE" />
        <data android:scheme="https" android:host="homes.example.com" android:pathPrefix="/en/property-details"/>
        <data android:scheme="https" android:host="homes.example.com" android:pathPrefix="/en/project-details"/>
      </intent-filter>
      <intent-filter>
        <action android:name="android.intent.action.MAIN"/>
        <category android:name="android.intent.category.LAUNCHER"/>
      </intent-filter>
    </activity>
    <activity android:name=".SettingsActivity" android:exported="true">
      <intent-filter>
        <action android:name="android.intent.action.VIEW" />
        <data android:scheme="homes" android:host="settings" />
      </intent-filter>
    </activity>
  </application>
</manifest>
"""


def test_android_manifest_filters_become_links_with_component_and_kind(tmp_path):
    root = _tree(tmp_path, {
        "android/app/src/main/AndroidManifest.xml": MANIFEST,
        "android/app/build.gradle": 'android {\n  namespace "com.homes.app"\n  defaultConfig { applicationId "com.homes.app.prod" }\n}\n',
        "android/app/src/debug/AndroidManifest.xml": MANIFEST,  # a flavour repeats it: one link each
    })
    links = code_links.extract(root, screens={"/property-details/*": "Property details", "project-detail": "ProjectDetail"})
    by = _uris(links, "android")
    assert by["homes://homes.example.com"].kind == "scheme"
    assert by["homes://homes.example.com"].component == "com.homes.app.prod/com.homes.app.MainActivity"
    prop = by["https://homes.example.com/en/property-details/{id}"]
    assert prop.kind == "app_link" and prop.screen_key == "/property-details/*" and prop.line > 1
    assert by["https://homes.example.com/en/project-details/{id}"].screen_key == "project-detail"
    # Not the launcher activity, and not the only one: the activity is its screen.
    assert by["homes://settings"].screen_key == "settings"
    assert len([link for link in links if link.uri == "homes://homes.example.com"]) == 1


def test_android_compose_nav_deep_links_name_their_destination(tmp_path):
    root = _tree(tmp_path, {
        "app/src/main/java/com/tally/Routes.kt": """
const val BASE_URI = "tally://app"
sealed class Screen(val route: String) {
    object Detail : Screen("detail/{id}")
    object Home : Screen("home")
}
""",
        "app/src/main/java/com/tally/NavHost.kt": """
@Composable fun AppNav(nav: NavHostController) {
    NavHost(nav, startDestination = Screen.Home.route) {
        composable(Screen.Home.route) { HomeScreen() }
        composable(
            route = Screen.Detail.route,
            deepLinks = listOf(navDeepLink { uriPattern = "$BASE_URI/detail/{id}" }),
        ) { DetailScreen() }
        composable("settings", deepLinks = listOf(navDeepLink { uriPattern = "https://tally.example.com/settings" })) { SettingsScreen() }
        composable<Profile>(deepLinks = listOf(navDeepLink<Profile>(basePath = "tally://app/profile"))) { ProfileScreen() }
    }
}
""",
    })
    by = _uris(code_links.extract(root), "android")
    assert by["tally://app/detail/{id}"].screen_key == "/detail/*"
    assert by["tally://app/detail/{id}"].kind == "scheme"
    assert by["https://tally.example.com/settings"].screen_key == "/settings"
    assert by["https://tally.example.com/settings"].kind == "app_link"
    assert by["tally://app/profile"].screen_key == "profile"


def test_android_shortcuts_are_intent_ways_in_to_the_screen_their_extra_opens(tmp_path):
    """Snug Log's shape: static shortcuts with an action and an `event_type` extra; MainActivity
    hands the extra to `navigate(Screen.LogEntry.createRoute(shortcutEventType))`."""
    root = _tree(tmp_path, {
        "app/src/main/res/xml/shortcuts.xml": """<?xml version="1.0" encoding="utf-8"?>
<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">
  <shortcut android:shortcutId="log_feeding" android:shortcutShortLabel="@string/shortcut_feeding_short">
    <intent android:action="com.tally.ACTION_LOG_EVENT" android:targetPackage="com.tally" android:targetClass="com.tally.MainActivity">
      <extra android:name="event_type" android:value="feeding" />
    </intent>
  </shortcut>
  <shortcut android:shortcutId="log_sleep" android:shortcutShortLabel="Log sleep">
    <intent android:action="com.tally.ACTION_LOG_EVENT" android:targetPackage="com.tally" android:targetClass="com.tally.MainActivity">
      <extra android:name="event_type" android:value="sleep" />
    </intent>
  </shortcut>
</shortcuts>""",
        "app/src/main/res/values/strings.xml": '<resources><string name="shortcut_feeding_short">Log Feeding</string></resources>',
        "app/src/main/java/com/tally/Nav.kt": """
sealed class Screen(val route: String) {
    data object LogEntry : Screen("log_entry/{eventType}?eventId={eventId}")
}
@Composable fun MainScreen(shortcutEventType: String?) {
    LaunchedEffect(shortcutEventType) {
        if (shortcutEventType != null) { navController.navigate(Screen.LogEntry.createRoute(shortcutEventType)) }
    }
}
""",
    })
    links = code_links.extract(root)
    intents = [link for link in links if link.kind == "intent"]
    assert [(i.label, dict(i.extras)) for i in intents] == [("Log Feeding", {"event_type": "feeding"}), ("Log sleep", {"event_type": "sleep"})]
    first = intents[0]
    assert first.action == "com.tally.ACTION_LOG_EVENT" and first.component == "com.tally/com.tally.MainActivity"
    assert first.uri is None and first.screen_key == "/log_entry/*"
    assert first.public() == {"uri": None, "kind": "intent", "action": "com.tally.ACTION_LOG_EVENT",
                              "component": "com.tally/com.tally.MainActivity", "extras": {"event_type": "feeding"}, "label": "Log Feeding"}


def test_an_unreadable_manifest_or_plist_is_skipped(tmp_path):
    root = _tree(tmp_path, {
        "a/src/main/AndroidManifest.xml": "<manifest><application><activity",
        "b/Info.plist": "<plist><dict><key>CFBundleURLTypes",
    })
    assert code_links.extract(root) == []
    assert code_links.extract(tmp_path / "missing") == []


# ---------- helpers ----------


@pytest.mark.parametrize(
    ("uri", "screens", "want"),
    [
        ("https://nyumbaniconnect.com/{lang}/property-details/{slug}", {"property-detail": "PropertyDetail", "property-list": "PropertyList"}, "property-detail"),
        ("https://nyumbaniconnect.com/en/property-details/{id}", ["/property-details/*", "/properties", "/property-details/*/edit"], "/property-details/*"),
        ("myapp://settings", {"settings": "Settings", "home": "Home"}, "settings"),
        ("myapp:///orders/{id}", {"order-detail": "OrderDetail", "orders": "Orders"}, "order-detail"),
        ("https://x.example.com/en/", {"home": "Home"}, None),
        ("https://x.example.com/zebra-crossing", {"home": "Home"}, None),
    ],
)
def test_match_screen(uri, screens, want):
    assert match_screen(uri, screens) == want


def test_fill_and_params():
    t = "https://x.example.com/{lang}/listing-details/{slug}"
    assert params(t) == ["lang", "slug"]
    assert fill(t, {"slug": "cozy-flat"}) == "https://x.example.com/en/listing-details/cozy-flat"
    assert fill(t, {"slug": "cozy-flat", "lang": "sw"}) == "https://x.example.com/sw/listing-details/cozy-flat"
    assert fill(t, {}) is None
    assert fill(t, {"slug": "a"}, locale="fr") == "https://x.example.com/fr/listing-details/a"
    assert fill(None) is None
    assert is_concrete("myapp://settings") and not is_concrete(t) and not is_concrete(None)


# ---------- the map ----------


def test_code_extract_and_build_carry_links_on_screens(tmp_path):
    root = _tree(tmp_path, {
        "ios/Tally/Info.plist": PLIST.format(scheme="tally"),
        "ios/Tally/TallyApp.swift": """
import SwiftUI
@main struct TallyApp: App {
    var body: some Scene {
        WindowGroup {
            TabView { SettingsView().tabItem { Text("Settings") } }
                .onOpenURL { url in if url.host == "settings" { SettingsView() } }
        }
    }
}
""",
        "ios/Tally/SettingsView.swift": "import SwiftUI\nstruct SettingsView: View { var body: some View { Text(\"Settings\") } }\n",
    })
    facts = code.extract(root)
    assert any(link.uri == "tally://settings" and link.screen_key == "settings" for link in facts.links)
    node = next(n for n in payload_from_facts(facts, "ios")["nodes"] if (n["kind"], n["key"]) == ("screen", "settings"))
    assert {"uri": "tally://settings", "kind": "scheme", "label": "settings"} in node["detail"]["links"]
    # An iOS link never lands on the Android payload.
    assert not any(n["detail"].get("links") for n in payload_from_facts(facts, "android")["nodes"])
