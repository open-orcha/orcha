import Foundation
import Testing
@testable import Orcha

/// Cloud adaptation (orcha-cloud): bearer-credential resolution, the auth-perimeter
/// interception heuristics that turn an OAuth bounce into a "needs access token"
/// prompt (never a decode error), and the one-connection-many-projects store rules.

/// Serialized: `BearerTokens` is process-global by design (the API client resolves
/// it from any isolation), and `ContainerStore` operations rebuild it.
@Suite(.serialized) struct BearerTokensAndStoreTests {

    private func container(
        _ id: String, base: String, token: String?,
        remote: String? = nil, opened: Date = .now
    ) -> StoredContainer {
        StoredContainer(
            id: id, displayName: id, baseUrl: base,
            humanAgentId: nil, humanAlias: nil, pairingToken: nil,
            accessToken: token, remoteBaseUrl: remote, lastOpenedAt: opened
        )
    }

    /// An isolated defaults suite so store tests never touch real pairings.
    private func freshStore() -> ContainerStore {
        let name = "orcha-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return ContainerStore(defaults: defaults)
    }

    @Test func rebuildRegistersTokenUnderBothAddresses() {
        BearerTokens.rebuild(from: [
            container("c1", base: "https://orcha.example.com", token: "team-token", remote: "http://100.64.0.9:8001"),
            container("c2", base: "http://192.168.1.24:8001", token: nil),
        ])
        #expect(BearerTokens.token(for: "https://orcha.example.com") == "team-token")
        // The failover swap keeps authenticating: the remote address carries the token too.
        #expect(BearerTokens.token(for: "http://100.64.0.9:8001") == "team-token")
        // Self-host connections stay untokened.
        #expect(BearerTokens.token(for: "http://192.168.1.24:8001") == nil)
    }

    @Test func rebuildDropsForgottenConnections() {
        BearerTokens.rebuild(from: [container("c1", base: "https://a.example.com", token: "t1")])
        BearerTokens.rebuild(from: [])
        #expect(BearerTokens.token(for: "https://a.example.com") == nil)
    }

    @Test func storeSaveFeedsTheRegistry() {
        let store = freshStore()
        _ = store.upsert(container("c1", base: "https://orcha.example.com", token: "team-token"))
        #expect(BearerTokens.token(for: "https://orcha.example.com") == "team-token")
    }

    @Test func accessTokenAppliesToEveryProjectOnTheConnection() {
        let store = freshStore()
        _ = store.upsert(container("c1", base: "https://orcha.example.com", token: "old"))
        _ = store.upsert(container("c2", base: "https://orcha.example.com", token: "old"))
        _ = store.upsert(container("d1", base: "http://192.168.1.24:8001", token: nil))

        let next = store.setAccessToken("c1", to: "rotated")
        #expect(next.first { $0.id == "c1" }?.accessToken == "rotated")
        #expect(next.first { $0.id == "c2" }?.accessToken == "rotated")   // sibling project follows
        #expect(next.first { $0.id == "d1" }?.accessToken == nil)         // other connection untouched
        #expect(BearerTokens.token(for: "https://orcha.example.com") == "rotated")
    }

    @Test func removeConnectionForgetsAllItsProjects() {
        let store = freshStore()
        _ = store.upsert(container("c1", base: "https://orcha.example.com", token: "t"))
        _ = store.upsert(container("c2", base: "https://orcha.example.com", token: "t"))
        _ = store.upsert(container("d1", base: "http://192.168.1.24:8001", token: nil))

        let next = store.removeConnection(of: "c2")
        #expect(next.map(\.id) == ["d1"])
        #expect(BearerTokens.token(for: "https://orcha.example.com") == nil)
    }

    @Test func legacyStoredContainerDecodesWithoutAccessToken() throws {
        // Persisted pairings from the local-first builds carry no accessToken key.
        let legacy = #"{"id":"c1","displayName":"demo","baseUrl":"http://192.168.1.24:8001","pairingToken":"tok","lastOpenedAt":773094820.0}"#
        let decoded = try JSONDecoder().decode(StoredContainer.self, from: Data(legacy.utf8))
        #expect(decoded.accessToken == nil)
        #expect(decoded.pairingToken == "tok")
        #expect(decoded.baseUrl == "http://192.168.1.24:8001")
    }
}

@Suite struct AuthPerimeterTests {

    @Test func unauthorizedStatusIsIntercepted() {
        #expect(OrchaApiClient.perimeterIntercepted(status: 401, contentType: "application/json", body: Data()))
    }

    @Test func htmlSignInPageIsIntercepted() {
        // Wrong/missing bearer falls through to OAuth; URLSession follows the
        // redirects and lands on an HTML sign-in page with a 2xx status.
        #expect(OrchaApiClient.perimeterIntercepted(status: 200, contentType: "text/html; charset=utf-8", body: Data()))
        #expect(OrchaApiClient.perimeterIntercepted(status: 200, contentType: nil, body: Data("<!DOCTYPE html><html><head>".utf8)))
        #expect(OrchaApiClient.perimeterIntercepted(status: 200, contentType: nil, body: Data("  <html lang=\"en\">".utf8)))
        // Non-allowlisted GitHub user → oauth2-proxy's HTML 403 page.
        #expect(OrchaApiClient.perimeterIntercepted(status: 403, contentType: "text/html", body: Data()))
    }

    @Test func portalResponsesPassThrough() {
        // Portal JSON — including its JSON errors (403 authority, 404, 409, 422) —
        // must never read as an auth bounce.
        #expect(!OrchaApiClient.perimeterIntercepted(status: 200, contentType: "application/json", body: Data(#"{"containers":[]}"#.utf8)))
        #expect(!OrchaApiClient.perimeterIntercepted(status: 403, contentType: "application/json", body: Data(#"{"detail":"not allowed"}"#.utf8)))
        #expect(!OrchaApiClient.perimeterIntercepted(status: 422, contentType: "application/json", body: Data(#"{"detail":"missing"}"#.utf8)))
        // Finished-run SSE reads are text, not HTML.
        #expect(!OrchaApiClient.perimeterIntercepted(status: 200, contentType: "text/event-stream", body: Data("data: {\"seq\":1}".utf8)))
    }
}
