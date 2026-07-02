package io.openorcha.mobile.domain

import io.openorcha.mobile.data.AgentDto
import io.openorcha.mobile.data.RequestDto
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Issue 1: the requests screen's chips/sort/alias selectors must match the web's
 * client-side mechanism exactly (requests.html:88-148, app.js:247-256 + 1600-1673,
 * data.js:118-119).
 */
class RequestsViewTest {
    private val agents = listOf(
        AgentDto(id = "h1", alias = "kedar", kind = "human"),
        AgentDto(id = "a1", alias = "Andrew", kind = "ai"),
        AgentDto(id = "a2", alias = "Informer", kind = "ai"),
    )

    private fun req(
        id: String,
        status: String = "open",
        type: String = "info",
        target: String? = "a1",
        requester: String? = "a2",
        priority: Int? = null,
        createdAt: String? = null,
    ) = RequestDto(
        id = id, status = status, type = type, targetId = target,
        requesterId = requester, priority = priority, createdAt = createdAt,
    )

    /* ---------- alias resolution (server rows never carry aliases) ---------- */

    @Test
    fun aliasForResolvesFromSnapshotAgents() {
        assertEquals("Andrew", RequestsView.aliasFor(agents, "a1"))
        assertEquals("kedar", RequestsView.aliasFor(agents, "h1"))
        assertNull(RequestsView.aliasFor(agents, null))
        assertNull(RequestsView.aliasFor(agents, "unknown"))
    }

    @Test
    fun kindForDistinguishesHumansFromAgents() {
        assertEquals("human", RequestsView.kindFor(agents, "h1"))
        assertEquals("ai", RequestsView.kindFor(agents, "a1"))
        assertNull(RequestsView.kindFor(agents, null))
    }

    /* ---------- chip predicates (web matches(), incl. isToHuman) ---------- */

    @Test
    fun escalationsChipIsToHumanWithNoStatusFilter() {
        // null target → to-human (web isToHuman), regardless of status
        assertTrue(RequestsView.matchesChip(req("r", status = "closed", target = null), RequestChip.Escalations, agents))
        // human-kind target → to-human
        assertTrue(RequestsView.matchesChip(req("r", status = "answered", target = "h1"), RequestChip.Escalations, agents))
        // agent target → not an escalation even when open
        assertFalse(RequestsView.matchesChip(req("r", status = "open", target = "a1"), RequestChip.Escalations, agents))
    }

    @Test
    fun statusAndTypeChipsMatchWebPredicates() {
        assertTrue(RequestsView.matchesChip(req("r", status = "open"), RequestChip.Open, agents))
        assertFalse(RequestsView.matchesChip(req("r", status = "accepted"), RequestChip.Open, agents))
        assertTrue(RequestsView.matchesChip(req("r", status = "answered"), RequestChip.Answered, agents))
        assertTrue(RequestsView.matchesChip(req("r", type = "task"), RequestChip.TaskReqs, agents))
        assertFalse(RequestsView.matchesChip(req("r", type = "info"), RequestChip.TaskReqs, agents))
        assertTrue(RequestsView.matchesChip(req("r", status = "rejected"), RequestChip.All, agents))
    }

    @Test
    fun escalatedPillNeedsOpenAndHumanTargeted() {
        // the danger pill (web requests.html:135) is stricter than the chip: open only
        assertTrue(RequestsView.isEscalatedOpen(req("r", status = "open", target = null), agents))
        assertFalse(RequestsView.isEscalatedOpen(req("r", status = "answered", target = null), agents))
        assertFalse(RequestsView.isEscalatedOpen(req("r", status = "open", target = "a1"), agents))
    }

    /* ---------- sort (web sortComparator: bucket, key, dir, tiebreak) ---------- */

    @Test
    fun statusBucketAlwaysOutranksTheChosenKey() {
        val rows = listOf(
            req("closed-new", status = "closed", createdAt = "2026-07-02T10:00:00Z"),
            req("answered", status = "answered", createdAt = "2026-07-01T10:00:00Z"),
            req("open-old", status = "open", createdAt = "2026-06-01T10:00:00Z"),
        )
        val sorted = RequestsView.sort(rows, RequestSort(SortKey.Time, ascending = false))
        assertEquals(listOf("open-old", "answered", "closed-new"), sorted.map { it.id })
    }

    @Test
    fun timeDescIsDefaultAndTimeAscFlips() {
        val rows = listOf(
            req("old", createdAt = "2026-06-01T00:00:00Z"),
            req("new", createdAt = "2026-07-01T00:00:00Z"),
        )
        assertEquals(listOf("new", "old"), RequestsView.sort(rows, RequestSort()).map { it.id })
        assertEquals(listOf("old", "new"), RequestsView.sort(rows, RequestSort(SortKey.Time, ascending = true)).map { it.id })
    }

    @Test
    fun priorityAscendingMeansHigherPriorityFirstAndTimeTiebreaksNewestFirst() {
        val rows = listOf(
            req("p100-old", priority = 100, createdAt = "2026-06-01T00:00:00Z"),
            req("p20", priority = 20, createdAt = "2026-06-15T00:00:00Z"),
            req("p100-new", priority = 100, createdAt = "2026-07-01T00:00:00Z"),
        )
        val sorted = RequestsView.sort(rows, RequestSort(SortKey.Priority, ascending = true))
        // lower number = more urgent = first; equal priority → newest first
        assertEquals(listOf("p20", "p100-new", "p100-old"), sorted.map { it.id })
    }

    @Test
    fun missingPriorityDefaultsTo100AndMissingTimeSortsAsEmpty() {
        val rows = listOf(
            req("no-prio", priority = null, createdAt = "2026-07-01T00:00:00Z"),
            req("urgent", priority = 1, createdAt = null),
        )
        val sorted = RequestsView.sort(rows, RequestSort(SortKey.Priority, ascending = true))
        assertEquals(listOf("urgent", "no-prio"), sorted.map { it.id })
    }
}
