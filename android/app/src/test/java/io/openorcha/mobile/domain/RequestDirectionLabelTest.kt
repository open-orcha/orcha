package io.openorcha.mobile.domain

import io.openorcha.mobile.data.AgentDto
import io.openorcha.mobile.data.RequestDto
import kotlin.test.Test
import kotlin.test.assertEquals

/** Search's "from → to" line uses "you" for the paired human, like the Requests tab. */
class RequestDirectionLabelTest {
    private val agents = listOf(
        AgentDto(id = "forge", alias = "Forge", kind = "ai"),
        AgentDto(id = "h1", alias = "hussein-owner", kind = "human"),
    )

    @Test fun targetIsPairedHuman() {
        val r = RequestDto(id = "r", payload = "q", status = "open", requesterId = "forge", targetId = "h1", targetAlias = "hussein-owner")
        assertEquals("Forge → you", RequestsView.directionLabel(r, agents, humanId = "h1"))
    }

    @Test fun nullTargetMeansYou() {
        val r = RequestDto(id = "r", payload = "q", status = "open", requesterId = "forge", targetId = null)
        assertEquals("Forge → you", RequestsView.directionLabel(r, agents, humanId = "h1"))
    }

    @Test fun fromYouToAgent() {
        val r = RequestDto(id = "r", payload = "q", status = "open", requesterId = "h1", targetId = "forge")
        assertEquals("You → Forge", RequestsView.directionLabel(r, agents, humanId = "h1"))
    }
}
