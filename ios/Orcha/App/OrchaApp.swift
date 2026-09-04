import SwiftUI
import UserNotifications

@main
struct OrchaApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        // BGTaskScheduler registration must land before launch finishes.
        NotificationCoordinator.registerBackgroundTask()
        UNUserNotificationCenter.current().delegate = NotificationCoordinator.shared
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .preferredColorScheme(model.themeMode.colorScheme)
                .tint(Palette.current(model.themeMode, skin: model.skinMode).accent)
                .task { NotificationCoordinator.shared.model = model }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .background, model.notificationsEnabled {
                        NotificationCoordinator.scheduleAppRefresh()
                    }
                }
                .onOpenURL { url in
                    // orcha://auth/callback belongs to the GitHub device-token
                    // flow, and the live ASWebAuthenticationSession intercepts
                    // it before the app ever sees it. One landing here is a
                    // stray (stale browser tab after the session closed) —
                    // swallow it; a bare URL must never mutate pairing state.
                    guard !DeviceAuth.isAuthCallback(url) else { return }
                    // Widget taps: orcha://needs/<containerId> → that workspace's
                    // Home (the needs-you queue).
                    guard url.scheme == "orcha" else { return }
                    if url.host == "needs", let cid = url.pathComponents.dropFirst().first {
                        model.openContainer(cid)
                    }
                }
        }
    }
}
