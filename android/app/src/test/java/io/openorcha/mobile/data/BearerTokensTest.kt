package io.openorcha.mobile.data

import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * [BearerTokens] keys credentials by normalized ORIGIN (scheme + host + effective
 * port), never by bare host: two Orcha servers sharing a hostname on different ports
 * are different deployments, and a host-only key would send server A's token to
 * server B (PR #223 review). iOS keys the full base URL, so this is also the parity
 * contract.
 */
class BearerTokensTest {
    @BeforeTest fun reset() = BearerTokens.clear()
    @AfterTest fun tearDown() = BearerTokens.clear()

    @Test
    fun twoPortsOnOneHostKeepSeparateTokens() {
        BearerTokens.set("https://orcha.example:8443", "token-a")
        BearerTokens.set("https://orcha.example:9443", "token-b")
        assertEquals("token-a", BearerTokens.token("https://orcha.example:8443/api/containers"))
        assertEquals("token-b", BearerTokens.token("https://orcha.example:9443/api/containers"))
    }

    @Test
    fun httpAndHttpsOnOneHostAreDistinctOrigins() {
        BearerTokens.set("https://orcha.example", "secure")
        assertNull(BearerTokens.token("http://orcha.example/api/me"))
        assertEquals("secure", BearerTokens.token("https://orcha.example/api/me"))
    }

    @Test
    fun defaultPortIsNormalizedSoExplicitAndImplicitFormsMatch() {
        BearerTokens.set("https://orcha.example", "t")
        assertEquals("t", BearerTokens.token("https://orcha.example:443/api/x"))
        assertEquals("t", BearerTokens.token("HTTPS://Orcha.Example/api/x"))
        BearerTokens.set("http://10.0.0.5:8000", "lan")
        assertEquals("lan", BearerTokens.token("http://10.0.0.5:8000/api/containers/c1/tasks?limit=5"))
        assertNull(BearerTokens.token("http://10.0.0.5/api/containers"))
    }

    @Test
    fun clearingAndSeedingRebuildTheRegistry() {
        BearerTokens.set("https://a.example:8443", "old")
        BearerTokens.set("https://a.example:8443", null)
        assertNull(BearerTokens.token("https://a.example:8443/"))

        BearerTokens.set("https://stale.example", "stale")
        BearerTokens.seed(
            listOf(
                StoredContainer(
                    id = "c1", displayName = "One", baseUrl = "http://192.168.1.2:8000",
                    remoteBaseUrl = "https://one.example:8443", accessToken = "tok-1",
                ),
            ),
        )
        assertNull(BearerTokens.token("https://stale.example/"))
        assertEquals("tok-1", BearerTokens.token("http://192.168.1.2:8000/api/me"))
        assertEquals("tok-1", BearerTokens.token("https://one.example:8443/api/me"))
    }

    @Test
    fun originOfRejectsNonHttpInput() {
        assertNull(BearerTokens.originOf("not a url"))
        assertNull(BearerTokens.originOf("orcha.example:8443"))
        assertNull(BearerTokens.originOf("ftp://orcha.example"))
        assertEquals("https://orcha.example:8443", BearerTokens.originOf("https://orcha.example:8443/x?y=1"))
    }
}
