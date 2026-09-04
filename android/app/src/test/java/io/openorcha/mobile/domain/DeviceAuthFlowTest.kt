package io.openorcha.mobile.domain

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

/**
 * The GitHub device-token sign-in reducer. Mirrors iOS's `DeviceAuthFlowTests.swift`
 * transition-by-transition.
 */
class DeviceAuthFlowTest {

    @Test
    fun startsInOptions() {
        assertIs<DeviceAuthFlow.Phase.Options>(DeviceAuthFlow().phase)
    }

    @Test
    fun signInTappedFromOptionsEntersSigningIn() {
        val flow = DeviceAuthFlow().handle(DeviceAuthFlow.Event.SignInTapped)
        assertIs<DeviceAuthFlow.Phase.SigningIn>(flow.phase)
    }

    @Test
    fun cancelledFromSigningInReturnsToOptionsWithNoBanner() {
        val flow = DeviceAuthFlow()
            .handle(DeviceAuthFlow.Event.SignInTapped)
            .handle(DeviceAuthFlow.Event.Cancelled)
        assertIs<DeviceAuthFlow.Phase.Options>(flow.phase)
    }

    @Test
    fun callbackReceivedFromSigningInEntersConnecting() {
        val flow = DeviceAuthFlow()
            .handle(DeviceAuthFlow.Event.SignInTapped)
            .handle(DeviceAuthFlow.Event.CallbackReceived)
        assertIs<DeviceAuthFlow.Phase.Connecting>(flow.phase)
    }

    @Test
    fun invalidCallbackFromSigningInFailsWithGuidanceMessage() {
        val flow = DeviceAuthFlow()
            .handle(DeviceAuthFlow.Event.SignInTapped)
            .handle(DeviceAuthFlow.Event.InvalidCallback)
        val phase = assertIs<DeviceAuthFlow.Phase.Failed>(flow.phase)
        assertEquals(
            "GitHub finished, but the sign-in didn't come back as expected. Try again, or use an access token instead.",
            phase.message,
        )
    }

    @Test
    fun retryFailedFromSigningInFailsWithThatMessage() {
        val flow = DeviceAuthFlow()
            .handle(DeviceAuthFlow.Event.SignInTapped)
            .handle(DeviceAuthFlow.Event.RetryFailed("boom"))
        val phase = assertIs<DeviceAuthFlow.Phase.Failed>(flow.phase)
        assertEquals("boom", phase.message)
    }

    @Test
    fun retryFailedFromConnectingFailsWithThatMessage() {
        val flow = DeviceAuthFlow()
            .handle(DeviceAuthFlow.Event.SignInTapped)
            .handle(DeviceAuthFlow.Event.CallbackReceived)
            .handle(DeviceAuthFlow.Event.RetryFailed("token rejected"))
        val phase = assertIs<DeviceAuthFlow.Phase.Failed>(flow.phase)
        assertEquals("token rejected", phase.message)
    }

    @Test
    fun retrySucceededFromConnectingConnects() {
        val flow = DeviceAuthFlow()
            .handle(DeviceAuthFlow.Event.SignInTapped)
            .handle(DeviceAuthFlow.Event.CallbackReceived)
            .handle(DeviceAuthFlow.Event.RetrySucceeded)
        assertIs<DeviceAuthFlow.Phase.Connected>(flow.phase)
    }

    @Test
    fun signInTappedFromFailedStartsOver() {
        val flow = DeviceAuthFlow()
            .handle(DeviceAuthFlow.Event.SignInTapped)
            .handle(DeviceAuthFlow.Event.RetryFailed("boom"))
            .handle(DeviceAuthFlow.Event.SignInTapped)
        assertIs<DeviceAuthFlow.Phase.SigningIn>(flow.phase)
    }

    @Test
    fun cancelledAfterRetryAlreadyBeganIsIgnored() {
        // A stray Cancelled once Connecting has begun must not un-do the connect.
        val flow = DeviceAuthFlow()
            .handle(DeviceAuthFlow.Event.SignInTapped)
            .handle(DeviceAuthFlow.Event.CallbackReceived)
            .handle(DeviceAuthFlow.Event.Cancelled)
        assertIs<DeviceAuthFlow.Phase.Connecting>(flow.phase)
    }

    @Test
    fun signInTappedWhileAlreadySigningInIsIgnored() {
        val flow = DeviceAuthFlow()
            .handle(DeviceAuthFlow.Event.SignInTapped)
            .handle(DeviceAuthFlow.Event.SignInTapped)
        assertIs<DeviceAuthFlow.Phase.SigningIn>(flow.phase)
    }

    @Test
    fun eventsAfterConnectedAreIgnored() {
        val connected = DeviceAuthFlow()
            .handle(DeviceAuthFlow.Event.SignInTapped)
            .handle(DeviceAuthFlow.Event.CallbackReceived)
            .handle(DeviceAuthFlow.Event.RetrySucceeded)
        val flow = connected.handle(DeviceAuthFlow.Event.SignInTapped)
        assertIs<DeviceAuthFlow.Phase.Connected>(flow.phase)
    }
}
