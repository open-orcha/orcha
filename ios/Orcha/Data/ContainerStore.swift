import Foundation

/// A paired project (container) on a paired Orcha. Cloud multi-project: ONE
/// pairing covers a whole deployment — every container listed by its
/// `/api/containers` is stored as a row sharing the same `baseUrl` +
/// `accessToken`, so the containers home doubles as the project switcher.
/// Rename is local-only.
struct StoredContainer: Codable, Identifiable, Equatable {
    let id: String
    var displayName: String
    var baseUrl: String
    var humanAgentId: String?
    var humanAlias: String?
    /// Short-lived QR pairing token (A2 device-token exchange is a backend follow-up;
    /// held now so the exchange has it once that ships). Absent for manual entry.
    /// NOT the auth credential — that's `accessToken`.
    var pairingToken: String?
    /// The deployment's team access token — sent as `Authorization: Bearer …` on
    /// every request when set (the cloud auth perimeter's iOS/API lane). Pasted by
    /// the user at add time or in Settings; nil for unprotected self-host servers.
    /// One box = one token: kept identical across rows sharing `baseUrl`.
    var accessToken: String? = nil
    /// Opt-in second address (typically the computer's Tailscale name/IP) tried
    /// when `baseUrl` doesn't answer; on success the two swap so the working
    /// path stays active. Nil = single-address, the default.
    var remoteBaseUrl: String?
    var lastOpenedAt: Date = .now

    enum CodingKeys: String, CodingKey {
        case id, displayName, baseUrl, humanAgentId, humanAlias, pairingToken, accessToken, remoteBaseUrl, lastOpenedAt
    }
}

/// UserDefaults-backed store for pairings + the theme setting. Every load/save
/// rebuilds `BearerTokens` so the API client always resolves the credential for
/// a base URL from persisted state. (`accessToken` is a secret in UserDefaults;
/// moving it to the Keychain is a listed follow-up — the exposure matches the
/// sandboxed app container either way.)
struct ContainerStore {
    private let defaults: UserDefaults
    private static let key = "orcha_containers"
    private static let themeKey = "orcha_theme_mode"
    private static let skinKey = "orcha_skin_mode"

    /// `defaults` is injectable so tests can use an isolated suite.
    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func load() -> [StoredContainer] {
        guard let data = defaults.data(forKey: Self.key) else { return [] }
        let containers = (try? JSONDecoder().decode([StoredContainer].self, from: data)) ?? []
        BearerTokens.rebuild(from: containers)
        return containers
    }

    func save(_ containers: [StoredContainer]) {
        let ordered = containers.sorted { $0.lastOpenedAt > $1.lastOpenedAt }
        if let data = try? JSONEncoder().encode(ordered) {
            defaults.set(data, forKey: Self.key)
        }
        BearerTokens.rebuild(from: ordered)
    }

    func upsert(_ container: StoredContainer) -> [StoredContainer] {
        var next = load().filter { $0.id != container.id }
        next.insert(container, at: 0)
        save(next)
        return next
    }

    /// Cloud multi-project: disconnecting a project disconnects its whole
    /// connection — every row sharing the base URL — otherwise the next
    /// discovery pass would just re-add the "forgotten" project.
    func removeConnection(of id: String) -> [StoredContainer] {
        let all = load()
        guard let base = all.first(where: { $0.id == id })?.baseUrl else { return all }
        let next = all.filter { $0.baseUrl != base }
        save(next)
        return next
    }

    func setRemoteUrl(_ id: String, to url: String?) -> [StoredContainer] {
        var next = load()
        if let i = next.firstIndex(where: { $0.id == id }) {
            next[i].remoteBaseUrl = url
        }
        save(next)
        return next
    }

    /// One box = one team token: applies to every project sharing the address,
    /// so the registry never sees two credentials for one base URL.
    func setAccessToken(_ id: String, to token: String?) -> [StoredContainer] {
        var next = load()
        guard let base = next.first(where: { $0.id == id })?.baseUrl else { return next }
        let cleaned = token?.trimmingCharacters(in: .whitespacesAndNewlines)
        for i in next.indices where next[i].baseUrl == base {
            next[i].accessToken = (cleaned?.isEmpty ?? true) ? nil : cleaned
        }
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

    func loadSkinMode() -> SkinMode {
        SkinMode(rawValue: defaults.string(forKey: Self.skinKey) ?? "classic") ?? .classic
    }

    func loadNotificationsEnabled() -> Bool {
        defaults.bool(forKey: "orcha_notifications_enabled")
    }

    /// "Catch me up": the workspace digest as of the human's last look, per
    /// container, so the next open can brief the delta.
    func lastSeen(for id: String) -> (digest: String, at: Date)? {
        guard let digest = defaults.string(forKey: "orcha_seen_digest_\(id)"),
              let at = defaults.object(forKey: "orcha_seen_at_\(id)") as? Date else { return nil }
        return (digest, at)
    }

    func saveLastSeen(_ digest: String, for id: String) {
        defaults.set(digest, forKey: "orcha_seen_digest_\(id)")
        defaults.set(Date.now, forKey: "orcha_seen_at_\(id)")
    }

    func saveNotificationsEnabled(_ enabled: Bool) {
        defaults.set(enabled, forKey: "orcha_notifications_enabled")
    }

    func saveSkinMode(_ skin: SkinMode) {
        defaults.set(skin.rawValue, forKey: Self.skinKey)
    }
}
