package io.openorcha.mobile.ui

import io.openorcha.mobile.data.ContainerStore
import io.openorcha.mobile.data.GitHubChecks
import io.openorcha.mobile.data.GitHubChecksBatchResponse
import io.openorcha.mobile.data.GitHubIssuesResponse
import io.openorcha.mobile.data.GitHubPullRow
import io.openorcha.mobile.data.GitHubPullsResponse
import io.openorcha.mobile.data.OrchaApiClient
import io.openorcha.mobile.data.StoredContainer
import io.openorcha.mobile.data.TaskMessageDto
import io.openorcha.mobile.domain.GitHubIssuesPhase
import io.openorcha.mobile.domain.GitHubPullsPhase
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * PR #223 round 3: the delayed-response races driven through the REAL
 * [GitHubHubActions] load callbacks (not the pure helpers) — a fake access
 * implementation gates the fetch seam so each response's arrival order is
 * controlled exactly. Removing a generation/container guard from any shipping
 * callback fails these.
 */
private class RaceHub(
    override val scope: CoroutineScope,
    initial: OrchaUiState,
) : GitHubHubActions {
    override val _uiState = MutableStateFlow(initial)

    val pullsGates = mutableListOf<Pair<String, CompletableDeferred<GitHubPullsResponse>>>()
    val issuesGates = mutableListOf<Pair<String, CompletableDeferred<GitHubIssuesResponse>>>()
    val checksGates = mutableListOf<Pair<String, CompletableDeferred<GitHubChecksBatchResponse>>>()
    var gateChecks = false

    override suspend fun fetchGithubPulls(
        baseUrl: String,
        containerId: String,
        author: String?,
        involvement: String?,
        q: String?,
        page: Int,
    ): GitHubPullsResponse {
        val gate = CompletableDeferred<GitHubPullsResponse>()
        pullsGates += containerId to gate
        return gate.await()
    }

    override suspend fun fetchGithubIssues(baseUrl: String, containerId: String): GitHubIssuesResponse {
        val gate = CompletableDeferred<GitHubIssuesResponse>()
        issuesGates += containerId to gate
        return gate.await()
    }

    override suspend fun fetchGithubChecks(
        baseUrl: String,
        containerId: String,
        numbers: List<Int>,
    ): GitHubChecksBatchResponse {
        if (!gateChecks) return GitHubChecksBatchResponse(available = false)
        val gate = CompletableDeferred<GitHubChecksBatchResponse>()
        checksGates += containerId to gate
        return gate.await()
    }

    // ---- unused OrchaViewModelAccess surface ----
    override val store: ContainerStore get() = error("unused")
    override val api: OrchaApiClient get() = error("unused")
    override val json: Json get() = error("unused")
    override var pollingJob: Job? = null
    override var runStreamJob: Job? = null
    override var replyWatchJob: Job? = null
    override val deviceAuthSession: DeviceAuthSession get() = error("unused")
    override fun showWorkspace() = error("unused")
    override fun refreshSelected() {} // startGithubItem's happy path calls this; inert here
    override fun refreshSelectedTask() = error("unused")
    override fun refreshAgentDetail() = error("unused")
    override fun refreshConversation() = error("unused")
    override suspend fun refreshConversationQuiet(agentId: String) = error("unused")
    override fun cancelReplyWatch() = error("unused")
    override fun refreshRunLog() = error("unused")
    override fun openTask(taskId: String) = error("unused")
    override fun cancelRunStream() = error("unused")
    override fun startPolling() = error("unused")
    override fun pairingBaseUrl(raw: String): String = error("unused")
    override fun pairingRemoteUrl(raw: String): String? = error("unused")
    override fun pairingContainerId(raw: String): String? = error("unused")
    override fun pairingHumanAgentId(raw: String): String? = error("unused")
    override fun friendlyConnectionError(err: Throwable?): String = "err"
    override fun messageKey(message: TaskMessageDto): Any = error("unused")
    override fun runHumanAction(success: String, block: suspend (StoredContainer, String) -> Unit) = error("unused")
    override suspend fun connectWithToken(rawBaseUrl: String, accessToken: String?): Boolean = error("unused")
}

class GitHubHubRaceTest {

    private fun container(id: String) = StoredContainer(id = id, displayName = id, baseUrl = "http://$id.local")

    private fun pullsResponse(repo: String, title: String, number: Int = 12) = GitHubPullsResponse(
        available = true,
        repo = repo,
        items = listOf(GitHubPullRow(number = number, title = title)),
    )

