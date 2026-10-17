package io.openorcha.mobile.domain

/* Pure logic for Plan usage (desktop "Usage" panel parity): merge the snapshots read from
   every paired portal (newest per provider wins), the most-constrained window, the bar tone
   thresholds, and every user-facing string ("92% left · resets today 4:49 PM · in 3h 26m",
   "Today 601M tokens · Est. $237.61", "Updated 2m ago from …"). Unit-tested. */

import io.openorcha.mobile.data.PlanUsageDisplayDto
import io.openorcha.mobile.data.PlanUsageProviderDto
import io.openorcha.mobile.data.PlanUsageSnapshotDto
import io.openorcha.mobile.data.PlanUsageTodayDto
import io.openorcha.mobile.data.PlanUsageWindowDto
import java.time.Duration
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.roundToInt

/** Bar colour bucket: same as desktop usage/parts.tsx: amber above 75 %, red above 90 %. */
enum class PlanUsageTone { Neutral, Warn, Danger }

/** One provider's newest data across all portals, with where/when it came from. */
data class PlanUsageEntry(
    val usage: PlanUsageProviderDto,
    val host: String,
    val capturedAt: Instant?,
)

/** The merged view the card and sheet render. */
data class PlanUsageView(
    val entries: List<PlanUsageEntry>,
    val newestAt: Instant?,
    val newestHost: String?,
) {
    val isEmpty: Boolean get() = entries.isEmpty()
}

/** Which providers the summary surfaces show (portal value: "both" | "claude" | "codex"). */
enum class PlanUsageProviders(val wire: String, val title: String) {
    Both("both", "Both"), Claude("claude", "Claude"), Codex("codex", "Codex");

    companion object {
        /** Unknown or blank values read as [Both]. */
        fun from(raw: String?): PlanUsageProviders = entries.firstOrNull { it.wire == raw?.trim()?.lowercase() } ?: Both
    }
}

/** The portal-wide display setting after the sync rule; [updatedAt] null = never set. */
data class PlanUsageDisplay(
    val show: Boolean = false,
    val providers: PlanUsageProviders = PlanUsageProviders.Both,
    val updatedAt: Instant? = null,
) {
    companion object {
        val DEFAULT = PlanUsageDisplay()
        fun from(dto: PlanUsageDisplayDto): PlanUsageDisplay =
            PlanUsageDisplay(dto.show, PlanUsageProviders.from(dto.providers), PlanUsageUx.parseInstant(dto.updatedAt))
    }
}

object PlanUsageUx {
    const val DISPLAY_TITLE = "Show plan usage"
    const val DISPLAY_PROVIDERS_TITLE = "Providers"
    const val DISPLAY_CAPTION =
        "Shows your Claude and Codex plan limits in the sidebar and on each project's Home, on every device connected to this Embodent."

    const val EMPTY_MESSAGE = "Plan usage appears when the Embodent desktop app is running on your computer."
    const val STALE_NOTE = "may be out of date"
    val STALE_AFTER: Duration = Duration.ofMinutes(30)
    const val POLL_MS = 120_000L

    private val PROVIDER_ORDER = listOf("claude", "codex")

    fun parseInstant(raw: String?): Instant? {
        val s = raw?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        return runCatching { OffsetDateTime.parse(s).toInstant() }.getOrNull()
            ?: runCatching { Instant.parse(s) }.getOrNull()
            // Naive timestamps (no offset) are treated as UTC, like the portal stores them.
            ?: runCatching { Instant.parse(s + "Z") }.getOrNull()
    }

    private fun snapshotTime(s: PlanUsageSnapshotDto): Instant? = parseInstant(s.capturedAt) ?: parseInstant(s.updatedAt)

    /** Newest snapshot per provider across every portal; Claude first, then Codex. */
    fun merge(snapshots: List<PlanUsageSnapshotDto>): PlanUsageView {
        val best = LinkedHashMap<String, PlanUsageEntry>()
        for (snap in snapshots) {
            val at = snapshotTime(snap)
            for (prov in snap.providers) {
                val key = prov.provider.trim().lowercase().takeIf { it.isNotEmpty() } ?: continue
                val current = best[key]
                if (current == null || (at != null && (current.capturedAt == null || at.isAfter(current.capturedAt)))) {
                    best[key] = PlanUsageEntry(prov, snap.host, at)
                }
            }
        }
        val entries = best.entries
            .sortedWith(compareBy({ PROVIDER_ORDER.indexOf(it.key).let { i -> if (i < 0) Int.MAX_VALUE else i } }, { it.key }))
            .map { it.value }
        val newest = entries.filter { it.capturedAt != null }.maxByOrNull { it.capturedAt!! }
        return PlanUsageView(entries, newest?.capturedAt, newest?.host ?: entries.firstOrNull()?.host)
    }

