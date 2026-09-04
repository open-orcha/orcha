package io.openorcha.mobile.ui

/**
 * GitHub hub — the view-owned load/start surface on [OrchaViewModel], Android parity of
 * iOS's `AppModel+GitHubHub.swift`. Reads land in per-surface phase state (the same
 * loading / unavailable / loaded / failed machine the rest of the app uses);
 * `available:false` or a 404 on an older server both resolve to `Unavailable` — never
 * the app-wide error banner. Start rides the shared action-in-flight guard and returns
 * the task so the caller can navigate.
 */

import io.ktor.client.plugins.ClientRequestException
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.updateAndGet
import io.openorcha.mobile.data.GitHubChecksBatchResponse
import io.openorcha.mobile.data.GitHubIssuesResponse
import io.openorcha.mobile.data.GitHubPullRow
import io.openorcha.mobile.data.GitHubPullsResponse
import io.openorcha.mobile.data.githubChecks
import io.openorcha.mobile.data.githubIssueDetail
import io.openorcha.mobile.data.githubIssues
import io.openorcha.mobile.data.githubPullDetail
import io.openorcha.mobile.data.githubPulls
import io.openorcha.mobile.data.startGithubItem
import io.openorcha.mobile.domain.GitHubHubFilter
import io.openorcha.mobile.domain.GitHubHubKind
import io.openorcha.mobile.domain.GitHubHubUx
import io.openorcha.mobile.domain.GitHubIssueDetailPhase
import io.openorcha.mobile.domain.GitHubIssuesPhase
import io.openorcha.mobile.domain.GitHubPullDetailPhase
import io.openorcha.mobile.domain.GitHubPullsFilterState
import io.openorcha.mobile.domain.GitHubPullsPhase
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.domain.PullsInvolvement
import kotlinx.coroutines.launch

/** Owns the GitHub hub's lists, detail screens, and the Start-as-a-task write. */
internal interface GitHubHubActions : OrchaViewModelAccess {

    /** Live AI agents in this container — the Start assignee picker's roster (the hub
     *  assigns work to AI agents, not humans). */
    fun githubAssignableAgents() =
        MobileUx.orderAgents((_uiState.value.snapshot?.agents ?: emptyList()).filter { it.kind == "ai" && it.terminatedAt == null })

    /** The signed-in GitHub login used for the "Mine" filter, or null. */
    fun githubLogin(): String? =
        _uiState.value.snapshot?.agents?.firstOrNull { it.id == _uiState.value.selectedContainer?.humanAgentId }?.githubLogin

    // ---- fetch seam (PR #223 round 3) ----

    /** The hub's raw fetches as overridable members so the delayed-response races are
     *  drivable through the REAL load callbacks in unit tests. Production overrides
     *  nothing — these delegate straight to the api extensions. */
    suspend fun fetchGithubIssues(baseUrl: String, containerId: String): GitHubIssuesResponse =
        api.githubIssues(baseUrl, containerId)

    suspend fun fetchGithubPulls(
        baseUrl: String,
        containerId: String,
        author: String?,
        involvement: String?,
        q: String?,
        page: Int,
    ): GitHubPullsResponse =
        api.githubPulls(baseUrl, containerId, author = author, involvement = involvement, q = q, page = page)

    suspend fun fetchGithubChecks(baseUrl: String, containerId: String, numbers: List<Int>): GitHubChecksBatchResponse =
        api.githubChecks(baseUrl, containerId, numbers)

    fun showGithubHub() {
        _uiState.update { it.copy(route = AppRoute.GitHubHub, error = null) }
        loadGithubIssues()
        loadGithubPulls()
    }

    fun selectGithubHubKind(kind: GitHubHubKind) {
        _uiState.update { it.copy(githubHubKind = kind) }
    }

    fun selectGithubHubFilter(filter: GitHubHubFilter) {
        _uiState.update { it.copy(githubHubFilter = filter) }
    }

