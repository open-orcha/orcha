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
}

enum class WorkspaceTab { Home, Tasks, Requests, Agents }

/** Per-card reachability + glance counts for the Containers home (flow 04 H1). */
data class ContainerHealth(
    val state: String,               // live | polling | unreachable | probing
    val agents: Int = 0,
    val tasks: Int = 0,
    val needsYou: Int = 0,
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
    val containerHealth: Map<String, ContainerHealth> = emptyMap(),
    val agentExtras: AgentExtras = AgentExtras(),
    val closeImplications: List<String>? = null,
    val containers: List<StoredContainer> = emptyList(),
    val selectedContainer: StoredContainer? = null,
    val snapshot: ContainerSnapshot? = null,
    val selectedTab: WorkspaceTab = WorkspaceTab.Home,
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
    val loading: Boolean = false,
    val actionInFlight: Boolean = false,
    val connecting: Boolean = false,
    val error: String? = null,
    val toast: String? = null,
)
