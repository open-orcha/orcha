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
                "That doesn't look like an address. Try something like orcha.yourteam.com or 192.168.1.24:8001."
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
        /// Optional second address the portal may include in the QR (typically the
        /// computer's Tailscale name/IP) — stored as the container's remote address
        /// so one scan configures the local↔remote failover. Absent in older
        /// payloads and manual entry.
        let remoteBaseUrl: String?
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
            // Tolerant: a malformed remote address degrades to local-only pairing
            // rather than failing the scan.
            let remote = (obj["remoteBaseUrl"] as? String).flatMap { try? normalizeBaseURL($0) }
            return Payload(
                baseUrl: try normalizeBaseURL(base),
                containerId: obj["containerId"] as? String,
                humanAgentId: obj["humanAgentId"] as? String,
                humanAgentAlias: obj["humanAgentAlias"] as? String,
                token: obj["token"] as? String,
                remoteBaseUrl: remote
            )
        }
        return Payload(baseUrl: try normalizeBaseURL(input), containerId: nil, humanAgentId: nil, humanAgentAlias: nil, token: nil, remoteBaseUrl: nil)
    }

    /// Back-compat: just the normalized base URL (host:port / URL / pairing JSON).
    static func normalize(_ raw: String) throws -> String {
        try parse(raw).baseUrl
    }

    private static func normalizeBaseURL(_ raw: String) throws -> String {
        var input = raw
        if !input.hasPrefix("http://") && !input.hasPrefix("https://") {
            input = defaultScheme(for: input) + "://" + input
        }
        guard let url = URL(string: input), let host = url.host, !host.isEmpty else {
            throw AddressError.invalid
        }
        if host == "localhost" || host == "127.0.0.1" || host == "::1" {
            throw AddressError.localhost
        }
        var normalized = "\(url.scheme ?? "https")://\(host)"
        if let port = url.port {
            normalized += ":\(port)"
        }
        return normalized
    }

    /// Cloud-first default for scheme-less input: a bare domain with no port is
    /// almost always the deployed portal behind TLS → https (so
    /// `orcha.yourteam.com` just works). An IP, a bare LAN hostname, or an
    /// explicit port is the self-host shape → http, matching how those portals
    /// actually listen. Typing the scheme always wins.
    private static func defaultScheme(for input: String) -> String {
        guard let authority = input.split(separator: "/").first else { return "https" }
        if authority.contains(":") { return "http" }        // explicit port → self-host
        let host = String(authority)
        if !host.contains(".") { return "http" }            // bare LAN hostname
        if CharacterSet(charactersIn: host).isSubset(of: CharacterSet(charactersIn: "0123456789.")) {
            return "http"                                   // dotted-decimal IP
        }
        return "https"
    }
}
