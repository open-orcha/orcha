package io.openorcha.mobile.domain

import io.openorcha.mobile.data.AgentDto
import io.openorcha.mobile.data.RequestDto
import io.openorcha.mobile.data.TaskDto
import io.openorcha.mobile.data.TaskMessageDto
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Flow-spec pure logic (design package flows 05/07/09/11 + component inventory doc 12).
 * These mappings are BINDING contracts from the design docs — screens render them verbatim.
 */
class MobileUxSelectorsTest {

    // ---------- flow 07 §grouping: the four request groups ----------

    private val h = "human-1"

    private fun req(
        id: String,
        status: String = "open",
        requester: String? = "a1",
        target: String? = h,
        expires: String? = null,
        created: String? = null,
    ) = RequestDto(
        id = id, status = status, requesterId = requester, targetId = target,
        expiresAt = expires, createdAt = created, payload = "p",
    )

    @Test
    fun requestGroupsFollowTheBindingMatrix() {
        val rows = listOf(
            req("needs-1", status = "open", requester = "a1", target = h),
            req("needs-2", status = "open", requester = "a1", target = null),     // escalated → human
            req("not-mine", status = "open", requester = "a1", target = "a2"),
            req("waiting-1", status = "open", requester = h, target = "a1"),
            req("waiting-2", status = "accepted", requester = h, target = "a1"),
            req("answered-1", status = "answered", requester = h, target = "a1"),
            req("done-1", status = "closed", requester = h, target = "a1"),
            req("done-2", status = "rejected", requester = "a1", target = h),
            req("done-3", status = "converted_to_task", requester = h, target = "a1"),
            req("done-other", status = "closed", requester = "a1", target = "a2"), // not involving me
        )
        val g = MobileUx.requestGroups(rows, h)
        assertEquals(listOf("needs-1", "needs-2"), g.needsYourAnswer.map { it.id })
        assertEquals(listOf("waiting-1", "waiting-2"), g.waitingOnOthers.map { it.id })
        assertEquals(listOf("answered-1"), g.answeredActOnIt.map { it.id })
        assertEquals(setOf("done-1", "done-2", "done-3"), g.done.map { it.id }.toSet())
        // tab badge = needs answer + answered-act-on-it
        assertEquals(3, g.badgeCount)
    }

    @Test
    fun needsAnswerOrdersExpiringSoonestFirst() {
        val rows = listOf(
            req("late", expires = "2026-07-01T23:00:00Z", created = "2026-07-01T10:00:00Z"),
            req("soon", expires = "2026-07-01T21:00:00Z", created = "2026-07-01T12:00:00Z"),
            req("none", expires = null, created = "2026-07-01T09:00:00Z"),
        )
        val g = MobileUx.requestGroups(rows, h)
        assertEquals(listOf("soon", "late", "none"), g.needsYourAnswer.map { it.id })
    }

    // ---------- flow 11/05: priority bands (Low/Normal/High ↔ 300/100/20) ----------

    @Test
    fun priorityBandsMatchPortalThresholds() {
        assertEquals(PriorityBand.High, MobileUx.priorityBand(20))
        assertEquals(PriorityBand.High, MobileUx.priorityBand(5))
        assertEquals(PriorityBand.Elevated, MobileUx.priorityBand(40))
        assertEquals(PriorityBand.Normal, MobileUx.priorityBand(100))
        assertEquals(PriorityBand.Normal, MobileUx.priorityBand(null))
        assertEquals(PriorityBand.Normal, MobileUx.priorityBand(300))
        assertEquals(20, MobileUx.priorityFor(PriorityBand.High))
        assertEquals(100, MobileUx.priorityFor(PriorityBand.Normal))
        assertEquals(300, MobileUx.priorityFor(PriorityBand.Low))
    }

    // ---------- flow 09: agent roster ordering ----------

    @Test
    fun agentOrderPutsWorkingFirstAndTerminatedLast() {
        fun agent(id: String, status: String?) = AgentDto(id = id, alias = id, status = status)
        val sorted = MobileUx.orderAgents(
            listOf(
                agent("idle", "idle"),
                agent("dead", "terminated"),
                agent("working", "working"),
                agent("needs-human", "awaiting_human"),
                agent("blocked", "blocked"),
                agent("waiting", "awaiting_request"),
            ),
        )
        assertEquals(
            listOf("working", "needs-human", "blocked", "waiting", "idle", "dead"),
            sorted.map { it.id },
        )
    }

    // ---------- doc 12: binding status display copy ----------

    @Test
    fun statusCopyMatchesComponentInventory() {
        assertEquals("needs verification", MobileUx.statusCopy("needs_verification"))
        assertEquals("became a task", MobileUx.statusCopy("converted_to_task"))
        assertEquals("waiting on a request", MobileUx.statusCopy("awaiting_request"))
        assertEquals("waiting on you", MobileUx.statusCopy("awaiting_human"))
        assertEquals("in progress", MobileUx.statusCopy("in_progress"))
        assertEquals("open", MobileUx.statusCopy("open"))
        assertEquals("not ready", MobileUx.statusCopy("not_ready"))
    }

    // ---------- flow 05: "Needs me" chip + status group order ----------

    @Test
    fun needsMeIsVerificationsPlusUndecidedPlans() {
        val tasks = listOf(
            TaskDto(id = "v", title = "v", status = "needs_verification"),
            TaskDto(id = "p", title = "p", status = "in_progress", planMessage = TaskMessageDto(body = "plan")),
            TaskDto(id = "decided", title = "d", status = "in_progress",
                planMessage = TaskMessageDto(body = "plan"), planDecision = "approve"),
            TaskDto(id = "plain", title = "x", status = "ready"),
        )
        assertEquals(setOf("v", "p"), MobileUx.needsMe(tasks).map { it.id }.toSet())
    }

    @Test
    fun taskGroupOrderFollowsFlow05() {
        val order = listOf(
            "in_progress", "blocked", "needs_verification", "ready",
            "pending", "not_ready", "completed", "cancelled",
        )
        assertEquals(order, order.shuffled().sortedBy { MobileUx.taskGroupRank(it) })
        assertTrue(MobileUx.taskGroupRank("weird_status") > MobileUx.taskGroupRank("cancelled"))
        // terminal groups collapse by default
        assertTrue(MobileUx.isTerminalGroup("completed"))
        assertTrue(MobileUx.isTerminalGroup("cancelled"))
        assertTrue(!MobileUx.isTerminalGroup("in_progress"))
    }

    // ---------- shared: relative time ("updated 12m ago", heartbeat) ----------

    @Test
    fun relativeAgoRendersCompactUnits() {
        val now = 1_751_400_000_000L // fixed clock
        fun iso(deltaMs: Long): String {
            val t = java.time.Instant.ofEpochMilli(now - deltaMs)
            return t.toString()
        }
        assertEquals("just now", MobileUx.agoLabel(iso(20_000), now))
        assertEquals("5m ago", MobileUx.agoLabel(iso(5 * 60_000), now))
        assertEquals("2h ago", MobileUx.agoLabel(iso(2 * 3_600_000), now))
        assertEquals("3d ago", MobileUx.agoLabel(iso(3 * 86_400_000), now))
        assertEquals(null, MobileUx.agoLabel(null, now))
        assertEquals(null, MobileUx.agoLabel("not-a-date", now))
    }
}
