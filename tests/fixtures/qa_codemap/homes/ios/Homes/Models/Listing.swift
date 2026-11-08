import SwiftData

@Model
final class Listing {
    var title: String
    var createdAt: Date = Date.now

    init(title: String) {
        self.title = title
    }
}
