import SwiftUI

struct ListingDetailView: View {
    let listing: Listing
    var body: some View {
        Text(listing.title)
            .navigationTitle("Listing")
    }
}
