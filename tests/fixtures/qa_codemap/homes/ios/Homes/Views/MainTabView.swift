import SwiftUI

struct MainTabView: View {
    var body: some View {
        TabView {
            ListingsView().tabItem { Label("Listings", systemImage: "house") }
            SettingsView().tabItem { Label("Settings", systemImage: "gear") }
        }
    }
}
