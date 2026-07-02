import SwiftUI

@main
struct OrchaApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .preferredColorScheme(model.themeMode.colorScheme)
                .tint(Palette.current(model.themeMode).accent)
        }
    }
}
