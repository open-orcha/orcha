package io.openorcha.mobile.domain

import io.openorcha.mobile.data.AgentDto
import io.openorcha.mobile.data.RequestDto

/** The web requests page's five single-select filter chips (requests.html FILTERS). */
enum class RequestChip(val label: String) {
    All("All"),
    Open("Open"),
    Answered("Answered"),
    Escalations("Escalations"),
    TaskReqs("Task reqs"),
}

enum class SortKey { Time, Priority }

/**
 * Flow 07a operator-action tier — Nudge + Close on ANY request the human can see, computed
 * purely from status + owner/target identity (spec `07a-nudge-close-any-request.md` §4). The
 * role-specific "Your move" buttons layer above this; the operator tier itself does not depend
 * on role, only on state. `you` = the paired human's agent id (null before pairing resolves).
 */
data class OperatorActions(
    val showNudge: Boolean,
    val showClose: Boolean,
    /** Close needs a reason (routed to the owner) whenever the human didn't send the request. */
    val closeNeedsReason: Boolean,
    /** The "acting as operator" note — only when the human is neither requester nor target. */
    val showOperatorNote: Boolean,
    /** Who a nudge would wake: target on `open`, requester on `answered`; null when nudge hidden. */
    val nudgeRecipientId: String?,
)

/** Web sort control state (app.js sortState): key + direction. Default: time desc. */
data class RequestSort(val key: SortKey = SortKey.Time, val ascending: Boolean = false)

/**
 * Client-side filtering/sorting over the snapshot's requests — the web's exact mechanism
 * (the windowed GET /containers/{cid}/requests has no type/escalation params, so chips
 * MUST be client-side; requests.html:88-148 + app.js:1600-1673 are the parity source).
 */
object RequestsView {

    /** Web aliasFor (data.js:118-119): id → alias via the snapshot's agents. */
    fun aliasFor(agents: List<AgentDto>, agentId: String?): String? =
        agentId?.let { id -> agents.firstOrNull { it.id == id }?.alias }

    fun kindFor(agents: List<AgentDto>, agentId: String?): String? =
        agentId?.let { id -> agents.firstOrNull { it.id == id }?.kind }

    /** Web isToHuman (app.js:247-256): null target → the picked human; else target kind == human. */
    fun isToHuman(request: RequestDto, agents: List<AgentDto>): Boolean {
        val targetId = request.targetId ?: return true
        return kindFor(agents, targetId) == "human"
    }

    /** Web `escd` (requests.html:135): the danger "escalated" pill = OPEN and human-targeted. */
    fun isEscalatedOpen(request: RequestDto, agents: List<AgentDto>): Boolean =
        request.status == "open" && isToHuman(request, agents)

    /** Web matches() (requests.html:94-101) — the chip predicates, verbatim. */
    fun matchesChip(request: RequestDto, chip: RequestChip, agents: List<AgentDto>): Boolean = when (chip) {
        RequestChip.All -> true
        RequestChip.Open -> request.status == "open"
        RequestChip.Answered -> request.status == "answered"
        RequestChip.Escalations -> isToHuman(request, agents) // NO status filter (web parity)
        RequestChip.TaskReqs -> request.type == "task"
    }

    /**
     * Flow 07a §4 rule-of-thumb, verbatim:
     * - `showClose = status ∈ {open, answered, accepted}` (any non-terminal).
     * - `showNudge = status ∈ {open, answered}` minus `(open && target==you)` and
     *   `(answered && requester==you)` — nudging then would only wake yourself.
     * - `closeNeedsReason = requesterId != you`.
     * - operator note shows only when you are neither requester nor target.
     *
     * A `null` target means the ask was escalated to the paired human — the human is then its
     * effective answerer, so it counts as `target==you` (nudging it would only wake a human).
     */
    fun operatorActions(request: RequestDto, humanId: String?): OperatorActions {
        val status = request.status
        val iAmRequester = humanId != null && request.requesterId == humanId
        val iAmTarget = request.targetId == humanId || request.targetId == null
        val showNudge = (status == "open" || status == "answered") &&
            !(status == "open" && iAmTarget) &&
            !(status == "answered" && iAmRequester)
        return OperatorActions(
            showNudge = showNudge,
            showClose = status == "open" || status == "answered" || status == "accepted",
            closeNeedsReason = !iAmRequester,
            showOperatorNote = !iAmRequester && !iAmTarget,
            nudgeRecipientId = when {
                !showNudge -> null
                status == "open" -> request.targetId
                else -> request.requesterId
            },
        )
    }

    /** Web REQ_STATUS_RANK: the OUTER bucket stays open → answered → everything else. */
    fun statusBucket(request: RequestDto): Int = when (request.status) {
        "open" -> 0
        "answered" -> 1
        else -> 2
    }

    /**
     * Web sortComparator (app.js:1632-1648): status bucket first; the chosen key sorts
     * within it (priority ascending = higher priority first, lower number wins); the
     * unchosen key is the tiebreaker — priority-sort tiebreaks newest-first, time-sort
     * tiebreaks highest-priority-first.
     */
    fun sort(requests: List<RequestDto>, sort: RequestSort): List<RequestDto> {
        val sign = if (sort.ascending) 1 else -1
        return requests.sortedWith(
            Comparator { a, b ->
                val bucket = statusBucket(a) - statusBucket(b)
                if (bucket != 0) return@Comparator bucket
                val timeA = a.createdAt ?: ""
                val timeB = b.createdAt ?: ""
                val prioA = a.priority ?: 100
                val prioB = b.priority ?: 100
                if (sort.key == SortKey.Priority) {
                    val d = prioA - prioB
                    if (d != 0) return@Comparator sign * d
                    timeB.compareTo(timeA) // tiebreak: newest first
                } else {
                    val d = timeA.compareTo(timeB)
                    if (d != 0) return@Comparator sign * d // asc = oldest first
                    prioA - prioB // tiebreak: highest priority first
                }
            },
        )
    }
}
