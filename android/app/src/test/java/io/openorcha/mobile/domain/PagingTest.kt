package io.openorcha.mobile.domain

import io.openorcha.mobile.data.TaskMessageDto
import io.openorcha.mobile.data.TurnDto
import kotlin.test.Test
import kotlin.test.assertEquals

/** Issue 4: pure merge helpers for keyset thread pages and conversation deltas. */
class PagingTest {
    private fun msg(id: String, body: String = id) = TaskMessageDto(messageId = id, body = body)

    @Test
    fun prependOlderKeepsOrderAndDropsSeamDuplicates() {
        val existing = listOf(msg("c"), msg("d"))
        val older = listOf(msg("a"), msg("b"), msg("c")) // "c" replayed at the seam
        val merged = Paging.prependOlder(existing, older) { it.messageId }
        assertEquals(listOf("a", "b", "c", "d"), merged.map { it.messageId })
    }

    @Test
    fun mergeNewestReplacesCoveredRowsAndKeepsEarlierPagesInFront() {
        val existing = listOf(msg("a"), msg("b"), msg("c"))
        val newest = listOf(msg("c", body = "c-updated"), msg("d"))
        val merged = Paging.mergeNewest(existing, newest) { it.messageId }
        assertEquals(listOf("a", "b", "c", "d"), merged.map { it.messageId })
        assertEquals("c-updated", merged[2].body)
    }

    @Test
    fun mergeNewestOnEmptyIsJustTheFreshPage() {
        val merged = Paging.mergeNewest(emptyList(), listOf(msg("a")), { it.messageId })
        assertEquals(listOf("a"), merged.map { it.messageId })
    }

    @Test
    fun appendTurnsDropsReplayedSeqs() {
        val existing = listOf(TurnDto(seq = 1), TurnDto(seq = 2))
        val delta = listOf(TurnDto(seq = 2), TurnDto(seq = 3), TurnDto(seq = 4))
        val merged = Paging.appendTurns(existing, delta)
        assertEquals(listOf(1, 2, 3, 4), merged.map { it.seq })
    }

    @Test
    fun appendTurnsOnEmptyTakesWholeDelta() {
        val merged = Paging.appendTurns(emptyList(), listOf(TurnDto(seq = 5)))
        assertEquals(listOf(5), merged.map { it.seq })
    }
}
