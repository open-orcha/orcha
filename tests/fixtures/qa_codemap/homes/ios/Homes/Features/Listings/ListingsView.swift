import SwiftUI
import SwiftData

struct ListingsView: View {
    @Query private var listings: [Listing]
    @State private var model = ListingsModel()
    @State private var showNew = false

    var body: some View {
        NavigationStack {
            List(listings) { listing in
                NavigationLink(destination: ListingDetailView(listing: listing)) {
                    Text("Open listing")
                }
            }
            .navigationTitle("Listings")
            .toolbar { Button("Add listing") { showNew = true } }
            .sheet(isPresented: $showNew) { NewListingView() }
            .task { await model.load() }
        }
    }
}
