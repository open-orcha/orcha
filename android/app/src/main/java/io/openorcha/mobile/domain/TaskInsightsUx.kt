package io.openorcha.mobile.domain

import io.openorcha.mobile.data.EvidenceSummaryDto
import io.openorcha.mobile.data.EvidenceTestInvocation
import io.openorcha.mobile.data.GoalChainDto
import io.openorcha.mobile.data.GoalNodeDto
import io.openorcha.mobile.data.ManagerReviewDto
import io.openorcha.mobile.data.ReviewRoutingDto
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Pure copy + logic for the task-detail parity features. Wording mirrors the web portal
 * (`EvidenceSummaryLine.tsx`, `EvidencePack.tsx`, `lib/reviewRoute.ts`,
 * `routines/schedule.ts`) so the three clients read the same.
 */
object TaskInsightsUx {

    /** iOS `ReassignUx.canReassign`: the server refuses to (re)assign the root, a finished, in-review or cancelled task. */
    fun canReassign(isRoot: Boolean, status: String): Boolean =
        !isRoot && status !in setOf("completed", "needs_verification", "cancelled")

    enum class Tone { Ok, Warn, Bad, Muted, Plain }

    data class Part(val key: String, val text: String, val tone: Tone)

    /** Web `summaryParts`: each part appears only when it is real — no invented counts. */
    fun summaryParts(s: EvidenceSummaryDto?, short: Boolean = true): List<Part> {
        s ?: return emptyList()
        return buildList {
            s.dod?.takeIf { it.total > 0 }?.let { d ->
                val tone = when {
                    d.notProven > 0 -> Tone.Bad
                    d.proven == d.total -> Tone.Ok
                    else -> Tone.Plain
                }
                add(Part("dod", if (short) "${d.proven}/${d.total} DoD" else "${d.proven}/${d.total} DoD items evidenced", tone))
            }
            s.tests?.let { t ->
                val bad = t.failed + t.errors
                when {
                    t.status == "none" -> add(Part("tests", "no tests ran", Tone.Muted))
                    bad > 0 -> add(Part("tests", "$bad test${plural(bad)} failing", Tone.Bad))
                    t.passed > 0 -> add(Part("tests", "${t.passed} test${plural(t.passed)} passed", Tone.Ok))
                    t.status == "exit_ok" -> add(Part("tests", "tests exited 0", Tone.Plain))
                    t.status == "failed" -> add(Part("tests", "tests failing", Tone.Bad))
                    t.status == "unverified" -> add(Part("tests", "tests ran (result unreadable)", Tone.Muted))
                }
            }
            if (s.riskFlags > 0) {
                val n = s.riskFlags
                add(Part("risk", if (short) "$n risk${plural(n)}" else "$n risk flag${plural(n)}", Tone.Warn))
            }
        }
    }

    fun dodStatusLabel(status: String): String = when (status) {
        "proven" -> "Proven"
        "not_proven" -> "Not proven"
        else -> "Needs a human"
    }

    fun dodTone(status: String): Tone = when (status) {
        "proven" -> Tone.Ok
        "not_proven" -> Tone.Bad
        else -> Tone.Muted
    }

    /** Web `invText`: one test command's result line. */
    fun invocationText(inv: EvidenceTestInvocation): Pair<String, Tone> {
        val c = inv.counts
        if (c != null) {
            val bad = c.failed + c.errors
            val unit = if (c.unit == "tests") "" else " ${c.unit}"
            val text = buildString {
                append("${c.passed} passed")
                if (bad > 0) append(" · $bad failed")
                if (c.skipped > 0) append(" · ${c.skipped} skipped")
                append(unit)
            }
            return text to when {
                bad > 0 -> Tone.Bad
                c.passed > 0 -> Tone.Ok
                else -> Tone.Muted
            }
        }
        return when (inv.outcome) {
            "exit_ok" -> "exit 0 · no summary line" to Tone.Plain
            "exit_failed" -> (inv.exitCode?.let { "exit $it" } ?: "errored") to Tone.Bad
            else -> "result not captured" to Tone.Muted
        }
    }

