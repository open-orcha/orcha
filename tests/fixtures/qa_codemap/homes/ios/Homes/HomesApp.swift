import SwiftUI
import SwiftData

@main
struct HomesApp: App {
    var body: some Scene {
        WindowGroup {
            MainTabView()
                .onOpenURL { url in if url.host == "settings" { SettingsView() } }
        }
        .modelContainer(for: Listing.self)
    }
}
