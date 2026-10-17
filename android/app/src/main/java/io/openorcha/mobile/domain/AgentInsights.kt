package io.openorcha.mobile.domain

import io.openorcha.mobile.data.AgentBudgetDto
import io.openorcha.mobile.data.BudgetUsage
import io.openorcha.mobile.data.TurnDto
import java.time.Instant
import java.time.OffsetDateTime
import java.time.YearMonth
import java.time.ZoneOffset
import java.time.format.TextStyle
import java.util.Locale
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/** Pure helpers for the agent slice (budgets, chat "Worked for", live changes). Unit-tested. */
object AgentInsights {

    // ---------------- time ----------------

    fun parseInstant(iso: String?): Instant? {
        if (iso.isNullOrBlank()) return null
        return runCatching { OffsetDateTime.parse(iso).toInstant() }.getOrNull()
            ?: runCatching { Instant.parse(if (iso.endsWith("Z")) iso else iso + "Z") }.getOrNull()
    }

    /**
     * "Worked for 47 sec" / "Worked for 3 min" / "Worked for 1 h 5 min" — null for gaps under
     * a second or over two hours (a reply that late isn't an honest work span). iOS
     * `ConversationView.workedForLabel` parity.
     */
    fun workedForLabel(secs: Double): String? {
        if (secs < 1 || secs >= 7200) return null
        val s = secs.roundToInt()
        if (s < 60) return "Worked for $s sec"
        val m = s / 60
        return if (m < 60) "Worked for $m min" else "Worked for ${m / 60} h ${m % 60} min"
    }

    /**
     * seq → "Worked for …" for each agent reply: the time since the human turn it answers
     * (iOS `withDayDividers`). Only the FIRST agent reply after a human turn gets one.
     */
    fun workedFor(turns: List<TurnDto>, humanId: String?): Map<Int, String> {
        val out = HashMap<Int, String>()
        var latestHuman: Instant? = null
        for (turn in turns) {
            val mine = turn.role == "human" || (humanId != null && turn.authorAgentId == humanId)
            if (mine) {
                latestHuman = parseInstant(turn.createdAt)
                continue
            }
            if (turn.role == "system") continue // system notes never carry a footer
            val start = latestHuman
            if (start != null) {
                val end = parseInstant(turn.createdAt)
                if (end != null) {
                    workedForLabel((end.toEpochMilli() - start.toEpochMilli()) / 1000.0)?.let { out[turn.seq] = it }
                }
            }
            latestHuman = null
        }
        return out
    }

    /** Live "Working · 12s" elapsed label. */
    fun elapsedLabel(secs: Long): String = when {
        secs < 60 -> "${secs.coerceAtLeast(0)}s"
        secs < 3600 -> "${secs / 60}m ${secs % 60}s"
        else -> "${secs / 3600}h ${(secs % 3600) / 60}m"
    }

    // ---------------- budgets (web budgetModel.ts parity) ----------------

    fun fmtUsd(v: Double?): String {
        val cents = ((v ?: 0.0) * 100).roundToLong()
        val whole = cents / 100
        val frac = (cents % 100).toString().padStart(2, '0')
        return "$" + String.format(Locale.US, "%,d", whole) + "." + frac
    }

    fun fmtTok(v: Long?): String {
        val n = (v ?: 0).toDouble()
        fun compact(x: Double, big: Boolean): String =
            if (big) x.roundToLong().toString() else String.format(Locale.US, "%.1f", x).removeSuffix(".0")
        return when {
            n >= 1_000_000 -> compact(n / 1_000_000, n >= 10_000_000) + "M"
            n >= 1_000 -> compact(n / 1_000, n >= 10_000) + "k"
            else -> n.roundToLong().toString()
        }
    }

    fun pctLabel(ratio: Double?): String = when {
        ratio == null -> ""
        ratio >= 9.99 -> ">999%"
        else -> "${(ratio * 100).roundToInt()}%"
    }

