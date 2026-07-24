import Foundation

// Responsibility: URL construction, JSON transport, and API error reporting.

extension OrchaApiClient {
    // MARK: plumbing

    func url(_ base: String, _ path: String) throws -> URL {
        guard let url = URL(string: base + path) else { throw URLError(.badURL) }
        return url
    }

    /// Build a `?a=1&b=2` suffix, dropping nil values and percent-encoding each value
    /// (ISO cursors carry `:`/`+` — over-encode to a conservative unreserved set).
    func query(_ items: [String: String?]) -> String {
        let pairs = items
            .sorted { $0.key < $1.key }
            .compactMap { key, value -> String? in
                guard let value else { return nil }
                let encoded = value.addingPercentEncoding(withAllowedCharacters: .orchaQueryValue) ?? value
                return "\(key)=\(encoded)"
            }
        return pairs.isEmpty ? "" : "?" + pairs.joined(separator: "&")
    }

    func raw(_ base: String, _ path: String) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(from: url(base, path))
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200..<300).contains(http.statusCode) else {
            throw OrchaApiError(status: http.statusCode, body: String(decoding: data.prefix(300), as: UTF8.self))
        }
        return (data, http)
    }

    func get<T: Decodable>(_ base: String, _ path: String) async throws -> T {
        let (data, _) = try await raw(base, path)
        return try decoder.decode(T.self, from: data)
    }

    func send(_ base: String, _ path: String, method: String, _ body: [String: Any?]) async throws -> Data {
        var request = URLRequest(url: try url(base, path))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let cleaned = body.compactMapValues { $0 }
        request.httpBody = try JSONSerialization.data(withJSONObject: cleaned)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200..<300).contains(http.statusCode) else {
            throw OrchaApiError(status: http.statusCode, body: String(decoding: data.prefix(300), as: UTF8.self))
        }
        return data
    }

    func post(_ base: String, _ path: String, _ body: [String: Any?]) async throws {
        _ = try await send(base, path, method: "POST", body)
    }

    func postDecoding<T: Decodable>(_ base: String, _ path: String, _ body: [String: Any?]) async throws -> T {
        let data = try await send(base, path, method: "POST", body)
        return try decoder.decode(T.self, from: data)
    }

    func patch(_ base: String, _ path: String, _ body: [String: Any?]) async throws {
        _ = try await send(base, path, method: "PATCH", body)
    }
}

private extension CharacterSet {
    /// Conservative unreserved set for query VALUES — encodes `:`, `+`, `&`, `=`, space, etc.
    static let orchaQueryValue = CharacterSet(charactersIn:
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
}

struct OrchaApiError: LocalizedError {
    let status: Int
    let body: String

    var errorDescription: String? {
        switch status {
        case 403: "This action is not allowed for the paired human."
        case 409: "Orcha rejected this action because the item changed. Refresh and try again."
        case 422: "Orcha needs more information for this action."
        default: "Orcha answered with an error (\(status))."
        }
    }
}