    /** A decode of the hub's own `available:false` 200 becomes Unavailable; a transport /
     *  non-2xx / 404 (older server without the surface) becomes Unavailable too — never
     *  Failed, for the degrade-gracefully contract. Genuine transport failures land in Failed. */
    fun loadGithubIssues() {
        val selected = _uiState.value.selectedContainer ?: run {
            _uiState.update { it.copy(githubIssuesPhase = GitHubIssuesPhase.Failed("No workspace is open — close this and try again.")) }
            return
        }
        // PR #223 round 3: capture workspace + a fresh generation; the completion
        // (success or failure) applies only while that generation is still current.
        val gen = _uiState.updateAndGet {
            it.copy(
                githubIssuesPhase = GitHubIssuesPhase.Loading,
                githubIssuesLoadGeneration = it.githubIssuesLoadGeneration + 1,
            )
        }.githubIssuesLoadGeneration
        scope.launch {
            runCatching { fetchGithubIssues(selected.baseUrl, selected.id) }
                .onSuccess { response ->
                    _uiState.update { st ->
                        if (st.githubIssuesLoadGeneration != gen || st.selectedContainer?.id != selected.id) st
                        else st.copy(githubIssuesPhase = GitHubHubUx.phase(response))
                    }
                }
                .onFailure { err ->
                    _uiState.update { st ->
                        if (st.githubIssuesLoadGeneration != gen || st.selectedContainer?.id != selected.id) st
                        else st.copy(githubIssuesPhase = githubIssuesFailure(err))
                    }
                }
        }
    }

    /** Loads page 1 under the current [OrchaUiState.githubPullsFilter] — a fresh filter
     *  (author / involvement / q changing) always replaces the list, never appends. */
    fun loadGithubPulls() {
        val selected = _uiState.value.selectedContainer ?: run {
            _uiState.update { it.copy(githubPullsPhase = GitHubPullsPhase.Failed("No workspace is open — close this and try again.")) }
            return
        }
        val filter = _uiState.value.githubPullsFilter.copy(page = 1)
        // PR #223 round 3: capture workspace + a fresh generation; the completion
        // (success or failure, incl. the checks fill) applies only while that
        // generation is still current — a delayed response from a previous project
        // or an out-of-order same-project reload can never overwrite a newer list.
        val gen = _uiState.updateAndGet {
            it.copy(
                githubPullsPhase = GitHubPullsPhase.Loading,
                githubPullsFilter = filter,
                githubPullsLoadGeneration = it.githubPullsLoadGeneration + 1,
            )
        }.githubPullsLoadGeneration
        scope.launch {
            runCatching {
                fetchGithubPulls(
                    selected.baseUrl, selected.id,
                    author = filter.author.takeIf { it.isNotBlank() },
                    involvement = filter.involvement.wire,
                    q = filter.q.takeIf { it.isNotBlank() },
                    page = 1,
                )
            }
                .onSuccess { response ->
                    var applied = false
                    _uiState.update { st ->
                        if (st.githubPullsLoadGeneration != gen || st.selectedContainer?.id != selected.id) {
                            st
                        } else {
                            applied = true
                            st.copy(githubPullsPhase = GitHubHubUx.phase(response, filter.involvement))
                        }
                    }
                    if (applied) fillGithubChecks(response.pulls, selected.id, gen)
                }
                .onFailure { err ->
                    _uiState.update { st ->
                        if (st.githubPullsLoadGeneration != gen || st.selectedContainer?.id != selected.id) st
                        else st.copy(githubPullsPhase = githubPullsFailure(err))
                    }
                }
        }
    }

    /** Progressive fill of the list's checks chips. The PR list ships `checks: null` on
     *  every row (the server's lazy split — one GitHub call per PR is too slow inline; the
     *  portal fills the same way), so once a page lands, batch its PR numbers through
     *  `…/github/checks` and merge the rollups into the current [GitHubPullsPhase.Loaded].
     *  Fire-and-forget: a failed batch (or an older server's 404) just leaves those chips
     *  hidden, exactly as before this fill existed. */
    fun fillGithubChecks(pulls: List<GitHubPullRow>, requestContainerId: String, generation: Int) {
        val selected = _uiState.value.selectedContainer ?: return
        if (selected.id != requestContainerId) return
        val numbers = pulls.map { it.number }
        if (numbers.isEmpty()) return
        scope.launch {
            GitHubHubUx.checksBatches(numbers).forEach { batch ->
                val response = runCatching { fetchGithubChecks(selected.baseUrl, selected.id, batch) }.getOrNull()
                    ?: return@forEach
                if (!response.available || response.checks.isEmpty()) return@forEach
                _uiState.update { st ->
                    // PR #223 rounds 2+3: a batch merges only while the load that
                    // requested it is still the CURRENT pulls load (generation) of the
                    // still-selected workspace — a delayed batch from a previous project
                    // or an out-of-order reload can never misattribute rollups.
                    if (st.githubPullsLoadGeneration != generation) return@update st
                    st.copy(
                        githubPullsPhase = GitHubHubUx.checksFillResult(
                            st.githubPullsPhase, response.checks, requestContainerId, st.selectedContainer?.id,
                        ),
                    )
                }
            }
        }
    }