    /** Bar fill 0..1 (an overspend reads as a full bar). */
    fun meterFraction(ratio: Double?): Float = when {
        ratio == null -> 0f
        ratio.isNaN() || ratio.isInfinite() -> 1f
        else -> ratio.coerceIn(0.0, 1.0).toFloat()
    }

    enum class Tone { Ok, Warn, Over }

    fun meterTone(ratio: Double?): Tone = when {
        ratio == null -> Tone.Ok
        ratio >= 1 -> Tone.Over
        ratio >= 0.8 -> Tone.Warn
        else -> Tone.Ok
    }

    /** Nothing metered but runs happened: the dollar figure is unknown, never $0. */
    fun spendUnknown(u: BudgetUsage): Boolean = u.meteredRuns == 0 && u.unmeteredRuns > 0

    /** "Nov 1" — the UTC day the budget month resets. */
    fun fmtReset(iso: String?): String {
        val d = parseInstant(iso)?.atOffset(ZoneOffset.UTC) ?: return "next month"
        return d.month.getDisplayName(TextStyle.SHORT, Locale.US) + " " + d.dayOfMonth
    }

    /** "October 2026" from the 'YYYY-MM' period key. */
    fun fmtPeriod(period: String?): String {
        val ym = runCatching { YearMonth.parse(period ?: "") }.getOrNull() ?: return period.orEmpty()
        return ym.month.getDisplayName(TextStyle.FULL, Locale.US) + " " + ym.year
    }

    /** Verdict chip copy from the real state, never a default "On track". */
    fun healthLabel(b: AgentBudgetDto): String? = when (b.state) {
        "ok" -> "Within budget"
        "warning" -> "Near limit"
        "exceeded" -> if (b.paused) "Paused" else "Over · override"
        else -> null
    }

    fun pausedTitle(b: AgentBudgetDto): String =
        if (b.blockedBy == "project") "Paused for new runs — project budget reached" else "Paused for new runs"

    /** Only the agent's own budget can be overridden here; the project cap lives on the web. */
    fun canGrantOverride(b: AgentBudgetDto, memberRole: String?): Boolean =
        b.paused && b.blockedBy == "agent" && !b.override.active && memberRole?.lowercase() != "viewer"

    // ---------------- live changes ----------------

    private val imageExtensions = setOf("png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "heic", "heif")

    /** Image files the app can decode and preview (BitmapFactory formats; no SVG). */
    fun isPreviewableImage(path: String?): Boolean {
        val ext = path?.substringAfterLast('/')?.substringAfterLast('.', "")?.lowercase() ?: return false
        return ext in imageExtensions
    }

    fun changeStatusLabel(status: String): String = when (status) {
        "A", "??" -> "Added"
        "D" -> "Deleted"
        "R" -> "Renamed"
        else -> "Modified"
    }

    fun changeReasonCopy(reason: String?, detail: String?): String = when (reason) {
        null -> detail ?: "Changes aren't available for this run."
        "no_checkout", "missing_worktree", "worktree_missing" -> "The run's checkout isn't on this machine any more."
        else -> detail ?: "Changes aren't available for this run."
    }
}

/** Agent config history copy — web `configHistoryModel.ts` / iOS `AgentConfigHistoryUx` parity. */
object AgentConfigHistoryUx {
    fun fieldLabel(field: String): String = when (field) {
        "alias" -> "Name"
        "role" -> "Role"
        "system_prompt" -> "Prompt"
        "model" -> "Model"
        "reasoning_effort" -> "Reasoning effort"
        "auto_wake_interval_secs" -> "Auto-wake"
        "autonomy_override" -> "Autonomy"
        "provider" -> "Provider"
        else -> field.split('_').joinToString(" ") { w -> w.replaceFirstChar { it.uppercase() } }
    }

    private fun interval(secs: Long): String = when {
        secs > 0 && secs % 86400 == 0L -> if (secs == 86400L) "Daily" else "Every ${secs / 86400} days"
        secs > 0 && secs % 3600 == 0L -> if (secs == 3600L) "Hourly" else "Every ${secs / 3600} h"
        secs > 0 && secs % 60 == 0L -> "Every ${secs / 60} min"
        else -> "Every $secs s"
    }

