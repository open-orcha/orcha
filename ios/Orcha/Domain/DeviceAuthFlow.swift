import Foundation

/// The auth-options sheet's state machine for the GitHub device-token flow —
/// a pure reducer (no session, no networking) so every transition is testable.
///
///     options ──signInTapped──▶ signingIn ──callbackReceived──▶ connecting ──retrySucceeded──▶ connected
///        ▲                        │   │                            │
///        └───────cancelled────────┘   └─invalidCallback─▶ failed ◀─┴─retryFailed
///
/// `failed` renders as the options sheet with a danger banner; `signInTapped`
/// from there starts the round-trip over. A user cancel goes back to plain
/// `options` with no banner — closing the browser sheet is their own action
/// (and a server-side mint failure ends the session the same way).
struct DeviceAuthFlow: Equatable {
    enum Phase: Equatable {
        /// Showing the options: Sign in with GitHub, or the collapsed token entry.
        case options
        /// The browser session is up; waiting for the callback (or a close).
        case signingIn
        /// Callback parsed — retrying the captured pairing probe with the minted token.
        case connecting
        /// Back on the options with a banner explaining what went wrong.
        case failed(String)
        /// The retry connected; the sheet dismisses.
        case connected
    }

    enum Event: Equatable {
        case signInTapped
        /// The session returned an `orcha://auth/callback` URL that parsed
        /// and named the pending deployment.
        case callbackReceived
        /// The user closed the browser sheet — or the server showed its own
        /// error page and never redirected, ending the session the same way.
        case cancelled
        /// The session returned a URL that didn't parse or named another host.
        case invalidCallback
        case retrySucceeded
        /// The attempt failed with a reason worth a banner: the minted token
        /// was rejected on the probe retry, or the flow couldn't even start.
        case retryFailed(String)
    }

    private(set) var phase: Phase = .options

    /// Advance the machine. Events that make no sense in the current phase
    /// are ignored (e.g. a stray `cancelled` after the retry already began).
    mutating func handle(_ event: Event) {
        switch (phase, event) {
        case (.options, .signInTapped), (.failed, .signInTapped):
            phase = .signingIn
        case (.signingIn, .cancelled):
            phase = .options
        case (.signingIn, .callbackReceived):
            phase = .connecting
        case (.signingIn, .invalidCallback):
            phase = .failed("GitHub finished, but the sign-in didn't come back as expected. Try again, or use an access token instead.")
        case (.signingIn, .retryFailed(let message)), (.connecting, .retryFailed(let message)):
            phase = .failed(message)
        case (.connecting, .retrySucceeded):
            phase = .connected
        default:
            break
        }
    }
}
