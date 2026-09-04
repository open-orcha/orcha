package io.openorcha.mobile.domain

/**
 * The auth-options sheet's state machine for the GitHub device-token flow -- a pure
 * reducer (no session, no networking) so every transition is testable. Ports
 * `ios/Orcha/Domain/DeviceAuthFlow.swift` 1:1.
 *
 *     Options --SignInTapped--> SigningIn --CallbackReceived--> Connecting --RetrySucceeded--> Connected
 *        ^                        |   |                            |
 *        +-------Cancelled--------+   +-InvalidCallback-> Failed <-+--RetryFailed
 *
 * `Failed` renders as the options sheet with a danger banner; `SignInTapped` from
 * there starts the round-trip over. A user cancel goes back to plain `Options` with
 * no banner -- closing the Custom Tab is their own action (and a server-side mint
 * failure ends the session the same way).
 */
data class DeviceAuthFlow(val phase: Phase = Phase.Options) {

    sealed interface Phase {
        /** Showing the options: Sign in with GitHub, or the collapsed token entry. */
        data object Options : Phase

        /** The Custom Tab is up; waiting for the callback (or a close). */
        data object SigningIn : Phase

        /** Callback parsed -- retrying the captured pairing probe with the minted token. */
        data object Connecting : Phase

        /** Back on the options with a banner explaining what went wrong. */
        data class Failed(val message: String) : Phase

        /** The retry connected; the sheet dismisses. */
        data object Connected : Phase
    }

    sealed interface Event {
        data object SignInTapped : Event

        /**
         * The Custom Tab returned an `orcha://auth/callback` URI that parsed and
         * named the pending deployment.
         */
        data object CallbackReceived : Event

        /**
         * The user closed the Custom Tab -- or the server showed its own error
         * page and never redirected, ending the session the same way.
         */
        data object Cancelled : Event

        /** The session returned a URI that didn't parse or named another host. */
        data object InvalidCallback : Event

        data object RetrySucceeded : Event

        /**
         * The attempt failed with a reason worth a banner: the minted token was
         * rejected on the probe retry, or the flow couldn't even start.
         */
        data class RetryFailed(val message: String) : Event
    }

    /**
     * Advance the machine. Events that make no sense in the current phase are
     * ignored (e.g. a stray `Cancelled` after the retry already began).
     */
    fun handle(event: Event): DeviceAuthFlow {
        val next = when (phase) {
            is Phase.Options -> when (event) {
                is Event.SignInTapped -> Phase.SigningIn
                else -> null
            }
            is Phase.SigningIn -> when (event) {
                is Event.Cancelled -> Phase.Options
                is Event.CallbackReceived -> Phase.Connecting
                is Event.InvalidCallback -> Phase.Failed(
                    "GitHub finished, but the sign-in didn't come back as expected. Try again, or use an access token instead.",
                )
                is Event.RetryFailed -> Phase.Failed(event.message)
                else -> null
            }
            is Phase.Connecting -> when (event) {
                is Event.RetrySucceeded -> Phase.Connected
                is Event.RetryFailed -> Phase.Failed(event.message)
                else -> null
            }
            is Phase.Failed -> when (event) {
                is Event.SignInTapped -> Phase.SigningIn
                else -> null
            }
            is Phase.Connected -> null
        }
        return if (next == null) this else copy(phase = next)
    }
}
