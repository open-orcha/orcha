package io.openorcha.mobile.domain

import io.openorcha.mobile.data.PlanUsageListResponse
import io.openorcha.mobile.data.PlanUsageProviderDto
import io.openorcha.mobile.data.PlanUsageSnapshotDto
import io.openorcha.mobile.data.PlanUsageTodayDto
import io.openorcha.mobile.data.PlanUsageWindowDto
import kotlinx.serialization.json.Json
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.util.Locale
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Plan usage: contract decode, merge-newest, thresholds and the desktop panel's strings. */
class PlanUsageUxTest {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true; explicitNulls = false }
    private val ny = ZoneId.of("America/New_York")
    // Friday 2026-10-02 13:23 EDT.
    private val now = Instant.parse("2026-10-02T17:23:00Z")

    private val contract = """{"snapshots":[{"host":"Husseins-MacBook-Pro.local","captured_at":"2026-10-02T13:20:00Z",
        "updated_at":"2026-10-02T13:20:01+00:00","providers":[
        {"provider":"claude","plan":"Max","headline":"5h resets in 3h 26m",
         "windows":[{"key":"5h","label":"5h","used_pct":8,"resets_at":"2026-10-02T16:49:00-04:00"},
                    {"key":"wk","label":"wk","used_pct":6,"resets_at":"2026-10-08T12:00:00-04:00"},
                    {"key":"model:fable","label":"Fable","used_pct":2.4,"resets_at":null}],
         "today":{"tokens":601000000,"cost_usd":237.61}},
        {"provider":"codex","plan":"Plus","headline":"wk resets in 1d 1h",
         "windows":[{"key":"5h","label":"5h","used_pct":0},{"key":"wk","label":"wk","used_pct":34,"resets_at":"2026-10-03T15:20:00-04:00"}],
         "today":null,"extra_future_field":1}]}]}"""

    @Test
    fun `contract payload decodes`() {
        val r = json.decodeFromString<PlanUsageListResponse>(contract)
        val s = r.snapshots.single()
        assertEquals("Husseins-MacBook-Pro.local", s.host)
        assertEquals(2, s.providers.size)
        val claude = s.providers[0]
        assertEquals("Max", claude.plan)
        assertEquals(3, claude.windows.size)
        assertEquals(2.4, claude.windows[2].usedPct)
        assertNull(claude.windows[2].resetsAt)
        assertEquals(601_000_000L, claude.today?.tokens)
        assertEquals(237.61, claude.today?.costUsd)
        assertNull(s.providers[1].today)
        assertNull(s.providers[1].windows[0].resetsAt)
    }

    @Test
    fun `empty list decodes`() {
        assertTrue(json.decodeFromString<PlanUsageListResponse>("{\"snapshots\":[]}").snapshots.isEmpty())
        assertTrue(PlanUsageUx.merge(emptyList()).isEmpty)
    }

    @Test
    fun `desktop panel strings`() {
        val s = json.decodeFromString<PlanUsageListResponse>(contract).snapshots.single()
        val claude = s.providers[0]
        assertEquals("92% left · resets today 4:49 PM · in 3h 26m", PlanUsageUx.windowDetail(claude.windows[0], now, ny, Locale.US))
        assertEquals("98% left", PlanUsageUx.windowDetail(claude.windows[2], now, ny, Locale.US))
        val codexWk = s.providers[1].windows[1]
        assertEquals("66% left · resets Sat 3:20 PM · in 1d 1h", PlanUsageUx.windowDetail(codexWk, now, ny, Locale.US))
        assertEquals("100% left", PlanUsageUx.windowDetail(s.providers[1].windows[0], now, ny, Locale.US))
        assertEquals("Today 601M tokens · Est. $237.61", PlanUsageUx.todayLine(claude.today))
        assertNull(PlanUsageUx.todayLine(null))
        assertEquals("resets in 3h 26m", PlanUsageUx.compactReset(claude.windows[0], now))
        val view = PlanUsageUx.merge(listOf(s))
        assertEquals(34.0, PlanUsageUx.overallPct(view))
        assertEquals("34%", PlanUsageUx.pctText(34.0))
        assertEquals("wk", PlanUsageUx.mostConstrained(s.providers[1])?.label)
    }

    @Test
    fun `resets in formatting`() {
        assertEquals("<1m", PlanUsageUx.duration(Duration.ofSeconds(20)))
        assertEquals("26m", PlanUsageUx.duration(Duration.ofMinutes(26)))
        assertEquals("3h", PlanUsageUx.duration(Duration.ofHours(3)))
        assertEquals("3h 26m", PlanUsageUx.duration(Duration.ofMinutes(206)))
        assertEquals("1d 1h", PlanUsageUx.duration(Duration.ofMinutes(25 * 60 + 10)))
        assertEquals("2d", PlanUsageUx.duration(Duration.ofDays(2)))
        assertNull(PlanUsageUx.resetsIn("2026-10-02T10:00:00Z", now)) // already passed
        assertNull(PlanUsageUx.resetsIn(null, now))
        assertEquals("Oct 20 9:00 AM", PlanUsageUx.resetClock("2026-10-20T13:00:00Z", now, ny, Locale.US))
    }

    @Test
    fun `tokens and cost`() {
        assertEquals("601M", PlanUsageUx.tokens(601_000_000))
        assertEquals("1.2B", PlanUsageUx.tokens(1_200_000_000))
        assertEquals("1.5M", PlanUsageUx.tokens(1_500_000))
        assertEquals("45.3K", PlanUsageUx.tokens(45_300))
        assertEquals("980", PlanUsageUx.tokens(980))
        assertEquals("$1,237.60", PlanUsageUx.usd(1237.6))
        assertEquals("Today · Est. $2.00", PlanUsageUx.todayLine(PlanUsageTodayDto(null, 2.0)))
    }

    @Test
    fun `colour thresholds`() {
        assertEquals(PlanUsageTone.Neutral, PlanUsageUx.tone(0.0))
        assertEquals(PlanUsageTone.Neutral, PlanUsageUx.tone(75.0))
        assertEquals(PlanUsageTone.Warn, PlanUsageUx.tone(75.1))
        assertEquals(PlanUsageTone.Warn, PlanUsageUx.tone(90.0))
        assertEquals(PlanUsageTone.Danger, PlanUsageUx.tone(90.1))
        assertEquals(PlanUsageTone.Danger, PlanUsageUx.tone(150.0))
        assertEquals("100%", PlanUsageUx.pctText(130.0))
        assertEquals("0% left", PlanUsageUx.leftText(100.0))
    }

    private fun snap(host: String, at: String, vararg providers: Pair<String, Double>) = PlanUsageSnapshotDto(
        host = host, capturedAt = at,
        providers = providers.map { (prov, pct) -> PlanUsageProviderDto(prov, windows = listOf(PlanUsageWindowDto("5h", "5h", pct))) },
    )

    @Test
    fun `merge picks newest snapshot per provider across portals`() {
        val a = snap("old-mac.local", "2026-10-02T12:00:00Z", "claude" to 50.0, "codex" to 10.0)
        val b = snap("new-mac.local", "2026-10-02T13:00:00Z", "claude" to 20.0)
        val v = PlanUsageUx.merge(listOf(b, a))
        assertEquals(listOf("claude", "codex"), v.entries.map { it.usage.provider })
        assertEquals(20.0, v.entries[0].usage.windows[0].usedPct)
        assertEquals("new-mac.local", v.entries[0].host)
        assertEquals("old-mac.local", v.entries[1].host)
        assertEquals("new-mac.local", v.newestHost)
        // Codex listed after Claude even when it arrives first.
        val c = PlanUsageUx.merge(listOf(snap("h", "2026-10-02T13:00:00Z", "codex" to 1.0, "claude" to 2.0)))
        assertEquals(listOf("claude", "codex"), c.entries.map { it.usage.provider })
    }

    @Test
    fun `staleness line`() {
        val v = PlanUsageUx.merge(listOf(snap("Husseins-MacBook-Pro.local", "2026-10-02T17:21:00Z", "claude" to 8.0)))
        assertEquals("Updated 2m ago from Husseins-MacBook-Pro", PlanUsageUx.updatedLine(v, now))
        assertFalse(PlanUsageUx.isStale(v, now))
        assertTrue(PlanUsageUx.isStale(v, now.plus(Duration.ofMinutes(40))))
        assertEquals("Updated just now from Husseins-MacBook-Pro", PlanUsageUx.updatedLine(v, Instant.parse("2026-10-02T17:21:20Z")))
    }

    @Test
    fun `provider names and marks`() {
        assertEquals("Claude", PlanUsageUx.providerName("claude"))
        assertEquals("Codex", PlanUsageUx.providerName("codex"))
        assertEquals(ModelProvider.Claude, PlanUsageUx.markFor("claude"))
        assertEquals(ModelProvider.OpenAI, PlanUsageUx.markFor("codex"))
    }

    @Test
    fun `talkback summary`() {
        val v = PlanUsageUx.merge(listOf(snap("h", "2026-10-02T17:21:00Z", "claude" to 8.0)))
        assertTrue(PlanUsageUx.cardSummary(v, now).startsWith("Plan usage, highest 8%. Claude, 5h window 8% used"))
        assertTrue(PlanUsageUx.EMPTY_MESSAGE in PlanUsageUx.cardSummary(PlanUsageUx.merge(emptyList()), now))
    }
}
