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
                    // Widget taps. orcha://needs/<cid> → that workspace's Home
                    // (the needs-you queue); orcha://task/<cid>/<id> and
                    // orcha://request/<cid>/<id> → the exact item screen.
                    guard url.scheme == "orcha" else { return }
                    let parts = url.pathComponents.dropFirst()
                    switch url.host {
                    case "needs":
                        if let cid = parts.first { model.openContainer(cid) }
                    case "task", "request", "plan":
                        guard let cid = parts.first, parts.count >= 2 else { return }
                        let id = parts[parts.index(parts.startIndex, offsetBy: 1)]
                        if url.host == "plan" { model.pendingPlanReview = id }
                        let route: WorkspaceRoute = url.host == "request" ? .request(id) : .task(id)
                        model.openFromNotification(containerId: cid, route: route)
                    default:
                        break
                    }
                }
        }
    }
}