    fun clampPct(p: Double): Double = if (p.isNaN()) 0.0 else p.coerceIn(0.0, 100.0)

    fun pctText(p: Double): String = "${clampPct(p).roundToInt()}%"

    fun leftText(p: Double): String = "${100 - clampPct(p).roundToInt()}% left"

    fun tone(p: Double): PlanUsageTone = when {
        clampPct(p) > 90.0 -> PlanUsageTone.Danger
        clampPct(p) > 75.0 -> PlanUsageTone.Warn
        else -> PlanUsageTone.Neutral
    }

    /** The window closest to its limit (highest used %), or null with no windows. */
    fun mostConstrained(p: PlanUsageProviderDto): PlanUsageWindowDto? = p.windows.maxByOrNull { clampPct(it.usedPct) }

    /** The header figure: the highest used % across every window of every provider. */
    fun overallPct(view: PlanUsageView): Double? =
        view.entries.flatMap { it.usage.windows }.maxOfOrNull { clampPct(it.usedPct) }

    fun providerName(provider: String): String = when (provider.trim().lowercase()) {
        "claude" -> "Claude"
        "codex" -> "Codex"
        else -> provider.trim().replaceFirstChar { it.uppercase() }
    }

    /** The brand mark: Claude's asterisk, or OpenAI's mark for Codex. */
    fun markFor(provider: String): ModelProvider? = when (provider.trim().lowercase()) {
        "claude" -> ModelProvider.Claude
        "codex" -> ModelProvider.OpenAI
        else -> providerFor(provider)
    }

    /** "26m", "3h 26m", "1d 1h"; "<1m" under a minute. Zero tail units are dropped. */
    fun duration(d: Duration): String {
        val mins = d.toMinutes()
        if (mins < 1) return "<1m"
        val days = mins / (60 * 24)
        val hours = (mins / 60) % 24
        val m = mins % 60
        return when {
            days > 0 -> if (hours > 0) "${days}d ${hours}h" else "${days}d"
            hours > 0 -> if (m > 0) "${hours}h ${m}m" else "${hours}h"
            else -> "${m}m"
        }
    }

    /** "in 3h 26m", or null when the reset time is unknown or already passed. */
    fun resetsIn(resetsAt: String?, now: Instant): String? {
        val at = parseInstant(resetsAt) ?: return null
        if (!at.isAfter(now)) return null
        return "in " + duration(Duration.between(now, at))
    }

