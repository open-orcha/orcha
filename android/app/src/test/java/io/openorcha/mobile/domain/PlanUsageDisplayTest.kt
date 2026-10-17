package io.openorcha.mobile.domain

import io.openorcha.mobile.data.PlanUsageDisplayBody
import io.openorcha.mobile.data.PlanUsageDisplayDto
import io.openorcha.mobile.data.PlanUsageProviderDto
import io.openorcha.mobile.data.PlanUsageSnapshotDto
import io.openorcha.mobile.data.PlanUsageWindowDto
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/** Plan usage display setting: contract decode, sync-rule merge, default off, provider filter. */
class PlanUsageDisplayTest {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true; explicitNulls = false }

    private fun dto(raw: String) = json.decodeFromString<PlanUsageDisplayDto>(raw)

    @Test
    fun `default GET payload decodes as off, both, never set`() {
        val d = dto("""{"show": false, "providers": "both", "updated_at": null}""")
        assertFalse(d.show)
        assertEquals("both", d.providers)
        assertNull(d.updatedAt)
        val v = PlanUsageDisplay.from(d)
        assertEquals(PlanUsageDisplay.DEFAULT, v)
    }

    @Test
    fun `stored payload decodes with timestamp and provider`() {
        val v = PlanUsageDisplay.from(dto("""{"show":true,"providers":"codex","updated_at":"2026-10-02T13:20:01+00:00","extra":1}"""))
        assertTrue(v.show)
        assertEquals(PlanUsageProviders.Codex, v.providers)
        assertEquals(Instant.parse("2026-10-02T13:20:01Z"), v.updatedAt)
    }

    @Test
    fun `missing fields and unknown provider are tolerated`() {
        assertEquals(PlanUsageDisplay.DEFAULT, PlanUsageDisplay.from(dto("{}")))
        assertEquals(PlanUsageProviders.Both, PlanUsageProviders.from("gemini"))
        assertEquals(PlanUsageProviders.Claude, PlanUsageProviders.from(" Claude "))
    }

    @Test
    fun `PUT body carries exactly show and providers`() {
        val s = Json.encodeToString(PlanUsageDisplayBody(true, PlanUsageProviders.Claude.wire))
        assertEquals("""{"show":true,"providers":"claude"}""", s)
    }

    @Test
    fun `default is off when nothing read or every portal never set`() {
        assertFalse(PlanUsageUx.mergeDisplay(emptyList()).show)
        val merged = PlanUsageUx.mergeDisplayDtos(listOf(PlanUsageDisplayDto(), PlanUsageDisplayDto(show = true, providers = "codex")))
        // Both null-timestamped: never set → default, even if one body says show=true.
        assertEquals(PlanUsageDisplay.DEFAULT, merged)
    }

    @Test
    fun `newest updated_at wins and set beats never set`() {
        val older = PlanUsageDisplayDto(show = false, providers = "both", updatedAt = "2026-10-02T10:00:00Z")
        val newer = PlanUsageDisplayDto(show = true, providers = "claude", updatedAt = "2026-10-02T12:00:00+00:00")
        val never = PlanUsageDisplayDto(show = false, providers = "codex", updatedAt = null)
        val m = PlanUsageUx.mergeDisplayDtos(listOf(older, never, newer))
        assertTrue(m.show)
        assertEquals(PlanUsageProviders.Claude, m.providers)
        val m2 = PlanUsageUx.mergeDisplayDtos(listOf(never, older))
        assertFalse(m2.show)
        assertEquals(PlanUsageProviders.Both, m2.providers)
        assertEquals(Instant.parse("2026-10-02T10:00:00Z"), m2.updatedAt)
    }

    private val view = PlanUsageUx.merge(
        listOf(
            PlanUsageSnapshotDto(
                host = "mac.local", capturedAt = "2026-10-02T13:20:00Z",
                providers = listOf(
                    PlanUsageProviderDto("claude", windows = listOf(PlanUsageWindowDto("5h", "5h", 34.0))),
                    PlanUsageProviderDto("codex", windows = listOf(PlanUsageWindowDto("wk", "wk", 75.0))),
                ),
            ),
        ),
    )

    @Test
    fun `filter keeps only the chosen provider`() {
        assertSame(view, PlanUsageUx.filter(view, PlanUsageProviders.Both))
        val claude = PlanUsageUx.filter(view, PlanUsageProviders.Claude)
        assertEquals(listOf("claude"), claude.entries.map { it.usage.provider })
        assertEquals(34.0, PlanUsageUx.overallPct(claude))
        val codex = PlanUsageUx.filter(view, PlanUsageProviders.Codex)
        assertEquals(listOf("codex"), codex.entries.map { it.usage.provider })
        assertEquals(75.0, PlanUsageUx.overallPct(codex))
        assertEquals("mac.local", codex.newestHost)
    }

    @Test
    fun `filter to a provider with no data is empty`() {
        val onlyClaude = PlanUsageUx.filter(view, PlanUsageProviders.Claude)
        assertTrue(PlanUsageUx.filter(onlyClaude, PlanUsageProviders.Codex).isEmpty)
    }
}
