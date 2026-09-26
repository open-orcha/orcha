package io.openorcha.mobile.domain

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Copy-selection for a failed connect/action. iOS parity: `AppModel.friendly(_:)`.
 * Regression cover for the LAN-only-framing bug: the fallback ("didn't answer" /
 * generic unreachable) copy must stay address-neutral -- it fires for both a local
 * self-host address and a deployed cloud/remote portal address, so it must not
 * name Wi-Fi or a laptop specifically.
 */
class ConnectionErrorCopyTest {

    @Test
    fun `null error falls back to the address-neutral unreachable copy`() {
        assertEquals(
            "Could not reach Orcha at this address. Check the address and that your Orcha is up.",
            ConnectionErrorCopy.friendly(null),
        )
    }

    @Test
    fun `fallback copy never mentions Wi-Fi or a laptop`() {
        val copy = ConnectionErrorCopy.friendly(RuntimeException())
        assertEquals(false, copy.contains("Wi-Fi", ignoreCase = true))
        assertEquals(false, copy.contains("laptop", ignoreCase = true))
    }

    @Test
    fun `IllegalArgumentException with a message passes that message through unchanged`() {
        assertEquals(
            "That pairing code could not be read.",
            ConnectionErrorCopy.friendly(IllegalArgumentException("That pairing code could not be read.")),
        )
    }

    @Test
    fun `blank-message IllegalArgumentException falls through to the generic classifier`() {
        assertEquals(
            "Could not reach Orcha at this address. Check the address and that your Orcha is up.",
            ConnectionErrorCopy.friendly(IllegalArgumentException("")),
        )
    }

    /** A stand-in whose *class name* (not message) says "Serialization" — the real
     *  kotlinx/Ktor exception types the classifier is written to recognize. */
    private class FakeSerializationException(message: String, cause: Throwable? = null) : RuntimeException(message, cause)

    private class FakeJsonConvertException(message: String) : RuntimeException(message)

    @Test
    fun `a data-shape (serialization) failure gets app-update copy, not a reach failure`() {
        val decodeFailure = FakeSerializationException("Unexpected token")
        val copy = ConnectionErrorCopy.friendly(decodeFailure)
        assertEquals(
            "This app version couldn't read part of Orcha's reply. Your Orcha and network are fine — update the app to the latest version.",
            copy,
        )
        assertEquals(false, copy.contains("reach", ignoreCase = true))
    }

    @Test
    fun `a data-shape failure nested deeper in the cause chain is still caught`() {
        val root = FakeJsonConvertException("nope")
        val wrapped = RuntimeException("wrapped", RuntimeException("also wrapped", root))
        val copy = ConnectionErrorCopy.friendly(wrapped)
        assertEquals(
            "This app version couldn't read part of Orcha's reply. Your Orcha and network are fine — update the app to the latest version.",
            copy,
        )
    }

    @Test
    fun `403 gets the not-allowed-for-this-human copy`() {
        assertEquals(
            "This action is not allowed for the paired human.",
            ConnectionErrorCopy.friendly(RuntimeException("403 Forbidden")),
        )
    }

    @Test
    fun `409 gets the item-changed copy`() {
        assertEquals(
            "Orcha rejected this action because the item changed. Refresh and try again.",
            ConnectionErrorCopy.friendly(RuntimeException("409 Conflict")),
        )
    }

    @Test
    fun `422 gets the needs-more-information copy`() {
        assertEquals(
            "Orcha needs more information for this action.",
            ConnectionErrorCopy.friendly(RuntimeException("422 Unprocessable")),
        )
    }

    @Test
    fun `a short plain message passes through unchanged`() {
        assertEquals(
            "No Orcha container was found at this address.",
            ConnectionErrorCopy.friendly(RuntimeException("No Orcha container was found at this address.")),
        )
    }

    @Test
    fun `a very long message is dropped in favor of the address-neutral fallback`() {
        val longMessage = "x".repeat(200)
        assertEquals(
            "Could not reach Orcha at this address. Check the address and that your Orcha is up.",
            ConnectionErrorCopy.friendly(RuntimeException(longMessage)),
        )
    }
}
