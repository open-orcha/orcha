package io.openorcha.mobile.domain

/* Pure logic for the Metrics & usage screen — ports of the web MetricsPage formatters
   and honesty rules (cost "not reported" is never a fake $0, health from the real
   failed-run ratio, token mix as part-to-whole). Unit-tested. */

import io.openorcha.mobile.data.MxAgentDto
import io.openorcha.mobile.data.MxTotalsDto
import io.openorcha.mobile.data.SpendInsightDto
import io.openorcha.mobile.data.TokenWindowDto
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import java.util.Locale
import kotlin.math.roundToLong

enum class RunHealth { NoData, OnTrack, AtRisk, OffTrack }

data class MixPart(val label: String, val tokens: Long, val fraction: Double)

object UsageFormat {
    const val NOT_REPORTED = "not reported"
    const val NOT_REPORTED_TIP = "No cost was recorded for these runs. This is not \$0 — the token counts are the usage signal."
    const val MODEL_UNKNOWN = "Model not recorded"
    const val CACHE_NOTE = "Cache reads count toward the quota but cost little — most of a long session is cached context."

    val SUMMARY_WINDOWS = listOf(7 to "7 days", 30 to "30 days")
    val SPEND_WINDOWS = listOf("5h" to "5 hours", "7d" to "7 days", "30d" to "30 days", "all" to "All time")
    val TOKEN_WINDOWS = listOf("5h" to "5 hours", "7d" to "7 days", "all" to "All time")

    fun usd(v: Double): String = when {
        v != 0.0 && v < 0.01 -> String.format(Locale.US, "$%.4f", v)
        v < 1000 -> String.format(Locale.US, "$%.2f", v)
        else -> "$" + String.format(Locale.US, "%,d", v.roundToLong())
    }

    fun tokens(n: Long): String = when {
        n < 1_000 -> n.toString()
        n < 1_000_000 -> String.format(Locale.US, "%.1f", n / 1_000.0).removeSuffix(".0") + "K"
        else -> String.format(Locale.US, "%.1f", n / 1_000_000.0).removeSuffix(".0") + "M"
    }

    fun duration(secs: Double): String {
        val s0 = Math.round(secs)
        if (s0 <= 0) return "0s"
        val d = s0 / 86_400; val h = (s0 % 86_400) / 3_600; val m = (s0 % 3_600) / 60; val s = s0 % 60
        return when {
            d > 0 -> "${d}d ${h}h"
            h > 0 -> "${h}h ${m}m"
            m > 0 -> if (s > 0) "${m}m ${s}s" else "${m}m"
            else -> "${s}s"
        }
    }

    private val MONTHS = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

    /** "2026-09-26" → "Sep 26"; anything else passes through. */
    fun day(iso: String?): String {
        val m = Regex("""^(\d{4})-(\d{2})-(\d{2})$""").find(iso.orEmpty()) ?: return iso.orEmpty()
        return MONTHS[m.groupValues[2].toInt() - 1] + " " + m.groupValues[3].toInt()
    }

    fun plural(n: Int, word: String): String = "$n $word" + if (n == 1) "" else "s"

    /** One-line cost caption under the Est. cost tile (web costCaptionShort). */
    fun costCaptionShort(t: MxTotalsDto): String = when {
        t.runs == 0 -> "no runs"
        t.runsWithCost == 0 -> "see tokens"
        t.runsWithCost >= t.runs -> "all runs reported"
        else -> "from ${t.runsWithCost} of ${t.runs} runs"
    }

    /** No run reported a dollar figure → cost is unknown, not $0. */
    fun costUnreported(t: MxTotalsDto): Boolean = t.runs > 0 && t.runsWithCost == 0

    /** Every run reported cost → a row's $0 really is $0. */
    fun costComplete(t: MxTotalsDto): Boolean = t.runs > 0 && t.runsWithCost >= t.runs

    fun usdOrNotReported(v: Double, known: Boolean): String = if (v > 0 || known) usd(v) else NOT_REPORTED

