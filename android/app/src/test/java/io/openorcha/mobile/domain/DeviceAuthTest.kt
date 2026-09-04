package io.openorcha.mobile.domain

import java.net.URI
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The GitHub device-token callback URI contract. Mirrors iOS's `DeviceAuthTests.swift`.
 */
class DeviceAuthTest {

    @Test
    fun startUrlAppendsAuthDevicePath() {
        assertEquals(
            "https://orcha.quantallabs.ai/auth/device",
            DeviceAuth.startUrl("https://orcha.quantallabs.ai"),
        )
    }

    @Test
    fun startUrlTrimsTrailingSlash() {
        assertEquals(
            "https://orcha.quantallabs.ai/auth/device",
            DeviceAuth.startUrl("https://orcha.quantallabs.ai/"),
        )
    }

    @Test
    fun startUrlIsNullForBlankBase() {
        assertNull(DeviceAuth.startUrl(""))
        assertNull(DeviceAuth.startUrl("   "))
    }

    @Test
    fun isAuthCallbackTrueForOrchaAuthScheme() {
        assertTrue(DeviceAuth.isAuthCallback(URI("orcha://auth/callback?host=h&token=t")))
    }

    @Test
    fun isAuthCallbackFalseForOtherSchemeOrHost() {
        assertFalse(DeviceAuth.isAuthCallback(URI("https://auth/callback")))
        assertFalse(DeviceAuth.isAuthCallback(URI("orcha://needs/some-container-id")))
    }

    @Test
    fun parseCallbackReadsHostAndToken() {
        val callback = DeviceAuth.parseCallback("orcha://auth/callback?host=orcha.quantallabs.ai&token=abc123")
        assertEquals(DeviceAuth.Callback("orcha.quantallabs.ai", "abc123"), callback)
    }

    @Test
    fun parseCallbackDecodesPercentEncoding() {
        val callback = DeviceAuth.parseCallback("orcha://auth/callback?host=orcha.quantallabs.ai&token=a%2Bb%2Fc")
        assertEquals("a+b/c", callback?.token)
    }

    @Test
    fun parseCallbackNullForWrongPath() {
        assertNull(DeviceAuth.parseCallback("orcha://auth/other?host=h&token=t"))
    }

    @Test
    fun parseCallbackNullForWrongScheme() {
        assertNull(DeviceAuth.parseCallback("https://auth/callback?host=h&token=t"))
    }

    @Test
    fun parseCallbackNullForMissingToken() {
        assertNull(DeviceAuth.parseCallback("orcha://auth/callback?host=h"))
    }

    @Test
    fun parseCallbackNullForMissingHost() {
        assertNull(DeviceAuth.parseCallback("orcha://auth/callback?token=t"))
    }

    @Test
    fun parseCallbackNullForEmptyValues() {
        assertNull(DeviceAuth.parseCallback("orcha://auth/callback?host=&token=t"))
        assertNull(DeviceAuth.parseCallback("orcha://auth/callback?host=h&token="))
    }

    @Test
    fun parseCallbackNullForMalformedUri() {
        assertNull(DeviceAuth.parseCallback("not a uri at all"))
    }

    @Test
    fun callbackMatchesBareHost() {
        val callback = DeviceAuth.Callback(host = "orcha.quantallabs.ai", token = "t")
        assertTrue(DeviceAuth.callbackMatchesBase(callback, "https://orcha.quantallabs.ai"))
    }

    @Test
    fun callbackMatchesHostPort() {
        val callback = DeviceAuth.Callback(host = "orcha.quantallabs.ai:443", token = "t")
        assertTrue(DeviceAuth.callbackMatchesBase(callback, "https://orcha.quantallabs.ai"))
    }

    @Test
    fun callbackMatchesFullUrlForm() {
        val callback = DeviceAuth.Callback(host = "https://orcha.quantallabs.ai", token = "t")
        assertTrue(DeviceAuth.callbackMatchesBase(callback, "https://orcha.quantallabs.ai"))
    }

    @Test
    fun callbackIsCaseInsensitive() {
        val callback = DeviceAuth.Callback(host = "ORCHA.QuantalLabs.ai", token = "t")
        assertTrue(DeviceAuth.callbackMatchesBase(callback, "https://orcha.quantallabs.ai"))
    }

    @Test
    fun callbackDoesNotMatchDifferentHost() {
        val callback = DeviceAuth.Callback(host = "evil.example.com", token = "t")
        assertFalse(DeviceAuth.callbackMatchesBase(callback, "https://orcha.quantallabs.ai"))
    }

    @Test
    fun callbackDoesNotMatchWhenBaseIsUnparseable() {
        val callback = DeviceAuth.Callback(host = "orcha.quantallabs.ai", token = "t")
        assertFalse(DeviceAuth.callbackMatchesBase(callback, ""))
    }
}
