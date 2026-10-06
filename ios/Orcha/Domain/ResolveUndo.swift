import Foundation
import Observation

/// One-tap Resolve with Undo for an answered question (web `pages/requests/resolveUndo.ts`).
///
/// The backend has no "reopen", and a close wakes the answering agent, so Undo can't be a
/// second write. The close is DEFERRED instead: the request leaves the queues at once, the
/// card and a toast offer Undo for `window`, and only then is `POST /api/requests/{id}/close`
/// sent. App-wide (not view state) so leaving the screen inside the window still resolves.
@MainActor
@Observable
final class ResolveUndoQueue {
    static let shared = ResolveUndoQueue()
    static let window: Duration = .seconds(5)

    /// Request ids inside their undo window.
    private(set) var pending: Set<String> = []
    @ObservationIgnored private var tasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var sends: [String: @MainActor () async -> Void] = [:]
    @ObservationIgnored private let delay: Duration

    init(delay: Duration = ResolveUndoQueue.window) {
        self.delay = delay
    }

    func isResolving(_ id: String) -> Bool { pending.contains(id) }

    /// Schedule `send` for request `id`; it runs after the window unless undone.
    func schedule(_ id: String, send: @escaping @MainActor () async -> Void) {
        tasks[id]?.cancel()
        pending.insert(id)
        sends[id] = send
        tasks[id] = Task { [weak self, delay] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled, let self else { return }
            self.pending.remove(id)
            self.tasks[id] = nil
            self.sends[id] = nil
            await send()
        }
    }

    /// Cancel a scheduled resolve. True when there was one to cancel.
    @discardableResult
    func undo(_ id: String) -> Bool {
        guard let task = tasks.removeValue(forKey: id) else { return false }
        task.cancel()
        sends[id] = nil
        pending.remove(id)
        return true
    }

    /// Send every pending close now — the web flushes on page hide; the app does it when
    /// it moves to the background, so a resolve inside its undo window is never lost.
    func flushAll() async {
        let due = sends
        for (id, task) in tasks { task.cancel(); tasks[id] = nil }
        sends.removeAll()
        pending.removeAll()
        for send in due.values { await send() }
    }
}