    /** Web `managerReviewLine`: the AI manager's advisory pre-review as one line. */
    fun managerReviewLine(mr: ManagerReviewDto?): Pair<String, Tone>? {
        if (mr == null || mr.status.isBlank()) return null
        val name = mr.managerAlias ?: "The manager"
        val who = "$name (manager)"
        val why = mr.reasons?.takeIf { it.isNotBlank() }?.let { ": $it" } ?: ""
        return when (mr.status) {
            "pending" -> "$who is pre-reviewing — you can still decide now" to Tone.Plain
            "approved" -> "$who recommends approval$why" to Tone.Ok
            "sent_back" -> "$who sent it back$why" to Tone.Bad
            "commented" -> "$who commented$why" to Tone.Muted
            "superseded" -> "$name’s pre-review was skipped — a person decided first" to Tone.Muted
            "overridden" -> "$who sent it back — accepted anyway by a person" to Tone.Muted
            else -> null
        }
    }

    /** Web `reviewVia`: why this reviewer ("via Atlas’s manager"). Null when nothing was routed. */
    fun reviewVia(routing: ReviewRoutingDto?): String? {
        routing ?: return null
        val who = routing.assigneeAlias ?: "the assignee"
        return when (routing.routedVia) {
            "reports_to" -> "via $who’s " + if ((routing.managerDepth ?: 1) > 1) "manager chain" else "manager"
            "owner" -> "project owner"
            "fallback" -> "no manager in $who’s chain can verify — anyone may"
            "manual" -> routing.setByAlias?.let { "set by $it" } ?: "set by a person"
            else -> null
        }
    }

    /* ---------- goal ancestry ---------- */

    /** Breadcrumb crumbs above this task: the objective, then each parent (the task itself is the page). */
    fun goalCrumbs(chain: GoalChainDto?): List<GoalNodeDto> =
        chain?.goalChain.orEmpty().filter { it.kind != "task" }

    fun goalCrumbLabel(node: GoalNodeDto): String = when (node.kind) {
        "objective" -> node.text?.takeIf { it.isNotBlank() }?.let { clip(it, 60) } ?: node.title.ifBlank { "Project objective" }
        else -> clip(node.title, 60)
    }

    /** GH #378: the objective in full when the 60-character crumb label shortened it (null otherwise; the
     *  breadcrumb also opens it when the label fits 60 characters but not the screen). */
    fun goalCrumbFull(node: GoalNodeDto): String? {
        if (node.kind != "objective") return null
        val full = node.text?.takeIf { it.isNotBlank() }?.replace(Regex("\\s+"), " ")?.trim() ?: return null
        return full.takeIf { it != goalCrumbLabel(node) }
    }

    /** Worth showing only when there's more than the bare project name above the task. */
    fun hasAncestry(chain: GoalChainDto?): Boolean =
        goalCrumbs(chain).any { it.kind == "parent" || !it.text.isNullOrBlank() }

    fun clip(text: String, n: Int): String {
        val s = text.replace(Regex("\\s+"), " ").trim()
        return if (s.length <= n) s else s.take(n - 1).trimEnd() + "…"
    }

    /* ---------- routine schedule presets (web routines/schedule.ts) ---------- */

    enum class Preset(val label: String) { Hourly("Hourly"), Daily("Daily"), Weekdays("Weekdays"), Weekly("Weekly"), Monthly("Monthly") }

    val DAY_NAMES = listOf("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday")

    fun toCron(preset: Preset, hour: Int, minute: Int, weekday: Int = 1, monthDay: Int = 1): String {
        val h = hour.coerceIn(0, 23)
        val m = minute.coerceIn(0, 59)
        return when (preset) {
            Preset.Hourly -> "$m * * * *"
            Preset.Daily -> "$m $h * * *"
            Preset.Weekdays -> "$m $h * * 1-5"
            Preset.Weekly -> "$m $h * * ${((weekday % 7) + 7) % 7}"
            Preset.Monthly -> "$m $h ${monthDay.coerceIn(1, 28)} * *"
        }
    }

    /** "Mon 2 Oct, 09:00" in [zone]; the raw string when it isn't an instant. */
    fun formatRun(iso: String, zone: String): String = runCatching {
        val z = runCatching { ZoneId.of(zone) }.getOrDefault(ZoneId.systemDefault())
        DateTimeFormatter.ofPattern("EEE d MMM, HH:mm", Locale.getDefault()).format(Instant.parse(iso).atZone(z))
    }.getOrElse { runCatching {
        val z = runCatching { ZoneId.of(zone) }.getOrDefault(ZoneId.systemDefault())
        DateTimeFormatter.ofPattern("EEE d MMM, HH:mm", Locale.getDefault())
            .format(java.time.OffsetDateTime.parse(iso).atZoneSameInstant(z))
    }.getOrDefault(iso) }

    private fun plural(n: Int) = if (n == 1) "" else "s"
}
