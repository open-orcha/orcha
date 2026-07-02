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

    /// Accepts `host:port`, full http(s) URLs, or an `orcha-pair` JSON payload.
    static func normalize(_ raw: String) throws -> String {
        var input = raw.trimmingCharacters(in: .whitespacesAndNewlines)
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
            input = base
        }

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
