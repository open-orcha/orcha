import Foundation
import Observation

// Responsibility: Shared app state, persistence, pairing, workspace lifecycle, and polling.

/// Per-card reachability + glance counts for the Containers home (flow 04 H1).
struct ContainerHealth: Equatable {
    var state: String            // live | polling | unreachable | probing
    var agents: Int = 0
    var tasks: Int = 0
    var needsYou: Int = 0
}

/// Flow 09: lazily-fetched agent-detail sections (each best-effort).
struct AgentExtras {
    var persona: PersonaResponse?
    var digest: DigestDto?
    var inboxCount: Int?
    var inboxPreview: String?
    var outboxOpen: Int?
    var outboxAnswered: Int?
}

enum WorkspaceTab: Hashable {
    case home, tasks, requests, agents
}

/// The app's single source of truth — a 1:1 port of the Android `OrchaViewModel`
/// (same state fields, same action surface), driving SwiftUI via @Observable.
@MainActor
@Observable
final class AppModel {
    private let store = ContainerStore()
    let api = OrchaApiClient()
    private var pollTask: Task<Void, Never>?
    /// Issue 3 — the live run-log collector; cancelled on leaving RunDetailScreen.
    var runStreamTask: Task<Void, Never>?
    var lastRunSeq = -1
    /// Issue 4 — task-thread keyset cursor (echoed back as before/before_id to load earlier).
    var threadNextBefore: String?
    var threadNextBeforeId: String?

    // navigation
    var containers: [StoredContainer]
    var selectedContainer: StoredContainer?
    var selectedTab: WorkspaceTab = .home
    var themeMode: ThemeMode

    // workspace data
    var snapshot: ContainerSnapshot?
    var containerHealth: [String: ContainerHealth] = [:]
    var taskMessages: [TaskMessageDto] = []
    var taskRuns: [RunDto] = []
    var agentRuns: [RunDto] = []
    var agentExtras = AgentExtras()
    /// Issue 3 — the typed, classified run-log feed (web/Android parity). Classified once at
    /// append (not on every render), keeping a 400-row retention cap.
    var runFeed: [RunFeedRow] = []
    /// Issue 3 — a neutral note shown above the feed when the live stream drops mid-run
    /// (reconnecting), never a synthetic feed row. Cleared on the next accepted update.
    var runStreamNote: String?
    var models: [ModelDto] = []
    var conversation: ConversationDto?
    var turns: [TurnDto] = []

    // ui state
    var loading = false
    var connecting = false
    var actionInFlight = false
    var error: String?
    var toast: String?
    var runLogStreaming = false      // Issue 3 — waiting on the live run stream
    var threadHasMore = false        // Issue 4 — an older task-thread page is available
    var threadLoadingEarlier = false
    var showContainerControls = false  // GH #148 — Notifier + Autonomy sheet

    var humanId: String? { selectedContainer?.humanAgentId }

    init() {
        containers = store.load()
        themeMode = store.loadThemeMode()
        // Dev/UI-test seam: `-orchaOpenContainer <id>` opens straight into a paired
        // workspace on launch (also the shape a future deep link would take).
        if let idx = ProcessInfo.processInfo.arguments.firstIndex(of: "-orchaOpenContainer"),
           idx + 1 < ProcessInfo.processInfo.arguments.count {
            let id = ProcessInfo.processInfo.arguments[idx + 1]
            if containers.contains(where: { $0.id == id }) {
                openContainer(id)
            }
        }
        // Dev/UI-test seam: `-orchaScanPayload <json>` runs a scanned QR payload
        // through the real pairing path on launch (what the scanner delegate calls).
        if let idx = ProcessInfo.processInfo.arguments.firstIndex(of: "-orchaScanPayload"),
           idx + 1 < ProcessInfo.processInfo.arguments.count {
            let payload = ProcessInfo.processInfo.arguments[idx + 1]
            Task { await connect(payload) }
        }
    }

    // MARK: theme + store

    func setThemeMode(_ mode: ThemeMode) {
        themeMode = mode
        store.saveThemeMode(mode)
    }