    /** "Load more" — fetches the NEXT page and appends it to what's already shown
     *  (de-duplicated at the seam) without disturbing the current filter or scroll
     *  position. A no-op when the current phase isn't a [GitHubPullsPhase.Loaded] with
     *  `hasMore`, or a load is already in flight. */
    fun loadMoreGithubPulls() {
        val selected = _uiState.value.selectedContainer ?: return
        val loaded = _uiState.value.githubPullsPhase as? GitHubPullsPhase.Loaded ?: return
        if (!loaded.hasMore || loaded.loadingMore) return
        val filter = _uiState.value.githubPullsFilter.copy(page = loaded.page + 1)
        // NOT bumped: a load-more belongs to the current primary load's generation, so
        // a NEW primary load (filter change / project switch) invalidates this page.
        val gen = _uiState.value.githubPullsLoadGeneration
        _uiState.update {
            it.copy(githubPullsPhase = loaded.copy(loadingMore = true), githubPullsFilter = filter)
        }
        scope.launch {
            runCatching {
                fetchGithubPulls(
                    selected.baseUrl, selected.id,
                    author = filter.author.takeIf { it.isNotBlank() },
                    involvement = filter.involvement.wire,
                    q = filter.q.takeIf { it.isNotBlank() },
                    page = filter.page,
                )
            }
                .onSuccess { response ->
                    var applied = false
                    _uiState.update { st ->
                        if (st.githubPullsLoadGeneration != gen || st.selectedContainer?.id != selected.id) return@update st
                        val current = st.githubPullsPhase as? GitHubPullsPhase.Loaded ?: return@update st
                        val next = GitHubHubUx.phase(response, filter.involvement) as? GitHubPullsPhase.Loaded ?: return@update st
                        applied = true
                        st.copy(githubPullsPhase = next.copy(pulls = GitHubHubUx.appendPulls(current.pulls, next.pulls), loadingMore = false))
                    }
                    if (applied) fillGithubChecks(response.pulls, selected.id, gen)
                }
                .onFailure {
                    // Load-more failures stay quiet in place (keep the current rows, drop the
                    // spinner) — the user can just tap "load more" again, same as any list.
                    _uiState.update { st ->
                        if (st.githubPullsLoadGeneration != gen || st.selectedContainer?.id != selected.id) return@update st
                        val current = st.githubPullsPhase as? GitHubPullsPhase.Loaded ?: return@update st
                        st.copy(githubPullsPhase = current.copy(loadingMore = false))
                    }
                }
        }
    }

    /** Replaces the PR list's author text and reloads from page 1. */
    fun setGithubPullsAuthor(author: String) {
        _uiState.update { it.copy(githubPullsFilter = it.githubPullsFilter.copy(author = author, page = 1)) }
        loadGithubPulls()
    }

    /** Toggles an involvement filter — selecting the already-active one clears it back
     *  to [PullsInvolvement.None] (the chip behaves as an on/off toggle, not a picker). */
    fun selectGithubPullsInvolvement(involvement: PullsInvolvement) {
        val current = _uiState.value.githubPullsFilter
        val next = if (current.involvement == involvement) PullsInvolvement.None else involvement
        _uiState.update { it.copy(githubPullsFilter = current.copy(involvement = next, page = 1)) }
        loadGithubPulls()
    }

    /** Replaces the PR list's search text and reloads from page 1. */
    fun setGithubPullsQuery(q: String) {
        _uiState.update { it.copy(githubPullsFilter = it.githubPullsFilter.copy(q = q, page = 1)) }
        loadGithubPulls()
    }

    /** Clears every PR-list filter back to defaults and reloads from page 1. */
    fun clearGithubPullsFilters() {
        _uiState.update { it.copy(githubPullsFilter = GitHubPullsFilterState()) }
        loadGithubPulls()
    }

    fun openGithubIssue(number: Int) {
        _uiState.update {
            it.copy(route = AppRoute.GitHubIssueDetail, githubIssueNumber = number, githubIssueDetailPhase = GitHubIssueDetailPhase.Loading)
        }
        loadGithubIssueDetail()
    }

