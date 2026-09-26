import Foundation
import os

/// Process-wide map of base URL → bearer credential for deployments behind an
/// auth perimeter (orcha-cloud: Caddy's iOS/API lane matches
/// `Authorization: Bearer <team token>` exactly; anything else is bounced to
/// browser OAuth). The registry is a pure projection of the persisted
/// containers — `ContainerStore.load()`/`save()` rebuild it — so every
/// `OrchaApiClient` request, including background notification sweeps and the
/// local↔remote failover path, resolves the right credential from just the
/// base URL it already carries. Lock-guarded because the client is used from
/// the MainActor model and from BGAppRefresh sweeps alike.
enum BearerTokens {
    private static let state = OSAllocatedUnfairLock(initialState: [String: String]())

    /// The credential to attach for this base URL, or nil for unprotected
    /// (self-host / dev) servers.
    static func token(for base: String) -> String? {
        state.withLock { $0[base] }
    }

    /// Rebuild the whole registry from the persisted containers. Each
    /// container's token registers under BOTH its addresses, so the remote
    /// failover keeps authenticating after the address swap.
    static func rebuild(from containers: [StoredContainer]) {
        state.withLock { map in
            map = [:]
            for container in containers {
                guard let token = container.accessToken, !token.isEmpty else { continue }
                map[container.baseUrl] = token
                if let remote = container.remoteBaseUrl, !remote.isEmpty {
                    map[remote] = token
                }
            }
        }
    }
}