    func renameContainer(_ id: String, to name: String) {
        guard !name.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        containers = store.rename(id, to: name.trimmingCharacters(in: .whitespaces))
        if let sel = selectedContainer, sel.id == id {
            selectedContainer = containers.first { $0.id == id }
        }
    }

    func forgetContainer(_ id: String) {
        containers = store.remove(id)
        if selectedContainer?.id == id {
            selectedContainer = nil
            snapshot = nil
        }
    }

    // MARK: pairing (flow 03)

    func connect(_ raw: String) async -> Bool {
        connecting = true
        error = nil
        defer { connecting = false }
        do {
            let payload = try OrchaServerAddress.parse(raw)
            let base = payload.baseUrl
            guard let container = try await api.listContainers(base).containers.first else {
                error = "No Orcha container was found at this address."
                return false
            }
            let snap = try await api.snapshot(base, container.id)
            // Prefer the operator named in the QR (disambiguates multi-human containers);
            // fall back to the sole human in the snapshot for manual entry. Verify the
            // paired id is actually a human on this container before trusting it.
            let humans = snap.agents.filter { $0.kind == "human" }
            let pairedHuman = payload.humanAgentId.flatMap { id in humans.first { $0.id == id } }
            let human = pairedHuman ?? (humans.count == 1 ? humans.first : nil)
            let stored = StoredContainer(
                id: container.id,
                displayName: container.name,
                baseUrl: base,
                humanAgentId: human?.id ?? payload.humanAgentId,
                humanAlias: human?.alias ?? payload.humanAgentAlias,
                pairingToken: payload.token
            )
            containers = store.upsert(stored)
            selectedContainer = stored
            snapshot = snap
            selectedTab = .home
            startPolling()
            return true
        } catch {
            self.error = friendly(error)
            return false
        }
    }

    func openContainer(_ id: String) {
        guard var stored = containers.first(where: { $0.id == id }) else { return }
        stored.lastOpenedAt = .now
        containers = store.upsert(stored)
        selectedContainer = stored
        selectedTab = .home
        error = nil
        Task { await refresh() }
        startPolling()
    }

    func closeWorkspace() {
        pollTask?.cancel()
        selectedContainer = nil
        snapshot = nil
        probeContainers()
    }

    /// Flow 04 H1: per-card reachability + glance counts, non-blocking per card.
    func probeContainers() {
        for stored in containers {
            containerHealth[stored.id, default: ContainerHealth(state: "probing")].state = "probing"
            Task {
                do {
                    let snap = try await api.snapshot(stored.baseUrl, stored.id)
                    let plans = snap.tasks.filter { $0.status == "in_progress" && $0.planMessage != nil && $0.planDecision == nil }
                    let verifs = snap.tasks.filter { $0.status == "needs_verification" }
                    let reqs = snap.requests.filter { $0.status == "open" && ($0.targetId == stored.humanAgentId || $0.targetId == nil) }
                    containerHealth[stored.id] = ContainerHealth(
                        state: "polling", agents: snap.agents.count, tasks: snap.tasks.count,
                        needsYou: plans.count + verifs.count + reqs.count
                    )
                } catch {
                    containerHealth[stored.id] = ContainerHealth(state: "unreachable")
                }
            }
        }
    }

    // MARK: workspace refresh + 30s polling (SSE is the listed follow-up)

    func refresh() async {
        guard let sel = selectedContainer else { return }
        loading = true
        defer { loading = false }
        do {
            let snap = try await api.snapshot(sel.baseUrl, sel.id)
            snapshot = snap
            if sel.humanAgentId == nil, let human = snap.agents.first(where: { $0.kind == "human" }) {
                var upgraded = sel
                upgraded.humanAgentId = human.id
                upgraded.humanAlias = human.alias
                containers = store.upsert(upgraded)
                selectedContainer = upgraded
            }
            error = nil
        } catch {
            self.error = friendly(error)
        }
    }

    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                guard !Task.isCancelled else { return }
                await refresh()
            }
        }
    }

}
