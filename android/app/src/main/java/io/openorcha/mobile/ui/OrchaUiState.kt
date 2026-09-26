package io.openorcha.mobile.ui

/** Defines routes and immutable UI state consumed by the Compose screens. */
import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import io.openorcha.mobile.data.AgentDto
import io.openorcha.mobile.data.ContainerSnapshot
import io.openorcha.mobile.data.ContainerStore
import io.openorcha.mobile.data.ConversationDto
import io.openorcha.mobile.data.ModelDto
import io.openorcha.mobile.data.OrchaApiClient
import io.openorcha.mobile.data.OrchaServerAddress
import io.openorcha.mobile.data.RequestDto
import io.openorcha.mobile.data.RunDto
import io.openorcha.mobile.data.RunStream
import io.openorcha.mobile.data.RunStreamEvent
import io.openorcha.mobile.data.StoredContainer
import io.openorcha.mobile.data.TaskDto
import io.openorcha.mobile.data.TaskMessageDto
import io.openorcha.mobile.data.TurnDto
import io.openorcha.mobile.data.GitHubStartResponse
import io.openorcha.mobile.domain.ChatSendFlow
import io.openorcha.mobile.domain.GitHubHubFilter
import io.openorcha.mobile.domain.GitHubHubKind
import io.openorcha.mobile.domain.GitHubIssueDetailPhase
import io.openorcha.mobile.domain.GitHubIssuesPhase
import io.openorcha.mobile.domain.GitHubPullDetailPhase
import io.openorcha.mobile.domain.GitHubPullsFilterState
import io.openorcha.mobile.domain.GitHubPullsPhase
import io.openorcha.mobile.domain.DeviceAuthFlow
import io.openorcha.mobile.domain.Paging
import io.openorcha.mobile.domain.RunFeed
import io.openorcha.mobile.domain.RunFeedRow
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

enum class AppRoute {
    Containers,
    Scanner,
    AddContainer,
    Workspace,
    TaskDetail,
    TaskThread,
    RequestDetail,
    AgentDetail,
    RunDetail,
    Conversation,
    CreateTask,
    Settings,
    GitHubHub,
    GitHubIssueDetail,
    GitHubPullDetail,
}

enum class WorkspaceTab { Home, Tasks, Requests, Agents, Search }

/** Per-card reachability + glance counts for the Containers home (flow 04 H1). */
data class ContainerHealth(
    val state: String,               // live | polling | unreachable | signin | probing
    val agents: Int = 0,
    /** OPEN (non-terminal) task count — iOS parity: `snap.taskOpenTotal`, never the
     *  length of the capped snapshot array. */
    val tasks: Int = 0,
    val needsYou: Int = 0,
    /** The bound GitHub repo ("owner/name"), shown on the card's secondary line. */
    val githubRepo: String? = null,
)

/** Flow 09: lazily-fetched agent-detail sections (each best-effort, absent on failure). */
data class AgentExtras(
    val persona: io.openorcha.mobile.data.PersonaResponse? = null,
    val digest: io.openorcha.mobile.data.DigestDto? = null,
    val inboxCount: Int? = null,
    val inboxPreview: String? = null,
    val outboxOpen: Int? = null,
    val outboxAnswered: Int? = null,
)

data class OrchaUiState(
    val route: AppRoute = AppRoute.Containers,
    val themeMode: io.openorcha.mobile.ui.theme.ThemeMode = io.openorcha.mobile.ui.theme.ThemeMode.Auto,
    val skinMode: io.openorcha.mobile.ui.theme.SkinMode = io.openorcha.mobile.ui.theme.SkinMode.Classic,
    val containerHealth: Map<String, ContainerHealth> = emptyMap(),
    val agentExtras: AgentExtras = AgentExtras(),
    val closeImplications: List<String>? = null,
    val containers: List<StoredContainer> = emptyList(),
    val selectedContainer: StoredContainer? = null,
    val snapshot: ContainerSnapshot? = null,
    val selectedTab: WorkspaceTab = WorkspaceTab.Home,
    // Search tab (iOS `SearchTabView` parity): the live query, kept in state so it
    // survives tab switches within the same workspace session.
    val searchQuery: String = "",
    val selectedTask: TaskDto? = null,
    val taskMessages: List<TaskMessageDto> = emptyList(),
    // thread keyset paging (issue 4): cursors point at the OLDEST loaded message
    val threadHasMore: Boolean = false,
    val threadNextBefore: String? = null,
    val threadNextBeforeId: String? = null,
    val threadLoadingEarlier: Boolean = false,
    val taskRuns: List<RunDto> = emptyList(),
    val selectedRequest: RequestDto? = null,
    val selectedAgent: AgentDto? = null,
    val agentRuns: List<RunDto> = emptyList(),
    val selectedRun: RunDto? = null,
    val runFeed: List<RunFeedRow> = emptyList(),
    // neutral stream-health note (issue 3): never the Wi-Fi banner for a mid-stream drop
    val runStreamNote: String? = null,
    val models: List<ModelDto> = emptyList(),
    val conversation: ConversationDto? = null,
    val turns: List<TurnDto> = emptyList(),
    /** Chat send-UX (iOS `ChatSendFlow` parity): the conversation composer's optimistic
     *  send-lifecycle state machine — pending bubble, echo/reply dedupe, tap-to-retry. */
    val sendFlow: ChatSendFlow = ChatSendFlow(),
    val loading: Boolean = false,
    val actionInFlight: Boolean = false,
    val connecting: Boolean = false,
    val error: String? = null,
    val toast: String? = null,
    // Device-token auth (cloud unification), iOS `AppModel` parity:
    /** The last connect probe was bounced by the auth perimeter — the address is
     *  reachable but needs a device token/sign-in before the connect can proceed. */
    val connectNeedsToken: Boolean = false,
    /** The raw address/QR payload whose probe needed a token, kept so the GitHub
     *  sign-in flow (or a manually pasted token) can retry the SAME draft. */
    val connectDraft: String? = null,
    /** The GitHub sign-in options sheet's state machine. */
    val deviceAuth: DeviceAuthFlow = DeviceAuthFlow(),
    // GitHub hub (Android parity of iOS AppModel+GitHubHub.swift)
    val githubHubKind: GitHubHubKind = GitHubHubKind.Pulls,
    val githubHubFilter: GitHubHubFilter = GitHubHubFilter.Open,
    val githubIssuesPhase: GitHubIssuesPhase = GitHubIssuesPhase.Idle,
    val githubPullsPhase: GitHubPullsPhase = GitHubPullsPhase.Idle,
    /** PR list's author/involvement/q/page filter — Android extension of the frozen
     *  filter+pagination contract (issue: PR-list filtering + pagination). */
    val githubPullsFilter: GitHubPullsFilterState = GitHubPullsFilterState(),
    /** PR #223 round 3: stale-completion guards — bumped at the start of every primary
     *  list load; a completion applies only while its captured generation is current. */
    val githubIssuesLoadGeneration: Int = 0,
    val githubPullsLoadGeneration: Int = 0,
    val githubIssueNumber: Int? = null,
    val githubIssueDetailPhase: GitHubIssueDetailPhase = GitHubIssueDetailPhase.Loading,
    val githubPullNumber: Int? = null,
    val githubPullDetailPhase: GitHubPullDetailPhase = GitHubPullDetailPhase.Loading,
    val githubStarted: GitHubStartResponse? = null,
)
