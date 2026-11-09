import Foundation

@Observable
final class ListingsModel {
    func load() async {
        let url = URL(string: "https://api.homes.test/v1/listings")!
        _ = try? await URLSession.shared.data(from: url)
    }
}
