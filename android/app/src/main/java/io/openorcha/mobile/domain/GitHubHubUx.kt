package io.openorcha.mobile.domain

/**
 * The GitHub hub's binding-state machine + pure selectors — Android parity of iOS's
 * `GitHubHub.swift` (phase enums) + `GitHubHubUx.swift` (pure selectors). Kept out of
 * Compose so it's unit-testable. A response (or its failure) maps straight to what the
 * list renders: loading → off / list / error.
 */

import io.openorcha.mobile.data.GitHubChecks
import io.openorcha.mobile.data.GitHubCheckRun
import io.openorcha.mobile.data.GitHubIssueDetail
import io.openorcha.mobile.data.GitHubIssueDetailResponse
import io.openorcha.mobile.data.GitHubIssueRow
import io.openorcha.mobile.data.GitHubIssuesResponse
import io.openorcha.mobile.data.GitHubPullDetail
import io.openorcha.mobile.data.GitHubPullDetailResponse
import io.openorcha.mobile.data.GitHubPullRow
import io.openorcha.mobile.data.GitHubPullsResponse

/** Which segment the list is showing. */
enum class GitHubHubKind(val title: String, val startKind: String) {
    Issues("Issues", "issue"),
    Pulls("Pull requests", "pull"),
}

/** Open / Mine filter over a list. "Mine" = assigned to (issues) or review-requested
 *  from (PRs) the signed-in GitHub login; with no known login it falls back to Open. */
enum class GitHubHubFilter(val label: String) {
    Open("Open"),
    Mine("Mine"),
}

/** The PR list's server-resolved involvement filter — mutually exclusive with itself
 *  (picking one clears the other) and orthogonal to [author]/[q] text filters. Maps
 *  onto the frozen contract's `involvement=assigned|review_requested` query param;
 *  [None] omits the param entirely. */
enum class PullsInvolvement(val label: String, val wire: String?) {
    None("All", null),
    Assigned("Assigned to me", "assigned"),
    ReviewRequested("My reviews", "review_requested"),
}

/** Pure filter/pagination state for the PR list (the frozen contract's author /
 *  involvement / q / page params). [page] is the NEXT page to request — starts at 1
 *  and increments on "load more"; any other field changing resets it back to
 *  `copy(page = 1)` so a new filter always restarts from the top. */
data class GitHubPullsFilterState(
    val author: String = "",
    val involvement: PullsInvolvement = PullsInvolvement.None,
    val q: String = "",
    val page: Int = 1,
) {
    /** Whether any filter beyond page 1 is active — used to decide whether "load more"
     *  should append (same filter, later page) or the caller should reset+replace. */
    val isDefault: Boolean get() = author.isBlank() && involvement == PullsInvolvement.None && q.isBlank()
}

/** The list's loading → available:false → loaded machine for issues. */
sealed class GitHubIssuesPhase {
    object Idle : GitHubIssuesPhase()
    object Loading : GitHubIssuesPhase()
    /** `available:false` (unbound / rate-limited / GitHub error) OR the endpoint 404'd
     *  on an older server — the friendly "connect a repo" off state. */
    data class Unavailable(val reason: String?, val detail: String?) : GitHubIssuesPhase()
    data class Loaded(val repo: String?, val issues: List<GitHubIssueRow>) : GitHubIssuesPhase()
    /** The request itself failed (network / auth perimeter / non-2xx outside the
     *  hub's own 200-off contract). */
    data class Failed(val message: String) : GitHubIssuesPhase()
}

/** The PR list's machine (same shape, distinct payload) — extended with the frozen
 *  contract's pagination fields. [Loaded.loadingMore] keeps the current rows on screen
 *  (with a footer spinner) while a "load more" page request is in flight, instead of
 *  bouncing back to the full-screen [Loading] skeleton. */
sealed class GitHubPullsPhase {
    object Idle : GitHubPullsPhase()
    object Loading : GitHubPullsPhase()
    data class Unavailable(val reason: String?, val detail: String?) : GitHubPullsPhase()
    data class Loaded(
        val repo: String?,
        val pulls: List<GitHubPullRow>,
        val source: String? = null,
        val page: Int = 1,
        val perPage: Int = 30,
        val totalCount: Int? = null,
        val hasMore: Boolean = false,
        val loadingMore: Boolean = false,
        /** Set when the server answered `available:true` with an empty list and a
         *  detail string because the caller's identity has no `github_login` on file —
         *  the involvement filter chips ("Assigned to me" / "My reviews") key off this
         *  to show themselves disabled with this message, distinct from a genuine
         *  "nothing assigned to you" empty result (which carries no detail). */
        val identityDetail: String? = null,
    ) : GitHubPullsPhase()
    data class Failed(val message: String) : GitHubPullsPhase()
}

/** Detail machines (PR / issue), same graceful-off contract. */
sealed class GitHubPullDetailPhase {
    object Loading : GitHubPullDetailPhase()
    data class Unavailable(val reason: String?, val detail: String?) : GitHubPullDetailPhase()
    data class Loaded(val repo: String?, val pull: GitHubPullDetail) : GitHubPullDetailPhase()
    data class Failed(val message: String) : GitHubPullDetailPhase()
}

