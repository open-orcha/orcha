package io.openorcha.mobile.domain

import io.openorcha.mobile.data.GitHubChecks
import io.openorcha.mobile.data.GitHubChecksBatchResponse
import io.openorcha.mobile.data.GitHubPullRow
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * PR #223 audit: the PR list route ships `checks: null` on every row and the batch
 * `…/github/checks?numbers=` call fills them in — without this fill the phone never
 * showed a CI chip on any PR row (the portal did).
 */
class GitHubChecksFillTest {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    @Test
    fun batchResponseDecodesNumberKeyedRollups() {
        val resp = json.decodeFromString<GitHubChecksBatchResponse>(
            """{"available":true,"checks":{"12":{"passed":3,"failing":1,"pending":0,"total":4},
                "15":{"passed":0,"failing":0,"pending":2,"total":2}}}""",
        )
        assertTrue(resp.available)
        assertEquals(1, resp.checks["12"]?.failing)
        assertEquals(2, resp.checks["15"]?.pending)
        assertNull(resp.checks["99"])
        val off = json.decodeFromString<GitHubChecksBatchResponse>("""{"available":false,"reason":"rate_limited"}""")
        assertFalse(off.available)
        assertTrue(off.checks.isEmpty())
    }

    @Test
    fun mergeFillsOnlyTheRowsTheBatchAnswered() {
        val rows = listOf(
            GitHubPullRow(number = 12, title = "a"),
            GitHubPullRow(number = 15, title = "b", checks = GitHubChecks(passed = 1, total = 1)),
            GitHubPullRow(number = 20, title = "c"),
        )
        val merged = GitHubHubUx.mergeChecks(
            rows,
            mapOf(
                "12" to GitHubChecks(passed = 3, failing = 1, total = 4),
                "77" to GitHubChecks(passed = 9, total = 9), // not on screen — ignored
            ),
        )
        assertEquals(listOf(12, 15, 20), merged.map { it.number })
        assertEquals(GitHubChecks(passed = 3, failing = 1, total = 4), merged[0].checks)
        assertEquals(GitHubChecks(passed = 1, total = 1), merged[1].checks) // kept what it had
        assertNull(merged[2].checks) // still "not loaded"
        assertEquals(rows, GitHubHubUx.mergeChecks(rows, emptyMap()))
    }

    @Test
    fun batchesSplitAtTheServerCapInOrder() {
        val numbers = (1..65).toList()
        val batches = GitHubHubUx.checksBatches(numbers)
        assertEquals(listOf(30, 30, 5), batches.map { it.size })
        assertEquals(numbers, batches.flatten())
        assertTrue(GitHubHubUx.checksBatches(emptyList()).isEmpty())
        assertEquals(listOf(listOf(1, 2), listOf(3)), GitHubHubUx.checksBatches(listOf(1, 2, 3), max = 2))
    }

    // ---------- delayed cross-project response guard (PR #223 review) ----------
    // A delayed checks batch from project A must never merge into project B's list
    // after a workspace switch — rows are matched by PR number alone, so two repos
    // both having a PR #12 would show A's CI rollup on B's row. `checksFillResult`
    // is the fill's whole merge decision (GitHubHubActions delegates to it).

    private val bLoaded = GitHubPullsPhase.Loaded(
        repo = "b/repo",
        pulls = listOf(GitHubPullRow(number = 12, title = "B's PR 12")),
    )
    private val aChecks = mapOf("12" to GitHubChecks(passed = 3, failing = 1, total = 4))

    @Test
    fun delayedBatchFromAnotherProjectIsDiscarded() {
        // Project A's checks call resolves AFTER the switch to B — same PR number.
        val result = GitHubHubUx.checksFillResult(
            phase = bLoaded,
            checks = aChecks,
            requestContainerId = "project-a",
            currentContainerId = "project-b",
        )
        assertEquals(bLoaded, result)
        assertNull((result as GitHubPullsPhase.Loaded).pulls[0].checks)
    }

    @Test
    fun batchForTheStillSelectedProjectMerges() {
        val result = GitHubHubUx.checksFillResult(
            phase = bLoaded,
            checks = aChecks,
            requestContainerId = "project-b",
            currentContainerId = "project-b",
        )
        val merged = (result as GitHubPullsPhase.Loaded).pulls[0].checks
        assertEquals(GitHubChecks(passed = 3, failing = 1, total = 4), merged)
    }

    @Test
    fun nonLoadedPhaseStaysUntouchedEvenWhenCurrent() {
        // The list was reloaded (or errored) while the batch was in flight — nothing
        // to merge into; the phase passes through untouched, no cast crash.
        val loading: GitHubPullsPhase = GitHubPullsPhase.Loading
        val result = GitHubHubUx.checksFillResult(
            phase = loading,
            checks = aChecks,
            requestContainerId = "project-b",
            currentContainerId = "project-b",
        )
        assertEquals(loading, result)
    }

    @Test
    fun noSelectedWorkspaceDiscardsTheBatch() {
        val result = GitHubHubUx.checksFillResult(
            phase = bLoaded,
            checks = aChecks,
            requestContainerId = "project-b",
            currentContainerId = null,
        )
        assertEquals(bLoaded, result)
    }
}
