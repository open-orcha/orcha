package io.openorcha.mobile.domain

import io.openorcha.mobile.data.GitHubCheckRun
import io.openorcha.mobile.data.GitHubChecks
import io.openorcha.mobile.data.GitHubIssueRow
import io.openorcha.mobile.data.GitHubIssueDetailResponse
import io.openorcha.mobile.data.GitHubIssuesResponse
import io.openorcha.mobile.data.GitHubPullRow
import io.openorcha.mobile.data.GitHubPullDetail
import io.openorcha.mobile.data.GitHubPullDetailResponse
import io.openorcha.mobile.data.GitHubPullsResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** GitHub hub parity port — pure selectors must match iOS's GitHubHubUx exactly
 *  (response→phase mapping, Open/Mine filtering, checks summary, merge-state copy). */
class GitHubHubUxTest {

    // ---------- response → phase ----------

    @Test
    fun availableIssuesResponseMapsToLoaded() {
        val response = GitHubIssuesResponse(available = true, repo = "acme/widgets", issues = listOf(GitHubIssueRow(number = 1)))
        val phase = assertIs<GitHubIssuesPhase.Loaded>(GitHubHubUx.phase(response))
        assertEquals("acme/widgets", phase.repo)
        assertEquals(1, phase.issues.size)
    }

    @Test
    fun unavailableIssuesResponseMapsToUnavailableWithReason() {
        val response = GitHubIssuesResponse(available = false, reason = "repo_not_connected")
        val phase = assertIs<GitHubIssuesPhase.Unavailable>(GitHubHubUx.phase(response))
        assertEquals("repo_not_connected", phase.reason)
    }

    @Test
    fun availablePullDetailWithNullPullStillMapsToUnavailable() {
        // available:true but pull missing is malformed — treat as unavailable, never crash.
        val response = GitHubPullDetailResponse(available = true, pull = null, reason = null)
        assertIs<GitHubPullDetailPhase.Unavailable>(GitHubHubUx.phase(response))
    }

    @Test
    fun loadedPullDetailCarriesThePull() {
        val pull = GitHubPullDetail(number = 42, title = "Fix the thing")
        val response = GitHubPullDetailResponse(available = true, repo = "acme/widgets", pull = pull)
        val phase = assertIs<GitHubPullDetailPhase.Loaded>(GitHubHubUx.phase(response))
        assertEquals(42, phase.pull.number)
    }

    @Test
    fun issueDetailNotFoundMapsToUnavailable() {
        val response = GitHubIssueDetailResponse(available = false, reason = "not_found")
        val phase = assertIs<GitHubIssueDetailPhase.Unavailable>(GitHubHubUx.phase(response))
        assertEquals("not_found", phase.reason)
    }

    // ---------- Open / Mine filtering ----------

    @Test
    fun filterIssuesMineMatchesAssigneeCaseInsensitively() {
        val issues = listOf(
            GitHubIssueRow(number = 1, assignee = "Octocat"),
            GitHubIssueRow(number = 2, assignee = "other"),
            GitHubIssueRow(number = 3, assignee = null),
        )
        val mine = GitHubHubUx.filterIssues(issues, GitHubHubFilter.Mine, "octocat")
        assertEquals(listOf(1), mine.map { it.number })
    }

    @Test
    fun filterIssuesOpenReturnsEverythingRegardlessOfLogin() {
        val issues = listOf(GitHubIssueRow(number = 1, assignee = "a"), GitHubIssueRow(number = 2, assignee = "b"))
        assertEquals(issues, GitHubHubUx.filterIssues(issues, GitHubHubFilter.Open, "a"))
    }

    @Test
    fun filterIssuesMineWithBlankLoginFallsBackToFullList() {
        val issues = listOf(GitHubIssueRow(number = 1, assignee = "a"))
        assertEquals(issues, GitHubHubUx.filterIssues(issues, GitHubHubFilter.Mine, null))
        assertEquals(issues, GitHubHubUx.filterIssues(issues, GitHubHubFilter.Mine, "   "))
    }

    @Test
    fun filterPullsMineMatchesRequestedReviewers() {
        val pulls = listOf(
            GitHubPullRow(number = 1, requestedReviewers = listOf("Octocat", "other")),
            GitHubPullRow(number = 2, requestedReviewers = listOf("someone-else")),
        )
        val mine = GitHubHubUx.filterPulls(pulls, GitHubHubFilter.Mine, "octocat")
        assertEquals(listOf(1), mine.map { it.number })
    }

