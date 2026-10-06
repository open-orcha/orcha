package io.openorcha.mobile.ui.screens

import io.openorcha.mobile.data.AgentDto
import io.openorcha.mobile.domain.RequestChip
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** Pure copy/mapping helpers behind the Linear agents roster and requests list. */
class AgentsRequestsLinearTest {

    @Test fun agentStatusCapsuleCopyMatchesIos() {
        assertEquals("Working", agentStatusLabel("working"))
        assertEquals("Waiting", agentStatusLabel("awaiting_request"))
        assertEquals("Waiting", agentStatusLabel("blocked"))
        assertEquals("Needs you", agentStatusLabel("awaiting_human"))
        assertEquals("Idle", agentStatusLabel("idle"))
        assertEquals("Offline", agentStatusLabel("offline"))
        assertEquals("Retired", agentStatusLabel("terminated"))
        assertEquals("Paused now", agentStatusLabel("paused_now"))
    }

    @Test fun humanRoleTagOnlyNamesMembershipRoles() {
        assertEquals("Owner", humanRoleTag(AgentDto(id = "h", alias = "h", kind = "human", role = "owner")))
        assertEquals("Viewer", humanRoleTag(AgentDto(id = "h", alias = "h", kind = "human", role = "Viewer")))
        assertNull(humanRoleTag(AgentDto(id = "h", alias = "h", kind = "human", role = "tech lead")))
        assertNull(humanRoleTag(AgentDto(id = "h", alias = "h", kind = "human")))
    }

    @Test fun escalationsLensReadsToAHuman() {
        assertEquals("To a human", requestLensLabel(RequestChip.Escalations))
        assertEquals("Open", requestLensLabel(RequestChip.Open))
    }

    @Test fun requestGlyphUsesTheRequestsOwnStatus() {
        assertEquals("escalated", requestGlyphStatus("open", escalated = true))
        assertEquals("open", requestGlyphStatus("open", escalated = false))
        assertEquals("answered", requestGlyphStatus("answered", escalated = false))
        assertEquals("rejected", requestGlyphStatus("rejected", escalated = false))
    }
}
