"""A screen is what a person navigates to, on iOS as on Android (ported from the original's
`tests/unit/app_map/test_app_map_screens_467.py`, without the atlas and coverage cases).

- `code_swift`: a SwiftUI view is a screen when it is the app's root, a tab, or presented (a
  sheet, a cover, a pushed destination); a view that only composes one (a header, a timeline, an
  onboarding step switched in place) folds into it, and code the app never reaches presents nothing.
- Compose counts its nav graph's destinations (dialogs too) and the composable a bottom sheet
  shows, so one app's iOS and Android counts read alike.
- Each phone's import payload holds that phone's screens only.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from orcha_cli.qa.codemap import code
from orcha_cli.qa.codemap.payload import counts, payload_from_facts

# A baby log on iOS: the app's root chooses onboarding or the tabs; Today is a tab (through a
# wrapper), it composes a header and a timeline, presents quick notes as a sheet, pushes an
# event's detail and covers the screen with the voice overlay. Onboarding switches its steps in
# place. An old log view nothing reaches still presents a time picker.
SWIFT = {
    "Snug/SnugApp.swift": """import SwiftUI
@main
struct SnugApp: App {
    var body: some Scene {
        WindowGroup {
            Group {
                if isLoading { LoadingView() } else { RootView() }
            }
        }
    }
}
""",
    "Snug/Info.plist": "<plist/>",
    "Snug/Views/App/RootView.swift": """import SwiftUI
struct RootView: View {
    @State private var onboarded = false
    var body: some View {
        Group {
            if onboarded { MainTabView() } else { OnboardingView(onDone: { onboarded = true }) }
        }
        .task { await load() }
    }
}
struct LoadingView: View { var body: some View { ProgressView() } }
""",
    "Snug/Views/App/MainTabView.swift": """import SwiftUI
struct MainTabView: View {
    @State private var tab = AppTab.today
    var body: some View {
        TabView(selection: $tab) {
            Tab("Today", systemImage: "sun.max", value: .today) { TodayTabView() }
            Tab("Settings", systemImage: "gear", value: .settings) {
                NavigationStack { SettingsView() }
            }
        }
        .fullScreenCover(isPresented: $listening) { VoiceOverlayView() }
    }
}
struct TodayTabView: View {
    var body: some View { TodayView(babyName: "Amara") }
}
""",
    "Snug/Views/Today/TodayView.swift": """import SwiftUI
struct TodayView: View {
    let babyName: String
    @State private var noting = false
    var body: some View {
        NavigationStack {
            ScrollView {
                DashboardHeaderView(name: babyName)
                TimelineView(events: events)
                NavigationLink { EventDetailView() } label: { Text("Last feed") }
            }
            .sheet(isPresented: $noting) { QuickNotesSheet() }
        }
    }
}
""",
    "Snug/Views/Today/DashboardHeaderView.swift": """import SwiftUI
struct DashboardHeaderView: View {
    let name: String
    var body: some View { Text("Good morning, Amara") }
}
""",
    "Snug/Views/Today/TimelineView.swift": "import SwiftUI\nstruct TimelineView: View {\n    var body: some View { Text(\"Nothing logged today\") }\n}\n",
    "Snug/Views/Today/EventDetailView.swift": "import SwiftUI\nstruct EventDetailView: View {\n    var body: some View { Text(\"Feeding, left side\") }\n}\n",
    "Snug/Views/Today/QuickNotesSheet.swift": """import SwiftUI
struct QuickNotesSheet: View {
    var body: some View { Form { TextField("Quick notes", text: $note) }.navigationTitle("Quick notes") }
}
""",
    "Snug/Views/Voice/VoiceOverlayView.swift": "import SwiftUI\nstruct VoiceOverlayView: View {\n    var body: some View { Text(\"Listening\") }\n}\n",
    "Snug/Views/Settings/SettingsView.swift": "import SwiftUI\nstruct SettingsView: View {\n    var body: some View { Form { Text(\"Measurement units\") } }\n}\n",
    "Snug/Views/Onboarding/OnboardingView.swift": """import SwiftUI
