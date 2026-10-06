import Foundation
import Observation
import os

/// Plan usage state shared by the Projects card, its detail sheet and Settings ›
/// Plan usage. Reads `GET /api/plan-usage` once per distinct paired base URL,
/// in parallel, and keeps the newest entry per provider. Alongside, reads the
/// portal-wide display setting (`GET /api/plan-usage/display`) from the same bases
/// and keeps the newest one; edits go out optimistically to every paired base.
@MainActor
@Observable
final class PlanUsageModel {
    private(set) var providers: [PlanUsageUx.Provider] = []
    /// False until the first refresh finishes (drives the skeleton).
    private(set) var loaded = false
    /// Whether / which providers the project-Home card shows. Hidden by default.
    private(set) var display: PlanUsageUx.Display = .default
    /// The user's latest edit, kept until a portal echoes it (or reports something newer)
    /// so a poll racing the PUT can't flip the switch back.
    private var pendingDisplay: PlanUsageUx.Display?
    private var inFlight = false
    nonisolated private static let log = Logger(subsystem: "io.openorcha.mobile.ios", category: "plan-usage")

    private let api: OrchaApiClient

    init(api: OrchaApiClient = OrchaApiClient()) {
        self.api = api
    }

    /// Re-reads every server. A server that errors (unreachable, auth) is skipped;
    /// if every server errors the previous numbers stay on screen.
    func refresh(bases: [String]) async {
        guard !inFlight else { return }
        inFlight = true
        defer { inFlight = false }

        let distinct = Array(Set(bases)).sorted()
        guard !distinct.isEmpty else {
            providers = []
            applyRemoteDisplay(.default)
            loaded = true
            return
        }
        let api = self.api
        async let usageResults: [PlanUsageListDto?] = withTaskGroup(of: PlanUsageListDto?.self) { group in
            for base in distinct {
                group.addTask { try? await api.planUsage(base) }
            }
            var out: [PlanUsageListDto?] = []
            for await r in group { out.append(r) }
            return out
        }
        async let displayResults: [PlanUsageDisplayDto] = withTaskGroup(of: PlanUsageDisplayDto?.self) { group in
            for base in distinct {
                // 404 (older portal) and network errors both drop out here.
                group.addTask { (try? await api.planUsageDisplay(base)) ?? nil }
            }
            var out: [PlanUsageDisplayDto] = []
            for await r in group { if let r { out.append(r) } }
            return out
        }
        let (results, displays) = await (usageResults, displayResults)
        let answered = results.compactMap { $0 }
        if !answered.isEmpty || !loaded {
            providers = PlanUsageUx.merge(answered.flatMap(\.snapshots))
        }
        if !displays.isEmpty || !loaded {
            applyRemoteDisplay(PlanUsageUx.mergeDisplay(displays))
        }
        loaded = true
    }

    /// The providers the project-Home card lists for the current choice.
    var shownProviders: [PlanUsageUx.Provider] {
        PlanUsageUx.filter(providers, by: display.providers)
    }

    /// Optimistic edit: the UI flips now, then every paired base gets the PUT
    /// (fire-and-forget; failures are logged, the next poll reconciles).
    func setDisplay(show: Bool, providers choice: PlanUsageUx.ProviderChoice, bases: [String]) {
        let edit = PlanUsageUx.Display(show: show, providers: choice, updatedAt: .now)
        guard !edit.sameChoice(as: display) else { return }
        display = edit
        pendingDisplay = edit
        let distinct = Array(Set(bases)).sorted()
        guard !distinct.isEmpty else { return }
        let api = self.api
        Task {
            let stored: [PlanUsageDisplayDto] = await withTaskGroup(of: PlanUsageDisplayDto?.self) { group in
                for base in distinct {
                    group.addTask {
                        do {
                            return try await api.putPlanUsageDisplay(base, show: show, providers: choice.rawValue)
                        } catch {
                            Self.log.error("PUT plan-usage display failed for \(base, privacy: .public): \(error.localizedDescription, privacy: .public)")
                            return nil
                        }
                    }
                }
                var out: [PlanUsageDisplayDto] = []
                for await r in group { if let r { out.append(r) } }
                return out
            }
            // Adopt the server's timestamp only if this is still the latest edit.
            if pendingDisplay == edit, !stored.isEmpty {
                applyRemoteDisplay(PlanUsageUx.mergeDisplay(stored))
            }
        }
    }

    private func applyRemoteDisplay(_ remote: PlanUsageUx.Display) {
        let resolved = PlanUsageUx.resolveDisplay(remote: remote, pending: pendingDisplay)
        if resolved == remote { pendingDisplay = nil }
        display = resolved
    }
}