sealed class GitHubIssueDetailPhase {
    object Loading : GitHubIssueDetailPhase()
    data class Unavailable(val reason: String?, val detail: String?) : GitHubIssueDetailPhase()
    data class Loaded(val repo: String?, val issue: GitHubIssueDetail) : GitHubIssueDetailPhase()
    data class Failed(val message: String) : GitHubIssueDetailPhase()
}

/** The compact "n passed / m failing / k pending" summary a checks chip shows, plus the
 *  one-glance verdict color the chip tints itself with. */
data class ChecksSummary(
    /** A short chip label, e.g. "3✓ 2✗ 2•" or "no checks". */
    val label: String,
    /** The dominant state: failing beats pending beats passed beats none. */
    val verdict: Verdict,
    /** Whether any checks exist at all (total > 0). */
    val hasChecks: Boolean,
) {
    enum class Verdict { Failing, Pending, Passing, None }
}

/** Pure selectors for the GitHub hub — response→phase mapping, Open/Mine filtering, and
 *  the checks-chip summary. No Compose here so it's all unit-testable. */
object GitHubHubUx {

    // ---------- response → phase ----------

    fun phase(response: GitHubIssuesResponse): GitHubIssuesPhase =
        if (response.available) {
            GitHubIssuesPhase.Loaded(response.repo, response.issues)
        } else {
            GitHubIssuesPhase.Unavailable(response.reason, response.detail)
        }

    /** [filter] is the request's own involvement filter — the identity-missing detail
     *  only applies when an involvement filter was actually requested (an empty result
     *  under [PullsInvolvement.None] is just "no open PRs", never an identity gap). */
    fun phase(response: GitHubPullsResponse, filter: PullsInvolvement = PullsInvolvement.None): GitHubPullsPhase =
        if (response.available) {
            val identityDetail = if (filter != PullsInvolvement.None && response.pulls.isEmpty()) response.detail else null
            GitHubPullsPhase.Loaded(
                repo = response.repo,
                pulls = response.pulls,
                source = response.source,
                page = response.page,
                perPage = response.perPage,
                totalCount = response.totalCount,
                hasMore = response.hasMore,
                identityDetail = identityDetail,
            )
        } else {
            GitHubPullsPhase.Unavailable(response.reason, response.detail)
        }

    // ---------- PR list filter/pagination (frozen contract: author, involvement, q, page) ----------

    /** True when [login] is blank/null — the involvement chips ("Assigned to me" /
     *  "My reviews") disable themselves client-side on this alone, without waiting on
     *  a round trip, since the server can only resolve "me" from a known GitHub login. */
    fun involvementDisabled(login: String?): Boolean = normalizedLogin(login) == null

    /** Appends a freshly-fetched page onto what's already shown, de-duplicating by PR
     *  number at the seam (a page re-fetched after a filter no-op, or an overlapping
     *  concurrent load, must never double a row). Used for "load more"; a fresh
     *  filter/search instead replaces the list outright (page 1 that isn't appended). */
    fun appendPulls(existing: List<GitHubPullRow>, next: List<GitHubPullRow>): List<GitHubPullRow> {
        val seen = existing.mapTo(HashSet()) { it.number }
        return existing + next.filter { it.number !in seen }
    }

    /** The server caps one `…/github/checks` call at this many PR numbers
     *  (`github_hub_routes.CHECKS_BATCH_MAX_NUMBERS`); a longer request is a 400. */
    const val CHECKS_BATCH_MAX = 30

    /** Split a page's PR numbers into server-sized batches, order preserved. */
    fun checksBatches(numbers: List<Int>, max: Int = CHECKS_BATCH_MAX): List<List<Int>> =
        if (max <= 0 || numbers.isEmpty()) emptyList() else numbers.chunked(max)

    /** Fill list rows' checks from one batch response. Rows are matched by PR number
     *  (the batch is keyed by the number as a string); a row the batch didn't answer for
     *  keeps what it had, so a filter change mid-flight can't misattribute a rollup. */
    fun mergeChecks(pulls: List<GitHubPullRow>, checks: Map<String, GitHubChecks>): List<GitHubPullRow> {
        if (checks.isEmpty()) return pulls
        return pulls.map { row -> checks[row.number.toString()]?.let { row.copy(checks = it) } ?: row }
    }

    /** PR #223 review: the checks fill's merge decision as a pure step — a batch
     *  response merges ONLY when the workspace it was requested for is still the
     *  selected one (rows are matched by PR number alone, so a delayed response from
     *  project A must never land on project B's same-numbered PRs after a switch).
     *  Any non-Loaded phase (the list was reloaded / errored meanwhile) stays put. */
    fun checksFillResult(
        phase: GitHubPullsPhase,
        checks: Map<String, GitHubChecks>,
        requestContainerId: String,
        currentContainerId: String?,
    ): GitHubPullsPhase {
        if (requestContainerId != currentContainerId) return phase
        val loaded = phase as? GitHubPullsPhase.Loaded ?: return phase
        return loaded.copy(pulls = mergeChecks(loaded.pulls, checks))
    }