    /** Under 5% failed → on track; under 20% → at risk; else off track (web runHealth). */
    fun health(a: MxAgentDto): RunHealth {
        if (a.runs <= 0) return RunHealth.NoData
        val ratio = a.failedRuns.toDouble() / a.runs
        return when {
            ratio < 0.05 -> RunHealth.OnTrack
            ratio < 0.20 -> RunHealth.AtRisk
            else -> RunHealth.OffTrack
        }
    }

    fun healthLabel(h: RunHealth): String = when (h) {
        RunHealth.NoData -> "No runs"
        RunHealth.OnTrack -> "On track"
        RunHealth.AtRisk -> "At risk"
        RunHealth.OffTrack -> "Off track"
    }

    fun healthDetail(a: MxAgentDto): String =
        if (a.runs <= 0) "No runs in this window"
        else "${a.okRuns} of ${plural(a.runs, "run")} succeeded" + if (a.failedRuns > 0) " · ${a.failedRuns} failed" else ""

    /** Cost magnitude bar fraction (0–1), null when nothing honest to draw. */
    fun costBarFraction(cost: Double, maxCost: Double, known: Boolean): Float? {
        if (maxCost <= 0 || !(cost > 0 || known)) return null
        val pct = Math.round(cost / maxCost * 100)
        return if (pct < 1) null else pct / 100f
    }

    /** Agents sorted by cost desc (tokens when no cost was reported), then alias. */
    fun sortAgents(agents: List<MxAgentDto>, byTokens: Boolean): List<MxAgentDto> =
        agents.sortedWith(
            compareByDescending<MxAgentDto> { if (byTokens) (it.tokensIn + it.tokensOut).toDouble() else it.estCostUsd }
                .thenBy { (it.alias ?: "").lowercase() },
        )

    /** Catalog name, else a readable id ("claude-opus-5-5" → "Opus 5.5"), else null. */
    fun modelName(id: String?, catalog: Map<String, String>): String? {
        val raw = id?.trim().orEmpty()
        if (raw.isEmpty()) return null
        catalog[raw]?.let { return it }
        val parts = raw.removePrefix("claude-").split('-').filter { it.isNotEmpty() && !(it.length == 8 && it.all(Char::isDigit)) }
        if (parts.isEmpty()) return raw
        val family = parts.first().replaceFirstChar { it.uppercase() }
        val ver = parts.drop(1).takeWhile { it.all(Char::isDigit) }.joinToString(".")
        return if (ver.isEmpty() || !raw.startsWith("claude-")) raw else "$family $ver"
    }

    /** In / Out / Cache read / Cache write as a part-to-whole of the four counts. */
    fun tokenMix(w: TokenWindowDto): List<MixPart> {
        val raw = listOf(
            "Input" to w.inputTokens, "Output" to w.outputTokens,
            "Cache read" to w.cacheReadInputTokens, "Cache write" to w.cacheCreationInputTokens,
        )
        val sum = raw.sumOf { it.second }.coerceAtLeast(0)
        return raw.map { (l, v) -> MixPart(l, v, if (sum > 0) v.toDouble() / sum else 0.0) }
    }

    fun percent(fraction: Double): String = when {
        fraction <= 0.0 -> "0%"
        fraction < 0.001 -> "<0.1%"
        fraction < 0.1 -> String.format(Locale.US, "%.1f%%", fraction * 100).replace(".0%", "%")
        else -> "${Math.round(fraction * 100)}%"
    }

    /** pct_of_quota may arrive as 0–1 or 0–100; normalise to 0–1. */
    fun quotaFraction(w: TokenWindowDto): Double? {
        w.pctOfQuota?.let { return (if (it > 1.0) it / 100.0 else it).coerceAtLeast(0.0) }
        val q = w.quotaTokens ?: return null
        return if (q > 0) w.totalTokens.toDouble() / q else null
    }

    /** "full" / "partial" / "none" cost honesty for a spend row (web spendCostState). */
    fun spendCostState(runs: Int, cost: Double, runsWithCost: Int?): String {
        if (runsWithCost == null) return if (cost > 0) "partial" else "none"
        if (runsWithCost <= 0) return "none"
        return if (runsWithCost >= runs) "full" else "partial"
    }

