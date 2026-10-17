import SwiftUI
import UIKit
import UserNotifications

@main
struct OrchaApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        // BGTaskScheduler registration must land before launch finishes.
        NotificationCoordinator.registerBackgroundTask()
        UNUserNotificationCenter.current().delegate = NotificationCoordinator.shared
        // Linear chrome: window-coloured bars, hairline separators, Inter titles.
        ChromeAppearance.apply(skin: ContainerStore().loadSkinMode())
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                // Window-level override, not `.preferredColorScheme`: switching back to
                // System (nil) leaves already-presented sheets stuck on the old scheme,
                // so a sheet rendered light tokens on dark chrome. UIKit propagates a
                // window's style to every presented controller.
                .onAppear { ChromeAppearance.applyInterfaceStyle(model.themeMode) }
                .onChange(of: model.themeMode) { _, mode in ChromeAppearance.applyInterfaceStyle(mode) }
                .tint(ChromeAppearance.accent(skin: model.skinMode))
                .onChange(of: model.skinMode) { _, skin in ChromeAppearance.apply(skin: skin) }
                .task { NotificationCoordinator.shared.model = model }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active {
                        // Plan usage + its display setting may have changed on another device.
                        let bases = model.containers.map(\.baseUrl)
                        Task { await model.planUsage.refresh(bases: bases) }
                    }
                    if phase == .background, model.notificationsEnabled {
                        NotificationCoordinator.scheduleAppRefresh()
                    }
                    if phase == .background {
                        // Resolves still inside their undo window go out now, with a little
                        // background time so the request isn't cut off mid-flight.
                        let bg = UIApplication.shared.beginBackgroundTask(withName: "resolve-flush")
                        Task {
                            await ResolveUndoQueue.shared.flushAll()
                            UIApplication.shared.endBackgroundTask(bg)
                        }
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
