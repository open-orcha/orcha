package io.openorcha.mobile.domain

import io.openorcha.mobile.data.AgentDto
import io.openorcha.mobile.data.RequestDto
import io.openorcha.mobile.data.TaskDto
import java.time.Instant

/** Priority bands (flow 11 §priority + flow 05 card tinting): Low/Normal/High ↔ 300/100/20. */
enum class PriorityBand { Low, Normal, Elevated, High }

/** Flow 07 expiry chip: warn countdown under 2h, expired past `expires_at` (row dims). */
sealed class ExpiryChip {
    data class Warn(val label: String) : ExpiryChip()
    object Expired : ExpiryChip() {
        override fun toString(): String = "Expired"
    }
}

/** The four request groups of flow 07 — a BINDING matrix from the design package. */
data class RequestGroups(
    val needsYourAnswer: List<RequestDto>,
    val waitingOnOthers: List<RequestDto>,
    val answeredActOnIt: List<RequestDto>,
    val done: List<RequestDto>,
) {
    /** Requests-tab badge = things the human can act on right now (flow 07 §list). */
    val badgeCount: Int = needsYourAnswer.size + answeredActOnIt.size
}

/**
 * Pure UX selectors specified by the mobile design package (docs/design/mobile flows).
 * Everything here is copy/ordering CONTRACT — screens render these verbatim, so they are
 * unit-tested against the design docs rather than restyled per screen.
 */
object MobileUx {

    // ---------- flow 07: request grouping ----------

    fun requestGroups(requests: List<RequestDto>, humanId: String?): RequestGroups {
        val open = setOf("open")
        val doneStates = setOf("closed", "rejected", "converted_to_task")
        fun expiryKey(r: RequestDto): String = r.expiresAt ?: "9999"
        val needs = requests
            .filter { it.status in open && (it.targetId == humanId || it.targetId == null) }
            .sortedWith(compareBy({ expiryKey(it) }, { it.createdAt ?: "" }))
        val waiting = requests
            .filter { it.status in setOf("open", "accepted") && it.requesterId == humanId }
            .sortedWith(compareBy<RequestDto> { expiryKey(it) }.thenByDescending { it.createdAt ?: "" })
        val answered = requests
            .filter { it.status == "answered" && it.requesterId == humanId }
            .sortedByDescending { it.createdAt ?: "" }
        val done = requests
            .filter { it.status in doneStates && (it.requesterId == humanId || it.targetId == humanId) }
            .sortedByDescending { it.closedAt ?: it.createdAt ?: "" }
        return RequestGroups(needs, waiting, answered, done)
    }

    // ---------- flows 11 + 05: priority ----------

    fun priorityBand(priority: Int?): PriorityBand = when {
        priority == null -> PriorityBand.Normal
        priority <= 20 -> PriorityBand.High
        priority <= 40 -> PriorityBand.Elevated
        else -> PriorityBand.Normal
    }

    fun priorityFor(band: PriorityBand): Int = when (band) {
        PriorityBand.High -> 20
        PriorityBand.Elevated -> 40
        PriorityBand.Normal -> 100
        PriorityBand.Low -> 300
    }

    // ---------- flow 09: roster order (working first, terminated last) ----------

    fun orderAgents(agents: List<AgentDto>): List<AgentDto> =
        agents.sortedBy {
            when (it.status) {
                "working" -> 0
                "awaiting_human" -> 1
                "blocked" -> 2
                "awaiting_request" -> 3
                "idle" -> 4
                "terminated" -> 9
                else -> 5
            }
        }

    // ---------- doc 12: binding status display copy ----------

    fun statusCopy(status: String): String = when (status) {
        "needs_verification" -> "needs verification"
        "converted_to_task" -> "became a task"
        "awaiting_request" -> "waiting on a request"
        "awaiting_human" -> "waiting on you"
        "in_progress" -> "in progress"
        else -> status.replace('_', ' ')
    }

    // ---------- flow 05: "Needs me" chip + status group order ----------

    /** needs_verification tasks + in_progress tasks with an undecided plan approval. */
    fun needsMe(tasks: List<TaskDto>): List<TaskDto> = tasks.filter {
        it.status == "needs_verification" ||
            (it.status == "in_progress" && it.planMessage != null && it.planDecision == null)
    }

    fun taskGroupRank(status: String): Int = when (status) {
        "in_progress" -> 0
        "blocked" -> 1
        "needs_verification" -> 2
        "ready" -> 3
        "pending" -> 4
        "not_ready" -> 5
        "completed" -> 6
        "cancelled" -> 7
        else -> 8
    }

    /** Terminal groups render collapsed by default (flow 05 §list). */
    fun isTerminalGroup(status: String): Boolean = status == "completed" || status == "cancelled"

    // ---------- shared: compact relative time ----------

    /** Flow 07: expiry chip state. No chip ≥2h out; warn countdown inside 2h; expired past. */
    fun expiryChip(expiresAt: String?, nowMs: Long = System.currentTimeMillis()): ExpiryChip? {
        if (expiresAt.isNullOrBlank()) return null
        val then = runCatching { Instant.parse(if (expiresAt.endsWith("Z") || expiresAt.contains("+")) expiresAt else expiresAt + "Z") }
            .getOrNull() ?: return null
        val deltaMin = (then.toEpochMilli() - nowMs) / 60_000
        return when {
            deltaMin < 0 -> ExpiryChip.Expired
            deltaMin >= 120 -> null
            deltaMin >= 60 -> ExpiryChip.Warn("expires in ${deltaMin / 60}h ${deltaMin % 60}m")
            else -> ExpiryChip.Warn("expires in ${deltaMin}m")
        }
    }

    /** Flow 10 day dividers: stable calendar-day key + short label (UTC-keyed). */
    fun dayKey(iso: String?): String? {
        if (iso.isNullOrBlank()) return null
        return runCatching { iso.substring(0, 10).also { java.time.LocalDate.parse(it) } }.getOrNull()
    }

    fun dayLabel(iso: String?): String? {
        val key = dayKey(iso) ?: return null
        val d = java.time.LocalDate.parse(key)
        val month = d.month.getDisplayName(java.time.format.TextStyle.SHORT, java.util.Locale.US)
        return "$month ${d.dayOfMonth}"
    }

    fun agoLabel(iso: String?, nowMs: Long = System.currentTimeMillis()): String? {
        if (iso.isNullOrBlank()) return null
        val then = runCatching { Instant.parse(if (iso.endsWith("Z") || iso.contains("+")) iso else iso + "Z") }
            .getOrNull() ?: return null
        val delta = nowMs - then.toEpochMilli()
        val mins = delta / 60_000
        return when {
            mins < 1 -> "just now"
            mins < 60 -> "${mins}m ago"
            mins < 60 * 24 -> "${mins / 60}h ago"
            else -> "${mins / (60 * 24)}d ago"
        }
    }
}