    fun phase(response: GitHubPullDetailResponse): GitHubPullDetailPhase {
        val pull = response.pull
        return if (response.available && pull != null) {
            GitHubPullDetailPhase.Loaded(response.repo, pull)
        } else {
            GitHubPullDetailPhase.Unavailable(response.reason, response.detail)
        }
    }

    fun phase(response: GitHubIssueDetailResponse): GitHubIssueDetailPhase {
        val issue = response.issue
        return if (response.available && issue != null) {
            GitHubIssueDetailPhase.Loaded(response.repo, issue)
        } else {
            GitHubIssueDetailPhase.Unavailable(response.reason, response.detail)
        }
    }

    // ---------- Open / Mine filtering ----------

    /** Issues assigned to [login] (matched against the primary assignee). A blank login
     *  yields the full list — "Mine" can't be answered, so it shows everything. */
    fun filterIssues(issues: List<GitHubIssueRow>, filter: GitHubHubFilter, login: String?): List<GitHubIssueRow> {
        val normalized = normalizedLogin(login) ?: return issues
        if (filter != GitHubHubFilter.Mine) return issues
        return issues.filter { normalizedLogin(it.assignee) == normalized }
    }

    /** PRs whose review is requested from [login]. Same blank-login fallback. A
     *  search-sourced row with no `requested_reviewers` (the field is absent, not just
     *  empty) never matches "Mine" — it's simply excluded, not an error. */
    fun filterPulls(pulls: List<GitHubPullRow>, filter: GitHubHubFilter, login: String?): List<GitHubPullRow> {
        val normalized = normalizedLogin(login) ?: return pulls
        if (filter != GitHubHubFilter.Mine) return pulls
        return pulls.filter { pull -> pull.requestedReviewers.orEmpty().any { normalizedLogin(it) == normalized } }
    }

    private fun normalizedLogin(login: String?): String? {
        val value = login?.trim()?.lowercase()
        return if (value.isNullOrEmpty()) null else value
    }

    // ---------- checks chip summary ----------

    /** Roll the four counts up into a chip summary. The dominant verdict follows the
     *  portal: any failing → failing; else any pending → pending; else any passed →
     *  passing; else none. `total == 0` (older server or no CI) → the "no checks" pill. */
    fun checksSummary(checks: GitHubChecks): ChecksSummary {
        if (checks.total <= 0) {
            return ChecksSummary(label = "no checks", verdict = ChecksSummary.Verdict.None, hasChecks = false)
        }
        val parts = buildList {
            if (checks.passed > 0) add("${checks.passed}✓")
            if (checks.failing > 0) add("${checks.failing}✗")
            if (checks.pending > 0) add("${checks.pending}•")
        }
        val label = if (parts.isEmpty()) "${checks.total} checks" else parts.joinToString(" ")
        val verdict = when {
            checks.failing > 0 -> ChecksSummary.Verdict.Failing
            checks.pending > 0 -> ChecksSummary.Verdict.Pending
            checks.passed > 0 -> ChecksSummary.Verdict.Passing
            else -> ChecksSummary.Verdict.None
        }
        return ChecksSummary(label = label, verdict = verdict, hasChecks = true)
    }

    /** Per-run status glyph for the detail checks list. Maps GitHub's status + conclusion
     *  onto one of the four verdict families. */
    fun runVerdict(run: GitHubCheckRun): ChecksSummary.Verdict {
        if (run.status != "completed") return ChecksSummary.Verdict.Pending
        return when (run.conclusion) {
            "success", "neutral", "skipped" -> ChecksSummary.Verdict.Passing
            "failure", "timed_out", "action_required", "cancelled", "stale", "startup_failure" -> ChecksSummary.Verdict.Failing
            else -> ChecksSummary.Verdict.Pending
        }
    }

    // ---------- mergeable-state chip copy ----------

    /** Human copy for GitHub's raw `mergeable_state`. null / unknown → no chip. */
    fun mergeStateLabel(state: String?): String? = when (state) {
        "clean" -> "ready to merge"
        "dirty" -> "conflicts"
        "blocked" -> "blocked"
        "behind" -> "behind base"
        "unstable" -> "unstable"
        "has_hooks" -> "checks running"
        "draft" -> "draft"
        "unknown", "", null -> null
        else -> state.replace("_", " ")
    }

    /** A short human line for an `available:false` reason — the empty-state copy. */
    fun unavailableCopy(reason: String?, detail: String?): String = when (reason) {
        "repo_not_connected" ->
            "No GitHub repository is connected to this Orcha yet. Connect one from the Home tab to see its issues and pull requests here."
        "rate_limited" ->
            "GitHub is rate-limiting requests right now. This will clear on its own — try again in a few minutes."
        "not_found" ->
            "That item no longer exists on GitHub, or the repository binding changed."
        "unreachable" ->
            "Couldn't reach GitHub from this Orcha. Check the server's connection and try again."
        "github_error" -> detail ?: "GitHub returned an error. Try again shortly."
        else -> detail ?: "The GitHub surface isn't available for this Orcha right now."
    }
}
