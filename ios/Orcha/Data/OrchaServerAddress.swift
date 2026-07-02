import Foundation

/// Normalizes user-entered addresses / pairing payloads to a base URL, with the
/// same guards as the Android client (localhost points at the phone, not the laptop).
enum OrchaServerAddress {
    enum AddressError: LocalizedError {
        case localhost
        case invalid
        case notPairingCode

        var errorDescription: String? {
            switch self {
            case .localhost:
                "Use your computer's Wi-Fi address instead of localhost. Localhost points at the phone."
            case .invalid:
                "That doesn't look like an address. Try something like 192.168.1.24:8001."
            case .notPairingCode:
                "That's not an Orcha pairing code."
            }
        }
    }

    /// The scanned/pasted `orcha-pair` QR payload (portal
    /// `GET /api/containers/{cid}/pairing`). The `humanAgentId` disambiguates which
    /// operator the phone acts as when a container has several humans; `token` is the
    /// short-lived pairing token (device-token exchange is the A2 follow-up).
    struct Payload {
        let baseUrl: String
        let containerId: String?
        let humanAgentId: String?
        let humanAgentAlias: String?
        let token: String?
    }

    /// Parse a raw scan/paste into either a plain normalized base URL or a full pairing
    /// payload. A leading `{` means an `orcha-pair` JSON code; anything else is treated
    /// as a `host:port` / URL and only its base URL is captured.
    static func parse(_ raw: String) throws -> Payload {
        let input = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !input.isEmpty else { throw AddressError.invalid }

        if input.hasPrefix("{") {
            guard
                let data = input.data(using: .utf8),
                let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { throw AddressError.notPairingCode }
            if let kind = obj["kind"] as? String, kind != "orcha-pair" {
                throw AddressError.notPairingCode
            }
            guard let base = obj["baseUrl"] as? String else { throw AddressError.notPairingCode }
            return Payload(
                baseUrl: try normalizeBaseURL(base),
                containerId: obj["containerId"] as? String,
                humanAgentId: obj["humanAgentId"] as? String,
                humanAgentAlias: obj["humanAgentAlias"] as? String,
                token: obj["token"] as? String
            )
        }
        return Payload(baseUrl: try normalizeBaseURL(input), containerId: nil, humanAgentId: nil, humanAgentAlias: nil, token: nil)
    }

    /// Back-compat: just the normalized base URL (host:port / URL / pairing JSON).
    static func normalize(_ raw: String) throws -> String {
        try parse(raw).baseUrl
    }

    private static func normalizeBaseURL(_ raw: String) throws -> String {
        var input = raw
        if !input.hasPrefix("http://") && !input.hasPrefix("https://") {
            input = "http://" + input
        }
        guard let url = URL(string: input), let host = url.host, !host.isEmpty else {
            throw AddressError.invalid
        }
        if host == "localhost" || host == "127.0.0.1" || host == "::1" {
            throw AddressError.localhost
        }
        var normalized = "\(url.scheme ?? "http")://\(host)"
        if let port = url.port {
            normalized += ":\(port)"
        }
        return normalized
    }
}
