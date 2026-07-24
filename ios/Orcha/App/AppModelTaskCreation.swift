import Foundation
import Observation

// Responsibility: Task creation plus shared run-feed and user-facing error helpers.

extension AppModel {
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

    /// Classify a FINISHED run's buffered SSE text into typed feed rows (Android
    /// `feedFromStreamText`): parse each frame via `OrchaApiClient.parseSseEvent`, drop
    /// reconnect-replay with `seq > maxSeq`, classify each line, and cap at 400 rows.
    static func feedFromStreamText(_ text: String) -> [RunFeedRow] {
        var rows: [RunFeedRow] = []
        var maxSeq = 0
        for raw in text.split(separator: "\n", omittingEmptySubsequences: false) {
            switch OrchaApiClient.parseSseEvent(String(raw)) {
            case let .line(seq, line):
                if seq > maxSeq {
                    maxSeq = seq
                    rows.append(contentsOf: RunFeed.classifyLine(line))
                }
            case let .done(_, status):
                rows.append(RunFeedRow(type: "done", label: "run-complete", text: status))
            case .none:
                break
            }
        }
        if rows.count > 400 { rows.removeFirst(rows.count - 400) }
        return rows
    }

    func friendly(_ error: Error) -> String {
        if let e = error as? OrchaServerAddress.AddressError {
            return e.localizedDescription
        }
        if let e = error as? OrchaApiError {
            return e.localizedDescription
        }
        return "Could not reach Orcha at this address. Check that Orcha is running and your phone is on the same Wi-Fi."
    }
}
