import AuthenticationServices
import UIKit

/// Async wrapper around ASWebAuthenticationSession for the GitHub
/// device-token flow: one call in, one callback URL back. The Safari session
/// is shared (`prefersEphemeralWebBrowserSession = false`) so an operator
/// already signed into GitHub sails straight through. Every non-URL outcome —
/// the user closing the sheet, the server erroring out without redirecting,
/// the session failing to start — surfaces as a throw the caller treats as a
/// cancel.
@MainActor
final class WebAuthSession: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    /// Run the browser round-trip; returns the intercepted
    /// `orcha://auth/callback` URL. Cancelling the surrounding task tears the
    /// browser sheet down too.
    func authenticate(startURL: URL) async throws -> URL {
        session?.cancel()      // never two browser sheets — the newest attempt wins
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<URL, Error>) in
                var resumed = false
                let finish: (Result<URL, Error>) -> Void = { [weak self] result in
                    guard !resumed else { return }
                    resumed = true
                    self?.session = nil
                    continuation.resume(with: result)
                }
                let handler: (URL?, Error?) -> Void = { url, error in
                    if let url {
                        finish(.success(url))
                    } else {
                        finish(.failure(error ?? ASWebAuthenticationSessionError(.canceledLogin)))
                    }
                }
                let session: ASWebAuthenticationSession
                if #available(iOS 17.4, *) {
                    session = ASWebAuthenticationSession(
                        url: startURL,
                        callback: .customScheme(DeviceAuth.callbackScheme),
                        completionHandler: handler
                    )
                } else {
                    session = ASWebAuthenticationSession(
                        url: startURL,
                        callbackURLScheme: DeviceAuth.callbackScheme,
                        completionHandler: handler
                    )
                }
                session.prefersEphemeralWebBrowserSession = false
                session.presentationContextProvider = self
                self.session = session
                if !session.start() {
                    finish(.failure(ASWebAuthenticationSessionError(.canceledLogin)))
                }
            }
        } onCancel: {
            Task { @MainActor in self.session?.cancel() }
        }
    }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
            return scene?.keyWindow ?? scene?.windows.first ?? ASPresentationAnchor()
        }
    }
}