    /** A value the way the Configuration screen shows it. Unset ≠ empty. */
    fun value(field: String, v: kotlinx.serialization.json.JsonElement?): String {
        val prim = v as? kotlinx.serialization.json.JsonPrimitive
        val text: String? = if (prim == null || prim is kotlinx.serialization.json.JsonNull) null else {
            val d = prim.content.toDoubleOrNull()
            if (!prim.isString && d != null && d == Math.rint(d)) d.toLong().toString() else prim.content
        }
        return when (field) {
            "auto_wake_interval_secs" -> text?.toDoubleOrNull()?.let { interval(it.toLong()) } ?: "Off"
            "autonomy_override" -> if (text == null) "Inherit project" else mapOf("plan" to "Plan", "pr" to "PR", "full" to "Full")[text] ?: text
            "reasoning_effort" -> if (text.isNullOrEmpty()) "Default" else text.replaceFirstChar { it.uppercase() }
            "model" -> text ?: "Default"
            "provider" -> if (text == null) "Unknown" else mapOf("claude" to "Claude", "codex" to "Codex")[text] ?: text
            else -> if (text.isNullOrEmpty()) "Not set" else text
        }
    }

    fun changedSummary(r: io.openorcha.mobile.data.ConfigRevisionDto): String =
        r.changes.filterNot { it.derived }.joinToString(", ") { fieldLabel(it.field).lowercase() }

    fun actorName(r: io.openorcha.mobile.data.ConfigRevisionDto): String =
        if (r.kind == "initial") "Embodent" else r.actor?.alias ?: "Unattributed"

    /** One sentence per revision, as the web history list reads. */
    fun sentence(r: io.openorcha.mobile.data.ConfigRevisionDto): String = when (r.kind) {
        "initial" -> "Initial configuration captured"
        "restore" -> "${actorName(r)} restored ${changedSummary(r)} from #${r.restoredFrom ?: "?"}"
        else -> "${actorName(r)} changed ${changedSummary(r)}"
    }
}

/** Org chart helpers — iOS `AgentOrgUx` / web OrgPage parity. */
object AgentOrgUx {
    data class Node(val id: String, val depth: Int)

    private fun reachesSelf(id: String, managerOf: Map<String, String>): Boolean {
        var cur = managerOf[id]
        val seen = HashSet<String>()
        while (cur != null && seen.add(cur)) {
            if (cur == id) return true
            cur = managerOf[cur]
        }
        return false
    }

    /** Depth-first: roots (no manager, a manager outside the set, or a loop) first, each followed by its reports. */
    fun flatten(order: List<String>, managerOf: Map<String, String>): List<Node> {
        val ids = order.toSet()
        val children = LinkedHashMap<String, MutableList<String>>()
        val roots = ArrayList<String>()
        for (id in order) {
            val m = managerOf[id]
            if (m != null && m in ids && m != id && !reachesSelf(id, managerOf)) children.getOrPut(m) { ArrayList() }.add(id)
            else roots.add(id)
        }
        val out = ArrayList<Node>()
        val seen = HashSet<String>()
        fun walk(id: String, depth: Int) {
            if (!seen.add(id)) return
            out.add(Node(id, depth))
            children[id]?.forEach { walk(it, depth + 1) }
        }
        roots.forEach { walk(it, 0) }
        return out
    }

    /** Every id below [id] (its reports, their reports, …) — cycle-safe. */
    fun descendants(id: String, managerOf: Map<String, String>): Set<String> {
        val down = HashMap<String, MutableList<String>>()
        managerOf.forEach { (child, manager) -> down.getOrPut(manager) { ArrayList() }.add(child) }
        val out = HashSet<String>()
        val stack = ArrayDeque(down[id].orEmpty())
        while (stack.isNotEmpty()) {
            val c = stack.removeLast()
            if (c == id || !out.add(c)) continue
            stack.addAll(down[c].orEmpty())
        }
        return out
    }

