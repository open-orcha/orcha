import Foundation

/// Task-detail parity — the view-owned load/act surface on AppModel (the `AppModel+*`
/// per-feature extension pattern). Reads return their value to the calling view, which
/// owns the state (evidence, Verdikt, goal chain, manager pre-review); a failed read is
/// shown in place, never the app-wide banner. Writes follow the shared human-action
/// contract: `actionInFlight`, `error`, and a success `toast`.
extension AppModel {

    /// The selected project's base URL and id (nil when no project is open).
    private var taskSliceTarget: (base: String, cid: String)? {
        selectedContainer.map { ($0.baseUrl, $0.id) }
    }

    // MARK: reads

    func fetchEvidence(_ taskId: String) async throws -> EvidencePackDto? {
        guard let t = taskSliceTarget else { return nil }
        return try await api.taskEvidence(t.base, taskId)
    }

    func fetchVerdiktRuns(_ taskId: String) async throws -> VerdiktRunsResponse? {
        guard let t = taskSliceTarget else { return nil }
        return try await api.verdiktRuns(t.base, taskId)
    }

    func fetchGoalChain(_ taskId: String) async throws -> GoalChainDto? {
        guard let t = taskSliceTarget else { return nil }
        return try await api.goalChain(t.base, taskId)
    }

    /// The AI manager's pre-review for one task (nil when none / older server).
    func fetchManagerReview(_ task: TaskDto) async -> ManagerReviewDto? {
        await fetchReviewExtras(task)?.managerReview
    }

    /// The manager pre-review plus the review routing ("Reviewer: X · via Atlas's manager").
    func fetchReviewExtras(_ task: TaskDto) async -> TaskReviewExtrasDto? {
        guard let t = taskSliceTarget else { return nil }
        let rows = try? await api.taskReviewExtras(t.base, t.cid, status: task.status)
        return rows?.first { $0.id == task.id }
    }

    func previewTaskRoutine(cron: String, timezone: String) async -> TaskRoutinePreviewDto? {
        guard let t = taskSliceTarget else { return nil }
        return try? await api.previewTaskRoutineSchedule(t.base, t.cid, cron: cron, timezone: timezone)
    }

    /// Absolute URL for a portal-relative link (Verdikt report / "Open in Verdikt").
    func portalURL(_ path: String) -> URL? {
        if path.hasPrefix("http") { return URL(string: path) }
        guard let base = selectedContainer?.baseUrl else { return nil }
        return URL(string: base + path)
    }

    // MARK: writes

    /// Run the shared human-action contract for this slice's writes.
    private func taskSliceAction<T>(
        _ success: (T) -> String,
        _ block: (String, String, String) async throws -> T
    ) async -> T? {
        guard let sel = selectedContainer else { return nil }
        guard let actor = sel.humanAgentId else {
            error = "Pairing is missing the human identity. Reconnect this Embodent first."
            return nil
        }
        actionInFlight = true
        error = nil
        defer { actionInFlight = false }
        do {
            let value = try await block(sel.baseUrl, sel.id, actor)
            toast = success(value)
            return value
        } catch {
            self.error = friendly(error)
            return nil
        }
    }

    /// Reassign: releases the current assignee and wakes the new one.
    func reassignTask(_ taskId: String, to agentId: String) async -> Bool {
        let result = await taskSliceAction({ (r: AssignResultDto) in
            "Reassigned to \(r.alias ?? "the agent")"
        }) { base, _, actor in
            let r = try await api.assignTaskToAgent(base, taskId, actor: actor, agentId: agentId)
            await refresh()
            return r
        }
        return result != nil
    }

    /// "Make recurring…" — the task itself is never changed.
    func makeTaskRecurring(_ draft: TaskRoutineDraft) async -> Bool {
        let result = await taskSliceAction({ (r: TaskRoutineCreatedDto) in
            "Routine created — \(r.scheduleText ?? "on schedule"). The task is unchanged."
        }) { base, cid, actor in
            try await api.createRoutineFromTask(base, cid, actor: actor, draft: draft)
        }
        return result != nil
    }

    /// Hand the task's definition of done to Verdikt now (manual trigger).
    func runVerdikt(_ taskId: String) async -> VerdiktRunDto? {
        await taskSliceAction({ (_: VerdiktRunDto) in "Sent to Verdikt" }) { base, _, actor in
            try await api.triggerVerdikt(base, taskId, actor: actor)
        }
    }
}

// MARK: - close implications + deliverables (Task2 slice)

/// One file picked on the phone, ready to attach as a deliverable.
struct DeliverableUpload: Sendable {
    let fileName: String
    let data: Data
}

extension AppModel {

    /// The close confirm's blast radius; nil (generic copy) when the read fails or is slow.
    func fetchCloseImplications(_ taskId: String) async -> CloseImplicationsDto? {
        guard let t = taskSliceTarget else { return nil }
        return try? await api.closeImplications(t.base, taskId)
    }

    func fetchDeliverables(_ taskId: String) async throws -> DeliverableListDto? {
        guard let t = taskSliceTarget else { return nil }
        return try await api.taskDeliverables(t.base, taskId)
    }

    func fetchDeliverable(_ taskId: String, _ did: String) async throws -> DeliverableDto? {
        guard let t = taskSliceTarget else { return nil }
        return try await api.taskDeliverable(t.base, taskId, did)
    }

    func fetchDeliverableText(_ taskId: String, _ did: String, version: Int) async throws -> DeliverableTextDto? {
        guard let t = taskSliceTarget else { return nil }
        return try await api.deliverableText(t.base, taskId, did, version: version)
    }

    func fetchDeliverableRaw(_ taskId: String, _ did: String, version: Int) async throws -> Data? {
        guard let t = taskSliceTarget else { return nil }
        return try await api.deliverableRaw(t.base, taskId, did, version: version)
    }

    func fetchDeliverableDiff(_ taskId: String, _ did: String, from: Int, to: Int) async throws -> DeliverableDiffDto? {
        guard let t = taskSliceTarget else { return nil }
        return try await api.deliverableDiff(t.base, taskId, did, from: from, to: to)
    }

    /// Attach files to a task (human actor). Returns true when at least one landed.
    /// Per-file failures surface in `error`; the summary goes to `toast` (web wording).
    func uploadDeliverables(_ taskId: String, _ files: [DeliverableUpload]) async -> Bool {
        guard let sel = selectedContainer, !files.isEmpty else { return false }
        guard let actor = sel.humanAgentId else {
            error = "Pairing is missing the human identity. Reconnect this Embodent first."
            return false
        }
        actionInFlight = true
        error = nil
        defer { actionInFlight = false }
        var added = 0
        var unchanged = 0
        for file in files {
            do {
                let r = try await api.uploadDeliverable(
                    sel.baseUrl, taskId, actor: actor,
                    fileName: file.fileName,
                    mimeType: DeliverableUx.mimeType(for: file.fileName),
                    data: file.data
                )
                if r.deduplicated { unchanged += 1 } else { added += 1 }
            } catch {
                let detail = (error as? OrchaApiError).flatMap { DeliverableUx.serverDetail($0.body) }
                self.error = "Couldn't attach \(file.fileName) — \(detail ?? friendly(error))"
            }
        }
        guard added + unchanged > 0 else { return false }
        toast = DeliverableUx.uploadToast(added: added, unchanged: unchanged)
        return true
    }
}