    fun loadGithubIssueDetail() {
        val selected = _uiState.value.selectedContainer ?: return
        val number = _uiState.value.githubIssueNumber ?: return
        scope.launch {
            runCatching { api.githubIssueDetail(selected.baseUrl, selected.id, number) }
                .onSuccess { response -> _uiState.update { it.copy(githubIssueDetailPhase = GitHubHubUx.phase(response)) } }
                .onFailure { err ->
                    val phase = if (statusOfGithubError(err) == 404) {
                        GitHubIssueDetailPhase.Unavailable(reason = "not_found", detail = null)
                    } else {
                        GitHubIssueDetailPhase.Failed(friendlyConnectionError(err))
                    }
                    _uiState.update { it.copy(githubIssueDetailPhase = phase) }
                }
        }
    }

    fun openGithubPull(number: Int) {
        _uiState.update {
            it.copy(route = AppRoute.GitHubPullDetail, githubPullNumber = number, githubPullDetailPhase = GitHubPullDetailPhase.Loading)
        }
        loadGithubPullDetail()
    }

    fun loadGithubPullDetail() {
        val selected = _uiState.value.selectedContainer ?: return
        val number = _uiState.value.githubPullNumber ?: return
        scope.launch {
            runCatching { api.githubPullDetail(selected.baseUrl, selected.id, number) }
                .onSuccess { response -> _uiState.update { it.copy(githubPullDetailPhase = GitHubHubUx.phase(response)) } }
                .onFailure { err ->
                    val phase = if (statusOfGithubError(err) == 404) {
                        GitHubPullDetailPhase.Unavailable(reason = "not_found", detail = null)
                    } else {
                        GitHubPullDetailPhase.Failed(friendlyConnectionError(err))
                    }
                    _uiState.update { it.copy(githubPullDetailPhase = phase) }
                }
        }
    }

    /** `POST …/github/start` — create (or return the already-tracked) task for a GitHub
     *  item. Returns via `githubStarted` in state so the caller can navigate to the task
     *  and distinguish a fresh start from an idempotent `existing:true` re-tap. The acting
     *  human is the task's creator (the grant model mirrors task creation exactly). */
    fun startGithubItem(
        kind: GitHubHubKind,
        number: Int,
        title: String?,
        bodyExcerpt: String?,
        htmlUrl: String?,
        assigneeAgentId: String?,
    ) {
        val selected = _uiState.value.selectedContainer ?: return
        val actor = selected.humanAgentId ?: run {
            _uiState.update { it.copy(error = "Pairing is missing the human identity. Reconnect this Orcha first.") }
            return
        }
        val assigneeName = assigneeAgentId?.let { id -> githubAssignableAgents().firstOrNull { it.id == id }?.alias }
        scope.launch {
            _uiState.update { it.copy(actionInFlight = true, error = null) }
            runCatching {
                api.startGithubItem(
                    selected.baseUrl, selected.id,
                    kind = kind.startKind, number = number,
                    title = title, bodyExcerpt = bodyExcerpt, htmlUrl = htmlUrl,
                    assigneeAgentId = assigneeAgentId, createdByAgentId = actor,
                )
            }.onSuccess { response ->
                val toast = if (response.existing) {
                    "Already tracked — opening the existing task"
                } else {
                    assigneeName?.let { "Started · assigned to $it" } ?: "Started — parked as a task"
                }
                _uiState.update { it.copy(actionInFlight = false, toast = toast, githubStarted = response) }
                refreshSelected()
            }.onFailure { err ->
                _uiState.update { it.copy(actionInFlight = false, error = friendlyConnectionError(err)) }
            }
        }
    }

    /** Consumes the pending start result once the caller has navigated to it. */
    fun clearGithubStarted() {
        _uiState.update { it.copy(githubStarted = null) }
    }

    fun githubIssuesFailure(err: Throwable) =
        if (statusOfGithubError(err) == 404) GitHubIssuesPhase.Unavailable(reason = "repo_not_connected", detail = null)
        else GitHubIssuesPhase.Failed(friendlyConnectionError(err))

    fun githubPullsFailure(err: Throwable) =
        if (statusOfGithubError(err) == 404) GitHubPullsPhase.Unavailable(reason = "repo_not_connected", detail = null)
        else GitHubPullsPhase.Failed(friendlyConnectionError(err))
}

/** The HTTP status of a Ktor client error, or null when [err] isn't one — lets a 404
 *  (older self-host server without the GitHub surface) degrade instead of erroring. */
private fun statusOfGithubError(err: Throwable): Int? = (err as? ClientRequestException)?.response?.status?.value
