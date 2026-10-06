package io.openorcha.mobile.domain

/**
 * Turns raw backend activity text into user-facing copy for every feed (Home updates,
 * task activity / thread, search, run rows, agent recent runs). Pure — no Android deps.
 *
 *  - `[DECISION · plan_approval = APPROVED by hussein-owner]`            → "Approved the plan"
 *  - `[DECISION · plan_approval = REJECTED by hussein-owner] — reason`   → "Rejected the plan — reason"
 *  - `[verification rejected] Flaky…`                                     → "Rejected verification — Flaky…"
 *  - `[verification approved] note`                                       → "Verified — note"
 *  - raw kinds such as `task_assigned` / `conversation_turn`              → "Task assigned" / "Conversation turn"
 *
 * Anything else is returned unchanged.
 */
object ActivityCopy {

    private val decision = Regex(
        """^\[\s*DECISION\s*[·•.:\-]?\s*([A-Za-z0-9_\-]+)\s*=\s*(APPROVED|REJECTED|APPROVE|REJECT)\b[^\]]*]\s*(.*)$""",
        setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL),
    )
    private val verification = Regex(
        """^\[\s*verification\s+(approved|rejected|verified)\s*]\s*(.*)$""",
        setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL),
    )
    private val rawKind = Regex("""^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$""")
    private val leadingSeparators = Regex("""^[\s—–\-:·]+""")

    /** Humanized copy for one activity/message line. */
    fun humanize(text: String?): String {
        val raw = text?.trim().orEmpty()
        if (raw.isEmpty()) return ""
        decision.matchEntire(raw)?.let { m ->
            val subject = decisionSubject(m.groupValues[1])
            val approved = m.groupValues[2].uppercase().startsWith("APPROVE")
            val rest = tail(m.groupValues[3])
            val head = if (approved) "Approved $subject" else "Rejected $subject"
            return withTail(head, rest)
        }
        verification.matchEntire(raw)?.let { m ->
            val rejected = m.groupValues[1].equals("rejected", ignoreCase = true)
            val rest = tail(m.groupValues[2])
            return withTail(if (rejected) "Rejected verification" else "Verified", rest)
        }
        if (rawKind.matches(raw)) return humanizeKind(raw)
        return raw
    }

    /** `task_assigned` → "Task assigned"; blank → "". */
    fun humanizeKind(kind: String?): String {
        val k = kind?.trim().orEmpty()
        if (k.isEmpty()) return ""
        return k.replace('_', ' ').replace(Regex("\\s+"), " ").lowercase().replaceFirstChar { it.uppercase() }
    }

    private fun decisionSubject(key: String): String = when (key.lowercase()) {
        "plan_approval", "plan", "plan-approval" -> "the plan"
        "verification", "verify" -> "verification"
        else -> "the " + humanizeKind(key).lowercase()
    }

    private fun tail(s: String): String = s.replace(leadingSeparators, "").trim()

    private fun withTail(head: String, rest: String): String = if (rest.isEmpty()) head else "$head — $rest"

    /**
     * One-line feed preview: humanized, markdown markers (`##`, backticks, `**`) dropped,
     * lines joined — so a plan reads "Plan 1. Add POST /webhooks/stripe…" not "## Plan".
     */
    fun preview(text: String?): String =
        humanize(text).lines()
            .map { it.trim().trimStart('#').trim() }
            .filter { it.isNotEmpty() }
            .joinToString(" ")
            .replace("**", "")
            .replace("`", "")
}