    data class Person(val id: String, val isHuman: Boolean, val retired: Boolean)

    /** Who [agentId] may report to: live people, never itself or one of its own reports (a loop). Humans first. */
    fun managerCandidates(agentId: String, people: List<Person>, managerOf: Map<String, String>): List<String> {
        val below = descendants(agentId, managerOf)
        val live = people.filter { it.id != agentId && !it.retired && it.id !in below }
        return live.filter { it.isHuman }.map { it.id } + live.filterNot { it.isHuman }.map { it.id }
    }

    fun changedToast(alias: String, managerAlias: String?): String =
        if (managerAlias != null) "$alias now reports to $managerAlias" else "$alias has no manager"
}

/** Budget limit editing + member gating (iOS `AgentBudgetUx.parseLimit` / `Access` parity). */
object AgentControlsUx {
    sealed interface Limit {
        data object None : Limit
        data object Invalid : Limit
        data class Value(val v: Double) : Limit
    }

    /** Blank = no limit; "$1,250.5" → 1250.5; tokens round to a whole number. */
    fun parseLimit(raw: String, integer: Boolean): Limit {
        val t = raw.trim().replace("$", "").replace(",", "").replace(" ", "")
        if (t.isEmpty()) return Limit.None
        val n = t.toDoubleOrNull() ?: return Limit.Invalid
        if (n.isNaN() || n.isInfinite() || n < 0) return Limit.Invalid
        return Limit.Value(if (integer) Math.rint(n) else Math.rint(n * 100) / 100)
    }

    /**
     * PUT body for the limits editor: both limits always sent — a blank field is an
     * explicit null (the server clears that limit), a key left OUT would be unchanged.
     */
    fun budgetLimitsJson(actorId: String, usd: Limit, tokens: Limit): kotlinx.serialization.json.JsonObject =
        kotlinx.serialization.json.buildJsonObject {
            put("actor_agent_id", kotlinx.serialization.json.JsonPrimitive(actorId))
            put("monthly_limit_usd", (usd as? Limit.Value)?.let { kotlinx.serialization.json.JsonPrimitive(it.v) } ?: kotlinx.serialization.json.JsonNull)
            put("monthly_limit_tokens", (tokens as? Limit.Value)?.let { kotlinx.serialization.json.JsonPrimitive(it.v.toLong()) } ?: kotlinx.serialization.json.JsonNull)
        }

    fun overrideJson(actorId: String, grant: Boolean): kotlinx.serialization.json.JsonObject =
        kotlinx.serialization.json.buildJsonObject {
            put("actor_agent_id", kotlinx.serialization.json.JsonPrimitive(actorId))
            put("override", kotlinx.serialization.json.JsonPrimitive(if (grant) "grant" else "revoke"))
        }

    /** "1250.00" for the editor's initial text; blank when unset. */
    fun usdField(v: Double?): String = v?.let { String.format(Locale.US, "%.2f", it) }.orEmpty()

    /**
     * Owner-or-grant gate over `/api/me` (honest UI only; the server still enforces 403).
     * Unknown / trust-off = permissive (the paired-human convention); not a member or a
     * viewer = no management writes.
     */
    fun canManage(me: io.openorcha.mobile.data.MeDto?, grant: String): Boolean {
        if (me == null || !me.trusted) return true
        val id = me.identity ?: return false
        if (id.memberRole == "viewer") return false
        return id.memberRole == "owner" || grant in id.grants
    }

    /** Headless + resident runs, de-duplicated, newest first (iOS `loadAgentDetail`). */
    fun mergeRuns(
        headless: List<io.openorcha.mobile.data.RunDto>,
        resident: List<io.openorcha.mobile.data.RunDto>,
    ): List<io.openorcha.mobile.data.RunDto> =
        (headless + resident).distinctBy { it.runId }.sortedByDescending { it.startedAt.orEmpty() }
}
