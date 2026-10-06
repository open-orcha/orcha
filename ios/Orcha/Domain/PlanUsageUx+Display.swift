import Foundation

/// The portal-wide plan usage display setting: whether the project-Home card shows,
/// and which providers it lists. Sync rule shared with desktop and web: read every
/// paired portal, newest `updated_at` wins, never-set (`null`) loses to any set value,
/// all-null means the default (hidden, both).
extension PlanUsageUx {

    static let displayCaption = "Shows your Claude and Codex plan limits in the sidebar and on each project's Home, on every device connected to this Embodent."

    enum ProviderChoice: String, CaseIterable, Hashable, Sendable {
        case both, claude, codex

        var label: String {
            switch self {
            case .both: "Both"
            case .claude: "Claude"
            case .codex: "Codex"
            }
        }

        /// Unknown wire values read as `both` so a newer portal never hides everything.
        init(wire: String) {
            self = ProviderChoice(rawValue: wire.lowercased()) ?? .both
        }
    }

    struct Display: Equatable, Sendable {
        var show: Bool
        var providers: ProviderChoice
        /// nil = never set on any portal.
        var updatedAt: Date?

        static let `default` = Display(show: false, providers: .both, updatedAt: nil)

        init(show: Bool, providers: ProviderChoice, updatedAt: Date?) {
            self.show = show
            self.providers = providers
            self.updatedAt = updatedAt
        }

        init(_ dto: PlanUsageDisplayDto) {
            self.init(
                show: dto.show,
                providers: ProviderChoice(wire: dto.providers),
                updatedAt: PlanUsageUx.parseDate(dto.updatedAt)
            )
        }

        /// Same choice, regardless of when it was made.
        func sameChoice(as other: Display) -> Bool {
            show == other.show && providers == other.providers
        }
    }

    /// Newest `updated_at` across portals; a never-set value loses to any set one; the
    /// default when none was ever set (or nothing answered).
    static func mergeDisplay(_ dtos: [PlanUsageDisplayDto]) -> Display {
        dtos.map(Display.init)
            .filter { $0.updatedAt != nil }
            .max { $0.updatedAt! < $1.updatedAt! } ?? .default
    }

    /// A local edit not yet seen on any portal stays on screen until a portal reports
    /// the same choice or something newer.
    static func resolveDisplay(remote: Display, pending: Display?) -> Display {
        guard let pending else { return remote }
        if remote.sameChoice(as: pending) { return remote }
        if let r = remote.updatedAt, let l = pending.updatedAt, r >= l { return remote }
        return pending
    }

    /// The providers the Home card shows for this choice.
    static func filter(_ providers: [Provider], by choice: ProviderChoice) -> [Provider] {
        switch choice {
        case .both: providers
        case .claude, .codex: providers.filter { $0.id == choice.rawValue }
        }
    }
}
