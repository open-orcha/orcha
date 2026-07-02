import Foundation
import Observation

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
    private let api = OrchaApiClient()
    private var pollTask: Task<Void, Never>?

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
    var runLines: [String] = []
    var models: [ModelDto] = []
    var conversation: ConversationDto?
    var turns: [TurnDto] = []

    // ui state
    var loading = false
    var connecting = false
    var actionInFlight = false
    var error: String?
    var toast: String?

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
            let base = try OrchaServerAddress.normalize(raw)
            guard let container = try await api.listContainers(base).containers.first else {
                error = "No Orcha container was found at this address."
                return false
            }
            let snap = try await api.snapshot(base, container.id)
            let human = snap.agents.first { $0.kind == "human" }
            let stored = StoredContainer(
                id: container.id,
                displayName: container.name,
                baseUrl: base,
                humanAgentId: human?.id,
                humanAlias: human?.alias
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

    // MARK: detail loads

    func loadTaskDetail(_ taskId: String) async {
        guard let sel = selectedContainer else { return }
        do {
            taskMessages = try await api.taskMessages(sel.baseUrl, taskId).messages
            taskRuns = try await api.taskRuns(sel.baseUrl, taskId).runs
        } catch {
            self.error = friendly(error)
        }
    }

    func loadAgentDetail(_ agentId: String) async {
        guard let sel = selectedContainer else { return }
        agentExtras = AgentExtras()
        do {
            let headless = try await api.agentRuns(sel.baseUrl, agentId).runs
            let resident = (try? await api.residentRuns(sel.baseUrl, agentId).runs) ?? []
            var seen = Set<String>()
            agentRuns = (headless + resident)
                .filter { seen.insert($0.runId).inserted }
                .sorted { ($0.startedAt ?? "") > ($1.startedAt ?? "") }
            models = try await api.models(sel.baseUrl).models
        } catch {
            self.error = friendly(error)
        }
        agentExtras.persona = try? await api.persona(sel.baseUrl, agentId)
        agentExtras.digest = (try? await api.digest(sel.baseUrl, agentId))?.digest
        if let inboxRows = try? await api.inbox(sel.baseUrl, agentId).openRequests {
            agentExtras.inboxCount = inboxRows.count
            agentExtras.inboxPreview = inboxRows.first?.payload
        }
        if let outboxRows = try? await api.outbox(sel.baseUrl, agentId).outgoingRequests {
            agentExtras.outboxOpen = outboxRows.filter { $0.status == "open" }.count
            agentExtras.outboxAnswered = outboxRows.filter { $0.status == "answered" }.count
        }
    }

    func loadRunLog(_ run: RunDto) async {
        guard let sel = selectedContainer, let aid = run.agentId else { return }
        loading = true
        defer { loading = false }
        do {
            let text = try await api.runStreamText(sel.baseUrl, aid, run.runId)
            runLines = Self.parseSseLines(text)
        } catch {
            self.error = friendly(error)
        }
    }

    func loadConversation(_ agentId: String) async {
        guard let sel = selectedContainer else { return }
        do {
            let response = try await api.conversation(sel.baseUrl, agentId)
            conversation = response.conversation
            turns = response.turns
        } catch {
            self.error = friendly(error)
        }
    }

    // MARK: human actions

    @discardableResult
    private func humanAction(_ success: String, _ block: (String, String) async throws -> Void) async -> Bool {
        guard let sel = selectedContainer else { return false }
        guard let actor = sel.humanAgentId else {
            error = "Pairing is missing the human identity. Reconnect this Orcha first."
            return false
        }
        actionInFlight = true
        error = nil
        defer { actionInFlight = false }
        do {
            try await block(sel.baseUrl, actor)
            toast = success
            return true
        } catch {
            self.error = friendly(error)
            return false
        }
    }

    func sendTaskMessage(_ taskId: String, body: String) async -> Bool {
        await humanAction("Message sent") { base, actor in
            try await api.postTaskMessage(base, taskId, actor: actor, body: body)
            await loadTaskDetail(taskId)
        }
    }

    func cancelTask(_ taskId: String, reason: String?) async -> Bool {
        await humanAction("Task closed") { base, actor in
            try await api.cancelTask(base, taskId, actor: actor, reason: reason)
            await refresh()
        }
    }

    func verifyTask(_ taskId: String, approve: Bool, feedback: String?) async -> Bool {
        await humanAction(approve ? "Task accepted · completed" : "Task sent back") { base, actor in
            try await api.verifyTask(base, taskId, actor: actor, approve: approve, feedback: feedback)
            await refresh()
        }
    }

    func decidePlan(_ task: TaskDto, approve: Bool, reason: String?) async -> Bool {
        await humanAction(approve ? "Plan approved" : "Changes requested") { base, actor in
            try await api.decidePlan(base, task.id, actor: actor, approve: approve, reason: reason, target: task.ownerId ?? task.createdByAgentId)
            await refresh()
        }
    }

    func respondRequest(_ rid: String, response: String) async -> Bool {
        await humanAction("Answer sent") { base, actor in
            try await api.respondRequest(base, rid, actor: actor, response: response)
            await refresh()
        }
    }

    func closeRequest(_ rid: String, reason: String?) async -> Bool {
        await humanAction("Request closed") { base, actor in
            try await api.closeRequest(base, rid, actor: actor, reason: reason)
            await refresh()
        }
    }

    func nudgeRequest(_ rid: String, note: String?) async -> Bool {
        await humanAction("Nudge sent") { base, actor in
            try await api.nudgeRequest(base, rid, actor: actor, note: note)
            await refresh()
        }
    }

    func escalateRequest(_ rid: String, reason: String?) async -> Bool {
        await humanAction("Request escalated") { base, actor in
            try await api.escalateRequest(base, rid, actor: actor, reason: reason)
            await refresh()
        }
    }

    func acceptTaskRequest(_ rid: String, note: String?) async -> Bool {
        await humanAction("Task request accepted") { base, actor in
            try await api.acceptTaskRequest(base, rid, actor: actor, note: note)
            await refresh()
        }
    }

    func rejectTaskRequest(_ rid: String, reason: String) async -> Bool {
        await humanAction("Task request rejected") { base, actor in
            try await api.rejectTaskRequest(base, rid, actor: actor, reason: reason)
            await refresh()
        }
    }

    func convertRequest(_ rid: String, title: String, dod: String, assignee: String?) async -> Bool {
        await humanAction("Request became a task") { base, actor in
            try await api.convertRequest(base, rid, actor: actor, title: title, dod: dod, assignee: assignee)
            await refresh()
        }
    }

    func triageCloseRequest(_ rid: String) async -> Bool {
        await humanAction("Request closed (triage)") { base, _ in
            try await api.triageCloseRequest(base, rid)
            await refresh()
        }
    }

    func changeModel(_ agentId: String, model: String) async -> Bool {
        await humanAction("Model changed") { base, _ in
            try await api.updateAgentModel(base, agentId, model: model)
            await refresh()
            await loadAgentDetail(agentId)
        }
    }

    func changeAutoWake(_ agentId: String, intervalSecs: Int?) async -> Bool {
        await humanAction("Auto-wake updated") { base, actor in
            try await api.updateAutoWake(base, agentId, actor: actor, intervalSecs: intervalSecs)
            await refresh()
        }
    }

    func renameAgent(_ agentId: String, alias: String) async -> Bool {
        await humanAction("Agent renamed") { base, actor in
            try await api.renameAgent(base, agentId, actor: actor, alias: alias)
            await refresh()
        }
    }

    func retireAgent(_ agentId: String) async -> Bool {
        await humanAction("Agent retired") { base, actor in
            try await api.retireAgent(base, agentId, actor: actor)
            await refresh()
        }
    }

    func sendTurn(_ agentId: String, content: String) async -> Bool {
        await humanAction("Message sent") { base, actor in
            if conversation == nil {
                conversation = try await api.startConversation(base, agentId, actor: actor).conversation
            }
            guard let conv = conversation else { throw URLError(.badServerResponse) }
            try await api.sendTurn(base, conv.id, actor: actor, content: content)
            await loadConversation(agentId)
        }
    }

    func endConversation(_ agentId: String) async -> Bool {
        guard let conv = conversation else { return false }
        return await humanAction("Conversation ended") { base, actor in
            try await api.endConversation(base, conv.id, actor: actor)
            await loadConversation(agentId)
        }
    }

    func stopRun(_ run: RunDto) async -> Bool {
        await humanAction("Stop requested") { base, actor in
            try await api.stopRun(base, run.runId, actor: actor)
            await loadRunLog(run)
        }
    }

    func createTask(
        title: String, description: String?, dod: String,
        assignee: String?, priority: Int, dependsOn: [String], notReady: Bool
    ) async -> String? {
        guard let sel = selectedContainer else { return nil }
        var created: String?
        _ = await humanAction(assignee != nil ? "Task created · assigned to \(assignee!)" : "Task created — parked in the backlog") { base, actor in
            let response = try await api.createTask(
                base, sel.id, actor: actor,
                title: title, description: description, dod: dod,
                assignee: assignee, priority: priority, dependsOn: dependsOn, notReady: notReady
            )
            created = response.taskId
            await refresh()
        }
        return created
    }

    // MARK: helpers

    static func parseSseLines(_ text: String) -> [String] {
        text.split(separator: "\n", omittingEmptySubsequences: true)
            .filter { $0.hasPrefix("data:") }
            .compactMap { line -> String? in
                let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                guard
                    let data = payload.data(using: .utf8),
                    let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                else { return nil }
                if let text = obj["line"] as? String { return text }
                if let status = obj["status"] as? String { return "run \(status)" }
                return nil
            }
    }

    private func friendly(_ error: Error) -> String {
        if let e = error as? OrchaServerAddress.AddressError {
            return e.localizedDescription
        }
        if let e = error as? OrchaApiError {
            return e.localizedDescription
        }
        return "Could not reach Orcha at this address. Check that Orcha is running and your phone is on the same Wi-Fi."
    }
}
