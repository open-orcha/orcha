import SwiftUI
import SwiftData

struct NewListingView: View {
    @Environment(\.modelContext) private var modelContext
    var body: some View {
        Button("Save listing") { modelContext.insert(Listing(title: "Flat in Westlands")) }
    }
}