    /** "today 4:49 PM", "Sat 3:20 PM" within the week, else "Oct 9 3:20 PM", device-local. */
    fun resetClock(resetsAt: String?, now: Instant, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String? {
        val at = parseInstant(resetsAt) ?: return null
        val local = at.atZone(zone)
        val today = now.atZone(zone).toLocalDate()
        val time = local.format(DateTimeFormatter.ofPattern("h:mm a", locale))
        val day = when {
            local.toLocalDate() == today -> "today"
            local.toLocalDate().isBefore(today.plusDays(7)) && !local.toLocalDate().isBefore(today) ->
                local.format(DateTimeFormatter.ofPattern("EEE", locale))
            else -> local.format(DateTimeFormatter.ofPattern("MMM d", locale))
        }
        return "$day $time"
    }

    /** Detail line under a window row: "92% left · resets today 4:49 PM · in 3h 26m". */
    fun windowDetail(w: PlanUsageWindowDto, now: Instant, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String {
        val parts = mutableListOf(leftText(w.usedPct))
        val inText = resetsIn(w.resetsAt, now)
        if (inText != null) {
            resetClock(w.resetsAt, now, zone, locale)?.let { parts += "resets $it" }
            parts += inText
        }
        return parts.joinToString(" · ")
    }

    /** Compact card trailing caption: "resets in 3h 26m", or null when unknown. */
    fun compactReset(w: PlanUsageWindowDto?, now: Instant): String? = w?.let { resetsIn(it.resetsAt, now) }?.let { "resets $it" }

    /** "601M", "1.2B", "45.3K", "980". */
    fun tokens(n: Long): String {
        fun scaled(v: Double, suffix: String): String {
            val s = if (v >= 100 || v == Math.floor(v)) v.roundToInt().toString() else String.format(Locale.US, "%.1f", v).trimEnd('0').trimEnd('.')
            return s + suffix
        }
        return when {
            n >= 1_000_000_000L -> scaled(n / 1e9, "B")
            n >= 1_000_000L -> scaled(n / 1e6, "M")
            n >= 1_000L -> scaled(n / 1e3, "K")
            else -> n.coerceAtLeast(0).toString()
        }
    }

    fun usd(v: Double): String = "$" + String.format(Locale.US, "%,.2f", v)

    /** "Today 601M tokens · Est. $237.61"; null when nothing was reported today. */
    fun todayLine(t: PlanUsageTodayDto?): String? {
        if (t == null || (t.tokens == null && t.costUsd == null)) return null
        val parts = mutableListOf<String>()
        t.tokens?.let { parts += "Today ${tokens(it)} tokens" }
        t.costUsd?.let { parts += (if (parts.isEmpty()) "Today · " else "") + "Est. ${usd(it)}" }
        return parts.joinToString(" · ")
    }

    /** "Husseins-MacBook-Pro.local" → "Husseins-MacBook-Pro". */
    fun hostName(host: String?): String? = host?.trim()?.removeSuffix(".local")?.takeIf { it.isNotEmpty() }

    fun ago(at: Instant, now: Instant): String {
        val d = Duration.between(at, now).let { if (it.isNegative) Duration.ZERO else it }
        return if (d.toMinutes() < 1) "just now" else duration(d) + " ago"
    }

    /** "Updated 2m ago from Husseins-MacBook-Pro". */
    fun updatedLine(view: PlanUsageView, now: Instant): String? {
        val at = view.newestAt ?: return null
        val from = hostName(view.newestHost)?.let { " from $it" } ?: ""
        return "Updated ${ago(at, now)}$from"
    }

    fun isStale(view: PlanUsageView, now: Instant): Boolean =
        view.newestAt?.let { Duration.between(it, now) > STALE_AFTER } ?: false

    /** TalkBack sentence for one provider in the compact card. */
    fun providerSummary(e: PlanUsageEntry, now: Instant): String {
        val name = providerName(e.usage.provider)
        val plan = e.usage.plan?.takeIf { it.isNotBlank() }?.let { " $it" } ?: ""
        val w = mostConstrained(e.usage) ?: return "$name$plan, no limits reported"
        val reset = compactReset(w, now)?.let { ", $it" } ?: ""
        return "$name$plan, ${w.label} window ${pctText(w.usedPct)} used$reset"
    }

    /** TalkBack sentence for the whole compact card. */
    fun cardSummary(view: PlanUsageView, now: Instant): String {
        if (view.isEmpty) return "Plan usage. $EMPTY_MESSAGE"
        val head = overallPct(view)?.let { "Plan usage, highest ${pctText(it)}" } ?: "Plan usage"
        val body = view.entries.joinToString(". ") { providerSummary(it, now) }
        val stale = if (isStale(view, now)) ". $STALE_NOTE" else ""
        return "$head. $body$stale. Opens details."
    }

    /** Sync rule: the newest `updated_at` wins; never-set (null) loses to any set value;
     *  all never-set (or nothing read) → the default (off, both). */
    fun mergeDisplay(values: List<PlanUsageDisplay>): PlanUsageDisplay =
        values.filter { it.updatedAt != null }.maxByOrNull { it.updatedAt!! } ?: PlanUsageDisplay.DEFAULT

    fun mergeDisplayDtos(dtos: List<PlanUsageDisplayDto>): PlanUsageDisplay = mergeDisplay(dtos.map(PlanUsageDisplay::from))

    /** The view the summary card shows: only the chosen providers (a chosen one with no data is simply absent). */
    fun filter(view: PlanUsageView, providers: PlanUsageProviders): PlanUsageView {
        if (providers == PlanUsageProviders.Both) return view
        val kept = view.entries.filter { it.usage.provider.trim().lowercase() == providers.wire }
        val newest = kept.filter { it.capturedAt != null }.maxByOrNull { it.capturedAt!! }
        return PlanUsageView(kept, newest?.capturedAt, newest?.host ?: kept.firstOrNull()?.host)
    }
}
