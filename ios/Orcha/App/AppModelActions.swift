import Foundation
import Observation

// Responsibility: Human-authorized task, request, agent, conversation, and run actions.

extension AppModel {
    // MARK: human actions

    @discardableResult
    func humanAction(_ success: String, _ block: (String, String) async throws -> Void) async -> Bool {
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
            await reloadNewestThreadPage(taskId)
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

    /// GH #148 — the notifier kill-switch. Independent of `setAutonomy`: flipping this never
    /// changes the remembered autonomy level.
    func setWakes(enabled: Bool) async -> Bool {
        guard let cid = selectedContainer?.id else { return false }
        return await humanAction(enabled ? "Notifier resumed" : "Notifier paused") { base, actor in
            try await api.setWakes(base, cid, actor: actor, enabled: enabled)
            await refresh()
        }
    }

    /// GH #148 — the autonomy gearbox. Independent of `setWakes`: the level applies whether or
    /// not the notifier is currently running.
    func setAutonomy(level: String) async -> Bool {
        guard let cid = selectedContainer?.id else { return false }
        return await humanAction("Autonomy set to \(MobileUx.autonomyLabel(level))") { base, actor in
            try await api.setAutonomy(base, cid, actor: actor, level: level)
            await refresh()
        }
    }

    /// Flow 07a: the toast is state-aware — a real wake names the woken agent, while the
    /// `{nudged:false}` no-op (a human owns the next action) is informational, not an error.
    func nudgeRequest(_ rid: String, note: String?) async -> Bool {
        guard let sel = selectedContainer else { return false }
        guard let actor = sel.humanAgentId else {
            error = "Pairing is missing the human identity. Reconnect this Orcha first."
            return false
        }
        actionInFlight = true
        error = nil
        defer { actionInFlight = false }
        do {
            let result = try await api.nudgeRequest(sel.baseUrl, rid, actor: actor, note: note)
            toast = nudgeToast(result)
            await refresh()
            return true
        } catch {
            self.error = friendly(error)
            return false
        }
    }

    private func nudgeToast(_ r: NudgeResult) -> String {
        guard r.nudged else { return "No agent to wake — a human owns the next action." }
        if let alias = MobileUx.aliasFor(r.nudgedAgentId, in: snapshot?.agents ?? []) {
            return "Nudged \(alias)"
        }
        if let role = r.nudgedRole { return "Nudged the \(role)" }
        return "Nudge sent"
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
            await refreshConversationDelta(agentId)
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
            stopRunLogStream()               // the run is closing — end the live collector
            await loadRunLog(run)            // one-shot now returns the full final log
        }
    }
}
