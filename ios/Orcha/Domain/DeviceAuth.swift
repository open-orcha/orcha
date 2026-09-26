import Foundation

/// The QR → GitHub OAuth device-token contract (orcha-cloud): the pure URL
/// logic on both edges of the browser round-trip, kept free of session/UI
/// concerns so it is directly testable.
///
/// Outbound: `https://<host>/oauth2/start?rd=%2Fauth%2Fdevice` — oauth2-proxy
/// runs GitHub OAuth, then the authenticated portal page `/auth/device` mints
/// a per-device token. Inbound: that page redirects to
/// `orcha://auth/callback?host=<host>&token=<token>`, which the
/// ASWebAuthenticationSession intercepts and hands back as a URL.
enum DeviceAuth {
    /// The registered custom scheme the auth session watches for.
    static let callbackScheme = "orcha"

    /// The minted credential handed back by the portal's device page.
    struct Callback: Equatable {
        let host: String
        let token: String
    }

    /// The browser entry point for a protected deployment: its oauth2-proxy
    /// start URL, returning to the portal's device-token page. Built as a
    /// string so `rd` stays exactly `%2Fauth%2Fdevice` — the encoded form the
    /// proxy expects, which URLComponents would leave as literal slashes.
    static func startURL(forBase base: String) -> URL? {
        URL(string: base + "/oauth2/start?rd=%2Fauth%2Fdevice")
    }

    /// True for any `orcha://auth/...` URL — the sub-namespace owned by this
    /// flow. `onOpenURL` must swallow these rather than route them as deep
    /// links: the live session consumes the callback itself, so one arriving
    /// at the app is a stray (stale browser tab after the session closed).
    static func isAuthCallback(_ url: URL) -> Bool {
        url.scheme?.lowercased() == callbackScheme && url.host?.lowercased() == "auth"
    }

    /// Parse `orcha://auth/callback?host=<host>&token=<token>`; nil for
    /// anything else — wrong scheme/host/path, missing or empty parameters.
    static func parseCallback(_ url: URL) -> Callback? {
        guard isAuthCallback(url), url.path == "/callback",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
        else { return nil }
        func value(_ name: String) -> String? {
            let raw = items.first { $0.name == name }?.value?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return (raw?.isEmpty ?? true) ? nil : raw
        }
        guard let host = value("host"), let token = value("token") else { return nil }
        return Callback(host: host, token: token)
    }

    /// The minted token is only ever attached to the deployment the flow
    /// started against: the callback's `host` must name the same host as the
    /// pending base URL. Lenient about the shapes a server might send —
    /// bare host, host:port, or a full URL — strict about the host itself.
    static func callback(_ callback: Callback, matchesBase base: String) -> Bool {
        guard let baseHost = URL(string: base)?.host?.lowercased() else { return false }
        let raw = callback.host.lowercased()
        let candidate = raw.contains("://")
            ? URL(string: raw)?.host
            : raw.split(separator: ":").first.map(String.init)
        return candidate == baseHost
    }
}