    // ---------- checks chip summary ----------

    @Test
    fun checksSummaryWithNoChecksIsNeutral() {
        val summary = GitHubHubUx.checksSummary(GitHubChecks())
        assertEquals("no checks", summary.label)
        assertEquals(ChecksSummary.Verdict.None, summary.verdict)
        assertFalse(summary.hasChecks)
    }

    @Test
    fun checksSummaryFailingBeatsPendingBeatsPassing() {
        val allThree = GitHubHubUx.checksSummary(GitHubChecks(passed = 3, failing = 2, pending = 1, total = 6))
        assertEquals(ChecksSummary.Verdict.Failing, allThree.verdict)
        assertEquals("3✓ 2✗ 1•", allThree.label)

        val pendingOnly = GitHubHubUx.checksSummary(GitHubChecks(passed = 1, pending = 2, total = 3))
        assertEquals(ChecksSummary.Verdict.Pending, pendingOnly.verdict)

        val passingOnly = GitHubHubUx.checksSummary(GitHubChecks(passed = 4, total = 4))
        assertEquals(ChecksSummary.Verdict.Passing, passingOnly.verdict)
    }

    @Test
    fun runVerdictMapsGithubStatusAndConclusion() {
        assertEquals(ChecksSummary.Verdict.Pending, GitHubHubUx.runVerdict(GitHubCheckRun(status = "in_progress")))
        assertEquals(ChecksSummary.Verdict.Passing, GitHubHubUx.runVerdict(GitHubCheckRun(status = "completed", conclusion = "success")))
        assertEquals(ChecksSummary.Verdict.Failing, GitHubHubUx.runVerdict(GitHubCheckRun(status = "completed", conclusion = "failure")))
        assertEquals(ChecksSummary.Verdict.Pending, GitHubHubUx.runVerdict(GitHubCheckRun(status = "completed", conclusion = null)))
    }

    // ---------- mergeable-state chip copy ----------

    @Test
    fun mergeStateLabelKnownValues() {
        assertEquals("ready to merge", GitHubHubUx.mergeStateLabel("clean"))
        assertEquals("conflicts", GitHubHubUx.mergeStateLabel("dirty"))
        assertNull(GitHubHubUx.mergeStateLabel("unknown"))
        assertNull(GitHubHubUx.mergeStateLabel(null))
    }

    @Test
    fun mergeStateLabelFallsBackToUnderscoreReplacement() {
        assertEquals("some new state", GitHubHubUx.mergeStateLabel("some_new_state"))
    }

    // ---------- unavailable copy ----------

    @Test
    fun unavailableCopyHasFriendlyTextPerReason() {
        assertTrue(GitHubHubUx.unavailableCopy("repo_not_connected", null).contains("Connect one"))
        assertTrue(GitHubHubUx.unavailableCopy("rate_limited", null).contains("rate-limiting"))
        assertTrue(GitHubHubUx.unavailableCopy("not_found", null).contains("no longer exists"))
        assertEquals("custom detail", GitHubHubUx.unavailableCopy("github_error", "custom detail"))
        assertEquals("custom detail", GitHubHubUx.unavailableCopy(null, "custom detail"))
    }

    // ---------- PR list filter/pagination (frozen contract) ----------

    @Test
    fun pullsResponseMapsPaginationFieldsIntoLoaded() {
        val response = GitHubPullsResponse(
            available = true, repo = "acme/widgets", source = "search",
            items = listOf(GitHubPullRow(number = 7)),
            page = 2, perPage = 20, totalCount = 45, hasMore = true,
        )
        val phase = assertIs<GitHubPullsPhase.Loaded>(GitHubHubUx.phase(response))
        assertEquals("search", phase.source)
        assertEquals(2, phase.page)
        assertEquals(20, phase.perPage)
        assertEquals(45, phase.totalCount)
        assertTrue(phase.hasMore)
        assertNull(phase.identityDetail)
    }