    private fun loaded(hub: RaceHub) = hub._uiState.value.githubPullsPhase as GitHubPullsPhase.Loaded

    @Test
    fun delayedListFromAnotherProjectIsDiscarded() = runTest {
        val hub = RaceHub(this, OrchaUiState(selectedContainer = container("project-a")))

        hub.loadGithubPulls() // A's request goes out…
        runCurrent()
        hub._uiState.update { it.copy(selectedContainer = container("project-b")) }
        hub.loadGithubPulls() // …the user switches to B and reloads…
        runCurrent()
        assertEquals(listOf("project-a", "project-b"), hub.pullsGates.map { it.first })

        hub.pullsGates[1].second.complete(pullsResponse("b/repo", "B PR")) // B lands first
        runCurrent()
        hub.pullsGates[0].second.complete(pullsResponse("a/repo", "A PR")) // …then stale A
        advanceUntilIdle()

        assertEquals("b/repo", loaded(hub).repo)
        assertEquals(listOf("B PR"), loaded(hub).pulls.map { it.title })
    }

    @Test
    fun outOfOrderSameProjectLoadsKeepTheNewest() = runTest {
        // Two rapid loads within ONE project (a filter change): the second request
        // resolves first; the first (stale) resolves after and must be discarded.
        val hub = RaceHub(this, OrchaUiState(selectedContainer = container("project-a")))

        hub.loadGithubPulls()
        runCurrent()
        hub.loadGithubPulls()
        runCurrent()

        hub.pullsGates[1].second.complete(pullsResponse("a/repo", "newest"))
        runCurrent()
        hub.pullsGates[0].second.complete(pullsResponse("a/repo", "stale"))
        advanceUntilIdle()

        assertEquals(listOf("newest"), loaded(hub).pulls.map { it.title })
    }

    @Test
    fun delayedIssuesListFromAnotherProjectIsDiscarded() = runTest {
        val hub = RaceHub(this, OrchaUiState(selectedContainer = container("project-a")))

        hub.loadGithubIssues()
        runCurrent()
        hub._uiState.update { it.copy(selectedContainer = container("project-b")) }
        hub.loadGithubIssues()
        runCurrent()

        hub.issuesGates[1].second.complete(GitHubIssuesResponse(available = true, repo = "b/repo"))
        runCurrent()
        hub.issuesGates[0].second.complete(GitHubIssuesResponse(available = true, repo = "a/repo"))
        advanceUntilIdle()

        assertEquals("b/repo", (hub._uiState.value.githubIssuesPhase as GitHubIssuesPhase.Loaded).repo)
    }

    @Test
    fun staleChecksBatchAfterReloadIsDiscardedAndCurrentOneMerges() = runTest {
        // The checks fill rides its load's generation: a batch requested by a
        // superseded load must not merge; the current load's batch must — this also
        // proves the fill routes through the REAL callback (a no-op fill fails it).
        val hub = RaceHub(this, OrchaUiState(selectedContainer = container("project-a")))
        hub.gateChecks = true

        hub.loadGithubPulls()
        runCurrent()
        hub.pullsGates[0].second.complete(pullsResponse("a/repo", "first"))
        runCurrent() // first load applied; its checks fill is now gated in flight
        assertEquals(1, hub.checksGates.size)

        hub.loadGithubPulls() // same-project reload supersedes the first load
        runCurrent()
        hub.pullsGates[1].second.complete(pullsResponse("a/repo", "second"))
        runCurrent()
        assertEquals(2, hub.checksGates.size)

        // The FIRST (stale-generation) batch resolves — it must not touch the list.
        hub.checksGates[0].second.complete(
            GitHubChecksBatchResponse(available = true, checks = mapOf("12" to GitHubChecks(passed = 9, total = 9))),
        )
        runCurrent()
        assertEquals(listOf("second"), loaded(hub).pulls.map { it.title })
        assertNull(loaded(hub).pulls[0].checks)

        // The CURRENT batch resolves — it must merge.
        hub.checksGates[1].second.complete(
            GitHubChecksBatchResponse(available = true, checks = mapOf("12" to GitHubChecks(passed = 2, failing = 1, total = 3))),
        )
        advanceUntilIdle()
        assertEquals(GitHubChecks(passed = 2, failing = 1, total = 3), loaded(hub).pulls[0].checks)
    }
}
