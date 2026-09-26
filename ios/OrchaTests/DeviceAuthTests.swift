import Foundation
import Testing
@testable import Orcha

/// The QR → GitHub OAuth device-token flow: the outbound oauth2 start URL,
/// the `orcha://auth/callback` parsing on the way back (including the
/// host-match guard that keeps a minted token on its own deployment), and the
/// options-sheet state machine that strings the round-trip together.

@Suite struct DeviceAuthCallbackTests {

    @Test func validCallbackParses() throws {
        let url = try #require(URL(string: "orcha://auth/callback?host=orcha.example.com&token=dev-abc123"))
        let callback = try #require(DeviceAuth.parseCallback(url))
        #expect(callback.host == "orcha.example.com")
        #expect(callback.token == "dev-abc123")
    }

    @Test func percentEncodedTokenDecodes() throws {
        let url = try #require(URL(string: "orcha://auth/callback?host=orcha.example.com&token=a%2Bb%3D%3D"))
        #expect(DeviceAuth.parseCallback(url)?.token == "a+b==")
    }

    @Test(arguments: [
        "https://auth/callback?host=h&token=t",     // wrong scheme
        "orcha://pair/callback?host=h&token=t",     // wrong host namespace
        "orcha://auth/other?host=h&token=t",        // wrong path
        "orcha://auth/callback?host=h",             // missing token
        "orcha://auth/callback?token=t",            // missing host
        "orcha://auth/callback?host=h&token=",      // empty token
        "orcha://auth/callback",                    // no query at all
    ])
    func malformedCallbacksAreRejected(raw: String) throws {
        let url = try #require(URL(string: raw))
        #expect(DeviceAuth.parseCallback(url) == nil)
    }

    @Test func authNamespaceIsRecognizedCaseInsensitively() throws {
        #expect(DeviceAuth.isAuthCallback(try #require(URL(string: "orcha://auth/callback?host=h&token=t"))))
        #expect(DeviceAuth.isAuthCallback(try #require(URL(string: "ORCHA://AUTH/anything"))))
    }

    @Test func otherDeepLinksAreNotAuthCallbacks() throws {
        // The widget lineage's links must keep routing as deep links, and a
        // web URL must never read as ours.
        #expect(!DeviceAuth.isAuthCallback(try #require(URL(string: "orcha://task/t-1"))))
        #expect(!DeviceAuth.isAuthCallback(try #require(URL(string: "https://auth/callback"))))
    }

    @Test func startURLTargetsTheOauthProxyWithEncodedReturn() {
        // `rd` must stay `%2Fauth%2Fdevice` — the encoded form oauth2-proxy expects.
        #expect(DeviceAuth.startURL(forBase: "https://orcha.example.com")?.absoluteString
            == "https://orcha.example.com/oauth2/start?rd=%2Fauth%2Fdevice")
    }

    @Test func startURLKeepsThePort() {
        #expect(DeviceAuth.startURL(forBase: "https://orcha.example.com:8443")?.absoluteString
            == "https://orcha.example.com:8443/oauth2/start?rd=%2Fauth%2Fdevice")
    }

    @Test func callbackHostMustNameThePendingDeployment() {
        let callback = DeviceAuth.Callback(host: "orcha.example.com", token: "t")
        #expect(DeviceAuth.callback(callback, matchesBase: "https://orcha.example.com"))
        #expect(DeviceAuth.callback(callback, matchesBase: "https://ORCHA.EXAMPLE.com"))
        // A token minted for one deployment never attaches to another.
        #expect(!DeviceAuth.callback(callback, matchesBase: "https://other.example.com"))
    }

    @Test func callbackHostToleratesPortAndSchemeShapes() {
        #expect(DeviceAuth.callback(
            .init(host: "orcha.example.com:443", token: "t"),
            matchesBase: "https://orcha.example.com"
        ))
        #expect(DeviceAuth.callback(
            .init(host: "https://orcha.example.com", token: "t"),
            matchesBase: "https://orcha.example.com"
        ))
    }
}

@Suite struct DeviceAuthFlowTests {

    @Test func happyPathReachesConnected() {
        var flow = DeviceAuthFlow()
        #expect(flow.phase == .options)
        flow.handle(.signInTapped)
        #expect(flow.phase == .signingIn)
        flow.handle(.callbackReceived)
        #expect(flow.phase == .connecting)
        flow.handle(.retrySucceeded)
        #expect(flow.phase == .connected)
    }

    @Test func userCancelReturnsToOptionsWithoutBanner() {
        // Closing the browser sheet is the user's own action — and a
        // server-side mint failure ends the session the same way. No banner.
        var flow = DeviceAuthFlow()
        flow.handle(.signInTapped)
        flow.handle(.cancelled)
        #expect(flow.phase == .options)
    }

    @Test func unparseableCallbackFailsWithABanner() {
        var flow = DeviceAuthFlow()
        flow.handle(.signInTapped)
        flow.handle(.invalidCallback)
        guard case .failed = flow.phase else {
            Issue.record("expected .failed, got \(flow.phase)")
            return
        }
    }

    @Test func rejectedMintFallsBackWithTheReason() {
        var flow = DeviceAuthFlow()
        flow.handle(.signInTapped)
        flow.handle(.callbackReceived)
        flow.handle(.retryFailed("token rejected"))
        #expect(flow.phase == .failed("token rejected"))
    }

    @Test func failureBeforeTheBrowserOpensAlsoLandsOnFailed() {
        // e.g. the captured pairing draft went missing — the attempt dies
        // while still "signing in".
        var flow = DeviceAuthFlow()
        flow.handle(.signInTapped)
        flow.handle(.retryFailed("draft missing"))
        #expect(flow.phase == .failed("draft missing"))
    }

    @Test func failedStateCanRetry() {
        var flow = DeviceAuthFlow()
        flow.handle(.signInTapped)
        flow.handle(.invalidCallback)
        flow.handle(.signInTapped)
        #expect(flow.phase == .signingIn)
    }

    @Test func strayEventsAreIgnored() {
        var flow = DeviceAuthFlow()
        flow.handle(.cancelled)                    // nothing running yet
        #expect(flow.phase == .options)
        flow.handle(.retrySucceeded)               // no retry to succeed
        #expect(flow.phase == .options)
        flow.handle(.signInTapped)
        flow.handle(.callbackReceived)
        flow.handle(.cancelled)                    // retry already under way
        #expect(flow.phase == .connecting)
        flow.handle(.retrySucceeded)
        flow.handle(.retryFailed("late"))          // already connected
        #expect(flow.phase == .connected)
    }
}
