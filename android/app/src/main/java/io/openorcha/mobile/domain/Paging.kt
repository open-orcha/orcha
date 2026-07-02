package io.openorcha.mobile.domain

import io.openorcha.mobile.data.TurnDto

/**
 * Pure merge helpers for the paged lists (issue 4). Keyset thread pages come oldest→newest
 * within a page; conversation deltas arrive seq-ascending after `after_seq`.
 */
object Paging {

    /** Prepend an older keyset page ("Load earlier"); drop any row already present (no dup at the seam). */
    fun <T> prependOlder(existing: List<T>, older: List<T>, key: (T) -> Any?): List<T> {
        val seen = existing.mapTo(HashSet(), key)
        return older.filter { key(it) !in seen } + existing
    }

    /**
     * Merge a re-fetched NEWEST page into what's shown (post-send refresh): rows already
     * covered by the fresh page are replaced by it; earlier-loaded pages stay in front.
     */
    fun <T> mergeNewest(existing: List<T>, newest: List<T>, key: (T) -> Any?): List<T> {
        val fresh = newest.mapTo(HashSet(), key)
        return existing.filter { key(it) !in fresh } + newest
    }

    /** Append an `after_seq` conversation delta, dropping any replayed seqs (web parity). */
    fun appendTurns(existing: List<TurnDto>, delta: List<TurnDto>): List<TurnDto> {
        val lastSeq = existing.lastOrNull()?.seq ?: 0
        return existing + delta.filter { it.seq > lastSeq }
    }
}