struct OnboardingView: View {
    var onDone: () -> Void
    var body: some View {
        ZStack {
            Color.cream.ignoresSafeArea()
            switch step {
            case .name: BabyNameView()
            case .birthday: BabyBirthdayView()
            }
        }
    }
}
""",
    "Snug/Views/Onboarding/BabyNameView.swift": "import SwiftUI\nstruct BabyNameView: View {\n    var body: some View { TextField(\"Baby's name\", text: $name) }\n}\n",
    "Snug/Views/Onboarding/BabyBirthdayView.swift": "import SwiftUI\nstruct BabyBirthdayView: View {\n    var body: some View { DatePicker(\"Birthday\", selection: $day) }\n}\n",
    "Snug/Views/LogEntry/OldLogView.swift": """import SwiftUI
struct OldLogView: View {
    var body: some View { Text("Log").sheet(isPresented: $picking) { TimePickerSheet() } }
}
struct TimePickerSheet: View { var body: some View { DatePicker("Time", selection: $at) } }
#Preview { OldLogView() }
""",
    "Snug/Views/Debug/ScreenshotView.swift": """import SwiftUI
extension View {
    func screenshots() -> some View {
        #if DEBUG
        return self.fullScreenCover(isPresented: .constant(false)) { ScreenshotView() }
        #else
        return self
        #endif
    }
}
struct ScreenshotView: View { var body: some View { Text("App Store") } }
""",
}

# The same app on Android: a nav graph of destinations, a dialog, and a bottom sheet.
COMPOSE = {
    "android/app/build.gradle.kts": 'dependencies { implementation("androidx.compose.ui:ui:1.6.0") }\n',
    "android/app/src/main/java/com/snug/ui/NavHost.kt": """package com.snug.ui

@Composable
fun SnugNavHost(navController: NavHostController) {
    NavHost(navController, startDestination = "today") {
        composable("onboarding") { OnboardingScreen() }
        composable("today") { TodayScreen(onEvent = { navController.navigate("event_detail") }) }
        composable("event_detail") { EventDetailScreen() }
        composable("settings") { SettingsScreen() }
        composable("voice_overlay") { VoiceOverlayScreen() }
        dialog("delete_event") { DeleteEventDialog() }
    }
}
""",
    "android/app/src/main/java/com/snug/ui/TodayScreen.kt": """package com.snug.ui

@Composable
fun TodayScreen(onEvent: () -> Unit) {
    Column {
        Text("Good morning, Amara")
        Text("Quick notes")
    }
    if (adding) {
        ModalBottomSheet(onDismissRequest = { adding = false }) {
            AddEntrySheet(onPick = { adding = false })
        }
    }
    if (filtering) {
        ModalBottomSheet(onDismissRequest = { filtering = false }) {
            Column { Text("Feeds only") }
        }
    }
}

@Composable
fun AddEntrySheet(onPick: () -> Unit) { Text("What happened?") }
""",
    "android/app/src/main/java/com/snug/ui/Screens.kt": """package com.snug.ui

