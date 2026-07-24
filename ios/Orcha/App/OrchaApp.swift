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
                .task { NotificationCoordinator.shared.attach(model) }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .background, model.notificationsEnabled {
                        NotificationCoordinator.scheduleAppRefresh()
                    }
                }
        }
    }
}
