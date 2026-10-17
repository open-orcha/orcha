package io.openorcha.mobile.domain

/* Pure logic for the Home tab's "This week" usage card: the headline figure (est. cost,
   or "Not reported" like the Metrics screen — never a fake $0), the runs caption, the
   7-bar runs-per-day sparkline scaling and the TalkBack sentence. Unit-tested. */

import io.openorcha.mobile.data.MxDayDto
import io.openorcha.mobile.data.MxTotalsDto

/** One sparkline bar: [fraction] of the peak (0 = zero day → tick), [peak] = the tallest bar. */
data class SparkBar(val fraction: Float, val peak: Boolean)

object HomeUsage {
    const val DAYS = 7
    const val NO_RUNS = "No runs this week"

    /** "$53.63", or "Not reported" when no run recorded a dollar figure. */
    fun costHeadline(t: MxTotalsDto): String =
        if (UsageFormat.costUnreported(t)) "Not reported" else UsageFormat.usd(t.estCostUsd)

    fun runsCaption(t: MxTotalsDto): String = UsageFormat.plural(t.runs, "run")

    /** The last [n] days (by date, oldest first), padded with zero days at the front,
     *  scaled to the peak. The first peak day is flagged for the primary fill. */
    fun sparkline(daily: List<MxDayDto>, n: Int = DAYS): List<SparkBar> {
        val runs = daily.sortedBy { it.date }.takeLast(n).map { it.runs.coerceAtLeast(0) }
        val padded = List(n - runs.size) { 0 } + runs
        val max = padded.maxOrNull() ?: 0
        val peakAt = if (max > 0) padded.indexOf(max) else -1
        return padded.mapIndexed { i, r -> SparkBar(if (max > 0) r.toFloat() / max else 0f, i == peakAt) }
    }

    /** TalkBack label for the whole card. */
    fun accessibilityLabel(t: MxTotalsDto?): String {
        val body = if (t == null || t.runs == 0) NO_RUNS
        else {
            val cost = if (UsageFormat.costUnreported(t)) "cost not reported" else UsageFormat.usd(t.estCostUsd)
            "Usage this week: $cost, ${runsCaption(t)}"
        }
        return "$body. Opens Metrics and usage."
    }
}
