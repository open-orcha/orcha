import SwiftUI

/// Live chat streaming (web `Conversation` parity): while a reply is in flight, find the
/// agent's running run and follow its SSE stream (`…/runs/{rid}/stream`) so what the
/// agent is doing shows the moment it happens; when the stream reports the run done,
/// pull the durable reply turn at once instead of waiting for the next poll. The
/// existing reply-watch poll in `AppModel` keeps running underneath as the fallback.
@MainActor
@Observable
final class ChatRunStream {
    /// The latest classified rows of the live run (newest last, capped).
    private(set) var rows: [RunFeedRow] = []
    private(set) var liveRunId: String?

    private static let maxRows = 4

    /// Runs until cancelled (owned by a `.task(id:)` that flips with "awaiting a reply").
    func follow(model: AppModel, agentId: String) async {
        rows = []
        liveRunId = nil
        guard let base = model.selectedContainer?.baseUrl else { return }
        while !Task.isCancelled {
            guard let runId = await findLiveRun(model: model, base: base, agentId: agentId) else {
                try? await Task.sleep(for: .seconds(2))
                continue
            }
            liveRunId = runId
            var finished = false
            do {
                for try await event in model.api.runStream(base, agentId, runId) {
                    switch event {
                    case let .line(_, text):
                        append(RunFeed.classifyLine(text))
                    case let .done(_, status):
                        // The 30-min server cap closes the stream on a run still going: reopen.
                        finished = status != "stream_timeout"
                    }
                }
            } catch {
                // Transport hiccup: fall back to the poll; retry the stream shortly.
            }
            if Task.isCancelled { return }
            if finished {
                liveRunId = nil
                await settle(model: model, agentId: agentId)
                rows = []
                return
            }
            try? await Task.sleep(for: .seconds(1))
        }
    }

    /// The agent's running run (a conversation run preferred), or nil.
    private func findLiveRun(model: AppModel, base: String, agentId: String) async -> String? {
        // The runs read is fresh; the snapshot's `active_run` (30 s poll) is only the fallback.
        guard let runs = try? await model.api.agentRuns(base, agentId, limit: 3).runs else {
            return model.snapshot?.agents.first { $0.id == agentId }?.activeRun?.runId
        }
        let running = runs.filter { $0.status == "running" }
        return (running.first { $0.wakeEvent == "conversation_turn" } ?? running.first)?.runId
    }

    /// The run ended: its reply turn is posted as it finishes — read it now, and a few
    /// more times over ~5 s in case it lands a beat later.
    private func settle(model: AppModel, agentId: String) async {
        for _ in 0..<5 where !Task.isCancelled {
            let before = model.turns.last?.seq
            await model.refreshConversationDelta(agentId, quiet: true)
            if model.turns.last?.seq != before { return }
            try? await Task.sleep(for: .seconds(1))
        }
    }

    private func append(_ new: [RunFeedRow]) {
        let visible = new.filter { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.type != "boot" }
        guard !visible.isEmpty else { return }
        rows = Array((rows + visible).suffix(Self.maxRows))
    }

    /// One-line status for the "Working…" row: the newest meaningful step.
    var headline: String? {
        guard let row = rows.last else { return nil }
        let text = row.text.replacingOccurrences(of: "\n", with: " ")
        return text.count > 120 ? String(text.prefix(117)) + "…" : text
    }
}

/// The streamed steps under the live "Working…" row (older ones above, faded).
struct ChatLiveSteps: View {
    @Environment(\.palette) private var p
    let rows: [RunFeedRow]

    var body: some View {
        if rows.count > 1 {
            VStack(alignment: .leading, spacing: 3) {
                ForEach(Array(rows.dropLast().enumerated()), id: \.offset) { _, row in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Image(systemName: icon(row.type))
                            .font(.system(size: 9, weight: .semibold))
                            .accessibilityHidden(true)
                        Text(row.text.replacingOccurrences(of: "\n", with: " "))
                            .ltype(.micro)
                            .lineLimit(1)
                    }
                    .foregroundStyle(p.faint)
                }
            }
            .padding(.leading, 26)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Recent steps")
        }
    }

    private func icon(_ type: String) -> String {
        switch type {
        case "tool": "wrench.and.screwdriver"
        case "think": "brain"
        case "result": "checkmark"
        case "error": "exclamationmark.triangle"
        default: "text.bubble"
        }
    }
}