@Composable fun OnboardingScreen() { Text("Welcome") }
@Composable fun EventDetailScreen() { Text("Feeding, left side") }
@Composable fun SettingsScreen() { Text("Measurement units") }
@Composable fun VoiceOverlayScreen() { Text("Listening") }
@Composable fun DeleteEventDialog() { Text("Delete this event?") }
""",
}


def _tree(root: Path, files: dict[str, str]) -> Path:
    for rel, text in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
    return root


def _screens(facts: code.CodeFacts) -> dict[str, code.CodeScreen]:
    return {s.key: s for s in facts.screens}


@pytest.fixture
def ios_facts(tmp_path):
    return code.extract(_tree(tmp_path, SWIFT))


def test_a_swiftui_screen_is_what_a_person_navigates_to(ios_facts):
    screens = _screens(ios_facts)
    # A tab (through the wrapper that only holds it), a tab in a navigation stack, a pushed
    # destination, a sheet, a full-screen cover, and the onboarding the app's root chooses.
    assert set(screens) == {"today", "settings", "event-detail", "quick-notes", "voice-overlay", "onboarding"}
    assert all(s.platform == "swiftui" for s in screens.values())


def test_views_that_only_compose_a_screen_fold_into_it(ios_facts):
    screens = _screens(ios_facts)
    # The header and the timeline are parts of Today; the steps onboarding switches in place are
    # parts of onboarding (as Android's `when (step)` inside one destination); the tab bar holds
    # the tabs, the wrapper holds Today, the root only chooses.
    for folded in ("dashboard-header", "timeline", "baby-name", "baby-birthday", "main-tab", "today-tab", "root", "loading"):
        assert folded not in screens
    # Their words are the screen's that draws them, so a capture of Today still meets it.
    texts = {t.key: t for t in ios_facts.texts}
    assert {"Good morning, Amara", "Nothing logged today"} <= set(texts["today"].texts)
    assert {"Baby's name", "Birthday"} <= set(texts["onboarding"].texts)


def test_code_the_app_never_reaches_presents_nothing(ios_facts):
    screens = _screens(ios_facts)
    # A view nothing reachable instantiates (only its preview does), and the sheet only it opens;
    # a cover only a debug build shows.
    assert "old-log" not in screens and "time-picker" not in screens
    assert "screenshot" not in screens


def test_each_tab_leads_to_the_others(ios_facts):
    edges = {(n.from_key, n.to_key) for n in ios_facts.navigation}
    assert ("today", "settings") in edges and ("settings", "today") in edges
    assert ("today", "event-detail") in edges and ("today", "quick-notes") in edges


def test_without_a_root_a_view_nothing_instantiates_is_kept(tmp_path):
    # Part of an app (no `@main` here): the login nothing in this code opens may be its root.
    facts = code.extract(_tree(tmp_path, {
        "Homes/LoginView.swift": "import SwiftUI\nstruct LoginView: View {\n    var body: some View { NavigationLink(destination: FeedView()) { Text(\"Browse\") } }\n}\n",
        "Homes/FeedView.swift": "import SwiftUI\nstruct FeedView: View {\n    var body: some View { List { FeedRowView() } }\n}\n",
        "Homes/FeedRowView.swift": "import SwiftUI\nstruct FeedRowView: View {\n    var body: some View { Text(\"Featured homes\") }\n}\n",
    }))
    assert set(_screens(facts)) == {"login", "feed"}  # the row only composes the feed


@pytest.fixture
def both_facts(tmp_path):
    return code.extract(_tree(tmp_path, {**SWIFT, **COMPOSE}))


def test_compose_counts_its_destinations_dialogs_and_the_sheets_it_shows(both_facts):
    android = {s.key for s in both_facts.screens if s.platform == "compose"}
    assert android == {"/onboarding", "/today", "/event_detail", "/settings", "/voice_overlay", "/delete_event", "add-entry"}
    # A bottom sheet laid out inline is part of Today, as an inline SwiftUI sheet is.
    assert not any("feeds" in k for k in android)


def test_one_apps_ios_and_android_counts_read_alike(both_facts):
    ios = sum(1 for s in both_facts.screens if s.platform == "swiftui")
    android = sum(1 for s in both_facts.screens if s.platform == "compose")
    # Six screens a person reaches on iOS; on Android the same five, a delete dialog and a sheet.
    assert (ios, android) == (6, 7)


def test_each_phone_payload_holds_its_own_screens(both_facts):
    ios = payload_from_facts(both_facts, "ios")
    android = payload_from_facts(both_facts, "android")
    assert {n["detail"]["framework"] for n in ios["nodes"] if n["kind"] == "screen"} == {"swiftui"}
    assert {n["detail"]["framework"] for n in android["nodes"] if n["kind"] == "screen"} == {"compose"}
    assert (counts(ios)["screens"], counts(android)["screens"]) == (6, 7)
    # A Swift file's tab edges never reach the Android map.
    assert all(e["evidence"][0]["path"].endswith(".kt") for e in android["edges"] if e["kind"] == "navigates")
