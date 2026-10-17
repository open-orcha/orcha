import Foundation

/// Inbox slice endpoints: request extras (mig 065 split + auto-resolve), notification
/// preferences (mig 063) and routines. Reads reuse the shared `get`; writes go through
/// `inboxSend`, a local twin of the client's private `send` (same bearer + perimeter rules)
/// so this slice never edits the shared client file.
extension OrchaApiClient {

    // MARK: requests

    /// The container's request rows (with `detail`, `agent_payload`, close attribution).
    func inboxRequestExtras(_ base: String, _ cid: String, status: String?, limit: Int = 100) async throws -> InboxRequestListResponse {
        try await get(base, "/api/containers/\(cid)/requests" + query([
            "status": status,
            "limit": String(limit),
        ]))
    }

    // MARK: notification preferences

    func notificationPrefs(_ base: String, _ cid: String, actor: String?) async throws -> NotificationPrefsDto {
        try await get(base, "/api/containers/\(cid)/notification-prefs" + query(["actor_agent_id": actor]))
    }

    /// PUT the project override. `rules` REPLACES the stored override, so callers send the
    /// whole map. Pass nil to leave a field untouched.
    func putProjectNotificationPrefs(
        _ base: String, _ cid: String, actor: String?,
        rules: [String: NotifPartialRule]?, muted: Bool?
    ) async throws -> NotificationPrefsDto {
        var body: [String: Any] = [:]
        if let actor { body["actor_agent_id"] = actor }
        if let rules { body["rules"] = try Self.jsonObject(rules) }
        if let muted { body["muted"] = muted }
        return try await inboxSend(base, "/api/containers/\(cid)/notification-prefs", method: "PUT", body: body)
    }

    /// The person's defaults: pause/snooze and quiet hours. `.some(nil)` sends JSON null
    /// (turn off); `nil` leaves the field out.
    func putDefaultNotificationPrefs(
        _ base: String, _ cid: String, actor: String?,
        pause: NotifPause??, quietHours: NotifQuietHours??
    ) async throws -> NotificationPrefsDto {
        var body: [String: Any] = [:]
        if let actor { body["actor_agent_id"] = actor }
        if let pause {
            body["pause"] = try pause.map { try Self.jsonObject($0) } ?? NSNull()
        }
        if let quietHours {
            body["quiet_hours"] = try quietHours.map { try Self.jsonObject($0) } ?? NSNull()
        }
        return try await inboxSend(base, "/api/containers/\(cid)/notification-prefs/defaults", method: "PUT", body: body)
    }

    /// Drop this project's override — it follows the defaults again.
    func resetProjectNotificationPrefs(_ base: String, _ cid: String, actor: String?) async throws -> NotificationPrefsDto {
        try await inboxSend(base, "/api/containers/\(cid)/notification-prefs" + query(["actor_agent_id": actor]), method: "DELETE", body: nil)
    }

    // MARK: routines

    func routines(_ base: String, _ cid: String) async throws -> RoutineListResponse {
        try await get(base, "/api/containers/\(cid)/routines")
    }

    func routineRuns(_ base: String, _ rid: String, limit: Int = 25) async throws -> RoutineRunsResponse {
        try await get(base, "/api/routines/\(rid)/runs" + query(["limit": String(limit)]))
    }

    func setRoutineEnabled(_ base: String, _ rid: String, actor: String?, enabled: Bool) async throws -> RoutineDto {
        var body: [String: Any] = ["enabled": enabled]
        if let actor { body["actor_agent_id"] = actor }
        return try await inboxSend(base, "/api/routines/\(rid)", method: "PATCH", body: body)
    }

    func runRoutineNow(_ base: String, _ rid: String, actor: String?) async throws -> RoutineRunResult {
        var body: [String: Any] = [:]
        if let actor { body["actor_agent_id"] = actor }
        return try await inboxSend(base, "/api/routines/\(rid)/run", method: "POST", body: body)
    }

    func deleteRoutine(_ base: String, _ rid: String, actor: String?) async throws {
        let _: InboxEmpty = try await inboxSend(base, "/api/routines/\(rid)" + query(["actor_agent_id": actor]), method: "DELETE", body: nil)
    }

    // MARK: plumbing

    static func jsonObject<T: Encodable>(_ value: T) throws -> Any {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(value), options: [.fragmentsAllowed])
    }

    private func inboxSend<T: Decodable>(_ base: String, _ path: String, method: String, body: [String: Any]?) async throws -> T {
        guard let url = URL(string: base + path) else { throw URLError(.badURL) }
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.httpMethod = method
        if let token = BearerTokens.token(for: base) {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        if Self.perimeterIntercepted(
            status: http.statusCode,
            contentType: http.value(forHTTPHeaderField: "Content-Type"),
            body: data
        ) {
            throw OrchaAuthRequiredError()
        }
        guard (200..<300).contains(http.statusCode) else {
            throw OrchaApiError(status: http.statusCode, body: String(decoding: data.prefix(300), as: UTF8.self))
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}

/// Any JSON object body we don't need to read.
struct InboxEmpty: Decodable {}

/// A failed write, in plain words — the server's 422 `detail` is already plain
/// ("pause must end in the future"), so show it; never a status code or raw JSON.
enum InboxErrorText {
    static func describe(_ error: Error) -> String {
        if let api = error as? OrchaApiError {
            if let data = api.body.data(using: .utf8),
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let detail = obj["detail"] as? String, !detail.isEmpty,
               !detail.hasPrefix("{"), !detail.hasPrefix("[") {
                return detail.prefix(1).uppercased() + detail.dropFirst()
            }
            return api.errorDescription ?? "Embodent refused the change."
        }
        if error is OrchaAuthRequiredError { return error.localizedDescription }
        return "Embodent couldn't be reached."
    }
}
