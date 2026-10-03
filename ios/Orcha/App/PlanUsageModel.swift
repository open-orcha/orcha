import Foundation
import Observation

/// Plan usage state shared by the Projects card, its detail sheet and Settings ›
/// Plan usage. Reads `GET /api/plan-usage` once per distinct paired base URL,
/// in parallel, and keeps the newest entry per provider.
@MainActor
@Observable
final class PlanUsageModel {
    private(set) var providers: [PlanUsageUx.Provider] = []
    /// False until the first refresh finishes (drives the skeleton).
    private(set) var loaded = false
    private var inFlight = false

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
            loaded = true
            return
        }
        let api = self.api
        let results: [PlanUsageListDto?] = await withTaskGroup(of: PlanUsageListDto?.self) { group in
            for base in distinct {
                group.addTask { try? await api.planUsage(base) }
            }
            var out: [PlanUsageListDto?] = []
            for await r in group { out.append(r) }
            return out
        }
        let answered = results.compactMap { $0 }
        if !answered.isEmpty || !loaded {
            providers = PlanUsageUx.merge(answered.flatMap(\.snapshots))
        }
        loaded = true
    }
}
