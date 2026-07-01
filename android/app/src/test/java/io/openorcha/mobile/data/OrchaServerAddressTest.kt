package io.openorcha.mobile.data

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class OrchaServerAddressTest {
    @Test
    fun acceptsHostPortWithoutScheme() {
        assertEquals(
            "http://192.168.1.8:8001",
            OrchaServerAddress.normalize("192.168.1.8:8001"),
        )
        assertEquals(
            "http://kedar-laptop.local:8001",
            OrchaServerAddress.normalize("kedar-laptop.local:8001"),
        )
    }

    @Test
    fun keepsHttpsTunnelWithoutAddingLocalPort() {
        assertEquals(
            "https://orcha-example.ngrok-free.app",
            OrchaServerAddress.normalize("https://orcha-example.ngrok-free.app/some/path"),
        )
    }

    @Test
    fun defaultsBareHttpHostToOrchaPort() {
        assertEquals(
            "http://192.168.1.8:8001",
            OrchaServerAddress.normalize("http://192.168.1.8"),
        )
    }

    @Test
    fun rejectsLocalhostBecausePhoneNeedsComputerAddress() {
        val err = assertFailsWith<IllegalArgumentException> {
            OrchaServerAddress.normalize("localhost:8001")
        }

        assertEquals(
            "Use your computer's Wi-Fi address instead of localhost. Localhost points at the phone.",
            err.message,
        )
    }

    @Test
    fun rejectsPlaceholderUrl() {
        val err = assertFailsWith<IllegalArgumentException> {
            OrchaServerAddress.normalize("http://")
        }

        assertEquals(
            "Enter your computer's local address, for example 192.168.1.8:8001.",
            err.message,
        )
    }
}
