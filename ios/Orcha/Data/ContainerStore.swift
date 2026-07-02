import Foundation

/// A paired container (flow 03/04). Rename is local-only; the token field arrives
/// with the backend pairing endpoint (doc 13 A1/A2).
struct StoredContainer: Codable, Identifiable, Equatable {
    let id: String
    var displayName: String
    var baseUrl: String
    var humanAgentId: String?
    var humanAlias: String?
    var lastOpenedAt: Date = .now

    enum CodingKeys: String, CodingKey {
        case id, displayName, baseUrl, humanAgentId, humanAlias, lastOpenedAt
    }
}

/// UserDefaults-backed store for pairings + the theme setting. (Keychain is the
/// doc-13 target once pairing tokens exist; today's payload carries no secrets.)
struct ContainerStore {
    private let defaults = UserDefaults.standard
    private static let key = "orcha_containers"
    private static let themeKey = "orcha_theme_mode"

    func load() -> [StoredContainer] {
        guard let data = defaults.data(forKey: Self.key) else { return [] }
        return (try? JSONDecoder().decode([StoredContainer].self, from: data)) ?? []
    }

    func save(_ containers: [StoredContainer]) {
        let ordered = containers.sorted { $0.lastOpenedAt > $1.lastOpenedAt }
        if let data = try? JSONEncoder().encode(ordered) {
            defaults.set(data, forKey: Self.key)
        }
    }

    func upsert(_ container: StoredContainer) -> [StoredContainer] {
        var next = load().filter { $0.id != container.id }
        next.insert(container, at: 0)
        save(next)
        return next
    }

    func remove(_ id: String) -> [StoredContainer] {
        let next = load().filter { $0.id != id }
        save(next)
        return next
    }

    func rename(_ id: String, to name: String) -> [StoredContainer] {
        var next = load()
        if let i = next.firstIndex(where: { $0.id == id }) {
            next[i].displayName = name
        }
        save(next)
        return next
    }

    func loadThemeMode() -> ThemeMode {
        ThemeMode(rawValue: defaults.string(forKey: Self.themeKey) ?? "auto") ?? .auto
    }

    func saveThemeMode(_ mode: ThemeMode) {
        defaults.set(mode.rawValue, forKey: Self.themeKey)
    }
}
