package io.openorcha.mobile.domain

import io.openorcha.mobile.data.EvidenceAutofixSummary
import io.openorcha.mobile.data.EvidenceSummaryDto
import io.openorcha.mobile.data.EvidenceTestInvocation
import io.openorcha.mobile.data.GoalChainDto
import io.openorcha.mobile.data.GoalNodeDto
import io.openorcha.mobile.data.ManagerReviewDto
import io.openorcha.mobile.data.ReviewRoutingDto
import io.openorcha.mobile.data.VerdiktRunDto
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Pure copy + logic for the task-detail parity features. Wording mirrors the web portal
 * (`EvidenceSummaryLine.tsx`, `EvidencePack.tsx`, `VerdiktPanel.tsx`, `lib/reviewRoute.ts`,
 * `routines/schedule.ts`) so the three clients read the same.
 */
object TaskInsightsUx {

    /** iOS `ReassignUx.canReassign`: the server refuses to (re)assign the root, a finished, in-review or cancelled task. */
    fun canReassign(isRoot: Boolean, status: String): Boolean =
        !isRoot && status !in setOf("completed", "needs_verification", "cancelled")

    enum class Tone { Ok, Warn, Bad, Muted, Plain }

    data class Part(val key: String, val text: String, val tone: Tone)

    /** Web `autofixPart`: why the task is (back) here when the Verdikt auto-fix loop ran. */
    fun autofixPart(a: EvidenceAutofixSummary?): Part? {
        a ?: return null
        if (a.status == "running") return Part("autofix", "Auto-fix: attempt ${a.currentAttempt} of ${a.maxAttempts}", Tone.Plain)
        val n = a.attemptsMade
        val text = when (a.stopKind) {
            "pass" -> "Verdikt passed on attempt $n/${a.maxAttempts}"
            "attempt_limit" -> "Auto-fix stopped: failed $n of ${a.maxAttempts} attempts"
            "no_diff" -> "Auto-fix stopped: the rework changed no code"
            "same_failure" -> "Auto-fix stopped: same failure twice"
            "budget" -> "Auto-fix stopped: budget limit"
            "agent_paused" -> "Auto-fix stopped: agent paused"
            "stopped_by_human" -> "Auto-fix stopped by a person"
            "turned_off" -> "Auto-fix turned off"
            "no_assignee" -> "Auto-fix stopped: nobody assigned"
            else -> {
                val r = (a.stopReason ?: a.stopLabel ?: "stopped").split(" — ", " (").first()
                "Auto-fix stopped: " + if (r.startsWith("Verdikt")) r else r.replaceFirstChar { it.lowercase() }
            }
        }
        return Part("autofix", text, if (a.stopKind == "pass") Tone.Ok else Tone.Warn)
    }

    /** Web `summaryParts`: each part appears only when it is real — no invented counts. */
    fun summaryParts(s: EvidenceSummaryDto?, short: Boolean = true): List<Part> {
        s ?: return emptyList()
        return buildList {
            autofixPart(s.autofix)?.let(::add)
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
            s.verdikt?.let { v ->
                when {
                    v.status == "completed" && v.verdict != null -> add(
                        Part("verdikt", "Verdikt ${v.verdict}", when (v.verdict) { "pass" -> Tone.Ok; "fail" -> Tone.Bad; else -> Tone.Warn }),
                    )
                    v.status == "queued" -> add(Part("verdikt", "Verdikt queued", Tone.Plain))
                    v.status == "running" -> add(Part("verdikt", "Verdikt running", Tone.Plain))
                    v.status.isNotBlank() -> add(Part("verdikt", "Verdikt ${v.status}", if (v.status == "cancelled") Tone.Muted else Tone.Warn))
                }
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

    private val VERDIKT_STATUS = mapOf(
        "queued" to "Queued in Verdikt",
        "running" to "Verdikt is testing…",
        "completed" to "Verdikt finished",
        "failed" to "Verdikt run failed",
        "unavailable" to "Verdikt unavailable",
        "timeout" to "Verdikt timed out",
        "cancelled" to "Verdikt run cancelled",
    )

    fun verdiktHeadline(run: VerdiktRunDto): String =
        if (run.status == "completed" && run.verdict != null) "Verdict: ${run.verdict}"
        else VERDIKT_STATUS[run.status] ?: "Verdikt ${run.status}"

    fun verdiktTone(outcome: String?): Tone = when (outcome) {
        "pass" -> Tone.Ok
        "fail" -> Tone.Bad
        "warning", "blocked" -> Tone.Warn
        else -> Tone.Muted
    }

    fun verdiktOpen(run: VerdiktRunDto?): Boolean = run?.status == "queued" || run?.status == "running"

    /** Absolute URL for a portal-relative link (report redirect, etc.); absolute links pass through. */
    fun absoluteUrl(baseUrl: String, href: String): String =
        if (href.startsWith("http://") || href.startsWith("https://")) href
        else baseUrl.trimEnd('/') + "/" + href.trimStart('/')

    /* ---------- goal ancestry ---------- */

    /** Breadcrumb crumbs above this task: the objective, then each parent (the task itself is the page). */
    fun goalCrumbs(chain: GoalChainDto?): List<GoalNodeDto> =
        chain?.goalChain.orEmpty().filter { it.kind != "task" }

    fun goalCrumbLabel(node: GoalNodeDto): String = when (node.kind) {
        "objective" -> node.text?.takeIf { it.isNotBlank() }?.let { clip(it, 60) } ?: node.title.ifBlank { "Project objective" }
        else -> clip(node.title, 60)
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
