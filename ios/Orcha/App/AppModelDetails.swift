import Foundation
import Observation

// Responsibility: Task, agent, run-log, and conversation detail loading.

extension AppModel {
    // MARK: detail loads

    /// Issue 4: load the NEWEST page of the thread (keyset), not the whole thread. The older
    /// pages are revealed on demand via `loadEarlierThreadMessages`.
    func loadTaskDetail(_ taskId: String) async {
        guard let sel = selectedContainer else { return }
        do {
            let page = try await api.taskMessages(sel.baseUrl, taskId, limit: 20)
            taskMessages = page.messages
            threadHasMore = page.hasMore
            threadNextBefore = page.nextBefore
            threadNextBeforeId = page.nextBeforeId
            taskRuns = try await api.taskRuns(sel.baseUrl, taskId).runs
        } catch {
            self.error = friendly(error)
        }
    }

    /// Issue 4: "Load earlier" — fetch the next older keyset page and PREPEND it (messages come
    /// back ASC; dedup at the seam). Must not disturb the reader's scroll to the bottom.
    func loadEarlierThreadMessages(_ taskId: String) async {
        guard let sel = selectedContainer, threadHasMore, !threadLoadingEarlier,
              let before = threadNextBefore, let beforeId = threadNextBeforeId else { return }
        threadLoadingEarlier = true
        defer { threadLoadingEarlier = false }
        do {
            let page = try await api.taskMessages(sel.baseUrl, taskId, limit: 20, before: before, beforeId: beforeId)
            taskMessages = MobileUx.prependMessages(page.messages, before: taskMessages)
            threadHasMore = page.hasMore
            threadNextBefore = page.nextBefore
            threadNextBeforeId = page.nextBeforeId
        } catch {
            self.error = friendly(error)
        }
    }

    /// Issue 4: after posting, re-fetch only the newest page and merge in the new message(s),
    /// instead of re-fetching the whole thread.
    func reloadNewestThreadPage(_ taskId: String) async {
        guard let sel = selectedContainer else { return }
        do {
            let page = try await api.taskMessages(sel.baseUrl, taskId, limit: 20)
            let have = Set(taskMessages.compactMap { $0.messageId })
            let fresh = page.messages.filter { m in m.messageId.map { !have.contains($0) } ?? true }
            taskMessages.append(contentsOf: fresh)
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

    /// Issue 3: start showing a run's log. A RUNNING run is consumed incrementally over SSE
    /// (never a buffered one-shot that would time out); a finished run keeps the one-shot fetch.
    func startRunLog(_ run: RunDto) {
        stopRunLogStream()
        lastRunSeq = -1
        runFeed = []
        runStreamNote = nil
        error = nil
        if run.status == "running" {
            streamRunLog(run)
        } else {
            Task { await loadRunLog(run) }
        }
    }

    /// Cancel the live collector (leaving RunDetailScreen, or before a one-shot refresh).
    func stopRunLogStream() {
        runStreamTask?.cancel()
        runStreamTask = nil
        runLogStreaming = false
    }

    private func streamRunLog(_ run: RunDto) {
        guard let sel = selectedContainer, let aid = run.agentId else { return }
        runLogStreaming = true
        runStreamTask = Task { [weak self] in
            guard let self else { return }
            var attempt = 0
            while !Task.isCancelled {
                do {
                    streaming: for try await event in api.runStream(sel.baseUrl, aid, run.runId) {
                        if Task.isCancelled { return }
                        switch event {
                        case let .line(seq, text):
                            appendRunRows(seq: seq, text: text)
                            attempt = 0
                        case let .done(_, status):
                            if status == "stream_timeout" {
                                break streaming          // server 30-min cap — reopen, run still live
                            }
                            appendFeed([RunFeedRow(type: "done", label: "run-complete", text: status)])
                            runStreamNote = nil
                            runLogStreaming = false
                            await refresh()              // sync the run row elsewhere in the UI
                            return
                        }
                    }
                    attempt = 0                          // clean close / timeout → reopen shortly
                } catch {
                    if Task.isCancelled { return }
                    attempt = min(attempt + 1, 5)
                    runStreamNote = "Log stream interrupted — reconnecting…"
                }
                if Task.isCancelled { return }
                try? await Task.sleep(for: .seconds(attempt == 0 ? 0.3 : Double(attempt)))
            }
        }
    }

    /// Append a streamed line: web's monotonic-`seq` dedup → classify into typed rows →
    /// skip-empty guard → append + 400-row cap → clear the interruption note (only inside a
    /// non-empty update, matching Android VM:522-526).
    private func appendRunRows(seq: Int, text: String) {
        if seq >= 0 {
            guard seq > lastRunSeq else { return }
            lastRunSeq = seq
        }
        let rows = RunFeed.classifyLine(text)
        guard !rows.isEmpty else { return }
        appendFeed(rows)
        runStreamNote = nil
    }

    /// Append rows with the shared 400-row retention cap (classify happens at append, never render).
    private func appendFeed(_ rows: [RunFeedRow]) {
        runFeed.append(contentsOf: rows)
        if runFeed.count > 400 { runFeed.removeFirst(runFeed.count - 400) }
    }

    /// One-shot read for a FINISHED run (server closes the stream immediately).
    func loadRunLog(_ run: RunDto) async {
        guard let sel = selectedContainer, let aid = run.agentId else { return }
        loading = true
        defer { loading = false }
        do {
            let text = try await api.runStreamText(sel.baseUrl, aid, run.runId)
            runFeed = Self.feedFromStreamText(text)
        } catch {
            self.error = friendly(error)
        }
    }

    /// Issue 4: initial mount pulls the most-recent window (?limit=80); the screen reveals
    /// older turns client-side. Refreshes delta-append via `after_seq` (see below).
    func loadConversation(_ agentId: String) async {
        guard let sel = selectedContainer else { return }
        do {
            let response = try await api.conversation(sel.baseUrl, agentId, limit: 80)
            conversation = response.conversation
            turns = response.turns
        } catch {
            self.error = friendly(error)
        }
    }

    /// Issue 4: append only the turns created after the last-held seq, instead of full-replacing
    /// the transcript (web parity, `conversation.js:586`). Falls back to a full load if unmounted.
    func refreshConversationDelta(_ agentId: String) async {
        guard let sel = selectedContainer, let conv = conversation else {
            await loadConversation(agentId)
            return
        }
        do {
            let lastSeq = turns.map(\.seq).max() ?? 0
            let delta = try await api.conversationTurns(sel.baseUrl, conv.id, afterSeq: lastSeq, limit: 50).turns
            turns = MobileUx.appendTurns(turns, delta: delta)
        } catch {
            self.error = friendly(error)
        }
    }
}