    fun spendCostText(runs: Int, cost: Double, runsWithCost: Int?): String = when (spendCostState(runs, cost, runsWithCost)) {
        "none" -> NOT_REPORTED
        "full" -> usd(cost)
        else -> usd(cost) + " · partial"
    }

    /** Insights only have 7d / all: 5h → 7d, 30d → all. */
    fun insightsWindowFor(w: String): String = if (w == "5h" || w == "7d") "7d" else "all"

    private val AGENT_INSIGHT_KINDS = setOf("cold-context", "wake-churn", "heavy-model-small-talk", "subscription-loop")

    /** The insights that concern ONE agent (web insightsForAgent). */
    fun insightsForAgent(insights: List<SpendInsightDto>, agentId: String, alias: String?, taskIds: List<String?>): List<SpendInsightDto> {
        val tasks = taskIds.filterNotNull().toSet()
        return insights.filter { i ->
            val kind = i.id.substringBefore(':')
            val ref = i.id.substringAfter(':', "")
            val ev = i.evidence
            if (kind in AGENT_INSIGHT_KINDS) {
                val evAlias = (ev["agent_alias"] ?: ev["agent"])?.let { (it as? JsonPrimitive)?.contentOrNull }
                (ref.isNotEmpty() && ref == agentId) || (alias != null && evAlias == alias)
            } else {
                val tid = (ev["task_id"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                    ?: if (kind == "context-bloat" || kind == "concentration") ref else null
                !tid.isNullOrEmpty() && tid in tasks
            }
        }
    }

    private val EVIDENCE_LABEL = mapOf(
        "agent_alias" to "Agent", "agent" to "Agent", "cache_read_input_tokens" to "Cache reads",
        "cache_creation_input_tokens" to "Cache writes", "tiny_runs" to "Tiny runs", "total_runs" to "Runs",
        "tiny_fraction" to "Tiny share", "median_output_tokens" to "Median output", "task_cost_usd" to "Task cost",
        "window_cost_usd" to "Window total", "fraction" to "Share of spend", "read_to_creation_ratio" to "Reads per write",
        "total_cost_usd" to "Total cost",
    )
    private val EVIDENCE_HIDDEN = setOf("task", "task_id", "task_title", "agent_id")

    /** Evidence → readable "Label value" chips; nested objects and ids are dropped. */
    fun evidenceChips(i: SpendInsightDto): List<String> = i.evidence.mapNotNull { (k, v) ->
        if (k in EVIDENCE_HIDDEN) return@mapNotNull null
        val prim = v as? JsonPrimitive ?: return@mapNotNull null
        val content = prim.contentOrNull?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
        var label = EVIDENCE_LABEL[k] ?: k.replace('_', ' ').replaceFirstChar { it.uppercase() }.replace(Regex(" usd$", RegexOption.IGNORE_CASE), "")
        val num = if (prim.isString) null else prim.doubleOrNull
        val value = when {
            prim.booleanOrNull != null -> if (prim.booleanOrNull == true) "yes" else "no"
            num == null -> content
            k == "read_to_creation_ratio" -> (Math.round(num * 10) / 10.0).toString().removeSuffix(".0") + "×"
            Regex("(_ratio|^ratio|fraction|_share)$").containsMatchIn(k) && num in 0.0..1.0 -> {
                if (k !in EVIDENCE_LABEL) label = label.replace(Regex(" ratio$| fraction$", RegexOption.IGNORE_CASE), "")
                (Math.round(num * 1000) / 10.0).toString().removeSuffix(".0") + "%"
            }
            Regex("(^|_)usd$|^cost$|cost_usd").containsMatchIn(k) -> usd(num)
            k.contains("tokens") -> tokens(num.toLong())
            k.endsWith("seconds") -> duration(num)
            num == Math.floor(num) -> String.format(Locale.US, "%,d", num.toLong())
            else -> (Math.round(num * 100) / 100.0).toString()
        }
        "$label $value"
    }

    fun severityLabel(s: String): String = when (s) { "high" -> "High"; "medium" -> "Medium"; else -> "Info" }
}