    @Test
    fun pullsResponseToleratesLegacyPullsKeyWhenItemsAbsent() {
        // Constructed via the public `items` field only — the legacy `pulls` wire key
        // is exercised by GitHubHubApiTest's JSON decode, not constructible here since
        // it's a private backing field. `items` non-empty always wins.
        val response = GitHubPullsResponse(available = true, items = listOf(GitHubPullRow(number = 3)))
        assertEquals(listOf(3), response.pulls.map { it.number })
    }

    @Test
    fun involvementFilterEmptyResultSurfacesIdentityDetailAsIdentityDetail() {
        val response = GitHubPullsResponse(available = true, items = emptyList(), detail = "no github_login on file")
        val phase = assertIs<GitHubPullsPhase.Loaded>(GitHubHubUx.phase(response, PullsInvolvement.Assigned))
        assertEquals("no github_login on file", phase.identityDetail)
    }

    @Test
    fun noInvolvementFilterEmptyResultNeverSurfacesIdentityDetail() {
        // Same shape (available, empty, a detail string) but no involvement filter was
        // requested — an ordinary "no open PRs", never treated as an identity gap.
        val response = GitHubPullsResponse(available = true, items = emptyList(), detail = "some unrelated detail")
        val phase = assertIs<GitHubPullsPhase.Loaded>(GitHubHubUx.phase(response, PullsInvolvement.None))
        assertNull(phase.identityDetail)
    }

    @Test
    fun involvementFilterNonEmptyResultNeverSurfacesIdentityDetail() {
        val response = GitHubPullsResponse(available = true, items = listOf(GitHubPullRow(number = 1)), detail = "should be ignored")
        val phase = assertIs<GitHubPullsPhase.Loaded>(GitHubHubUx.phase(response, PullsInvolvement.ReviewRequested))
        assertNull(phase.identityDetail)
    }

    @Test
    fun involvementDisabledTracksBlankOrNullLogin() {
        assertTrue(GitHubHubUx.involvementDisabled(null))
        assertTrue(GitHubHubUx.involvementDisabled("   "))
        assertFalse(GitHubHubUx.involvementDisabled("octocat"))
    }

    @Test
    fun appendPullsDedupesByNumberAtTheSeam() {
        val existing = listOf(GitHubPullRow(number = 1), GitHubPullRow(number = 2))
        val next = listOf(GitHubPullRow(number = 2, title = "stale duplicate"), GitHubPullRow(number = 3))
        val merged = GitHubHubUx.appendPulls(existing, next)
        assertEquals(listOf(1, 2, 3), merged.map { it.number })
        // The original row #2 wins at the seam — the appended duplicate is dropped, not merged over it.
        assertEquals("", merged.first { it.number == 2 }.title)
    }

    @Test
    fun appendPullsOnEmptyExistingIsJustNext() {
        val next = listOf(GitHubPullRow(number = 5))
        assertEquals(next, GitHubHubUx.appendPulls(emptyList(), next))
    }

    @Test
    fun pullsInvolvementWireValuesMatchTheFrozenContract() {
        assertNull(PullsInvolvement.None.wire)
        assertEquals("assigned", PullsInvolvement.Assigned.wire)
        assertEquals("review_requested", PullsInvolvement.ReviewRequested.wire)
    }

    @Test
    fun filterStateIsDefaultOnlyWithNoFiltersActive() {
        assertTrue(GitHubPullsFilterState().isDefault)
        assertFalse(GitHubPullsFilterState(author = "octocat").isDefault)
        assertFalse(GitHubPullsFilterState(involvement = PullsInvolvement.Assigned).isDefault)
        assertFalse(GitHubPullsFilterState(q = "fix").isDefault)
        // page alone (paginating the default filter) still counts as default.
        assertTrue(GitHubPullsFilterState(page = 3).isDefault)
    }

    // ---------- PR row nullable-tolerant fields (search-sourced rows) ----------

    @Test
    fun filterPullsMineExcludesRowsMissingRequestedReviewersEntirely() {
        val pulls = listOf(
            GitHubPullRow(number = 1, requestedReviewers = null), // search-sourced: field absent
            GitHubPullRow(number = 2, requestedReviewers = listOf("octocat")),
        )
        val mine = GitHubHubUx.filterPulls(pulls, GitHubHubFilter.Mine, "octocat")
        assertEquals(listOf(2), mine.map { it.number })
    }
}
