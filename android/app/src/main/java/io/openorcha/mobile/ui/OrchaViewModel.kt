package io.openorcha.mobile.ui

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

/** Coordinates Android UI state through focused action modules. */
internal class OrchaViewModel(application: Application) : AndroidViewModel(application),
    ContainerNavigationActions,
    TaskAndAgentDetailActions,
    RunAndConversationActions,
    TaskAndRequestHumanActions,
    AgentAndWorkspaceHumanActions,
    ChatSendActions,
    GitHubHubActions,
    DeviceAuthActions,
    OrchaViewModelSupport {
    override val store = ContainerStore(application)
    override val api = OrchaApiClient()
    override val json = Json { ignoreUnknownKeys = true }
    override var pollingJob: Job? = null
    override var runStreamJob: Job? = null
    override var replyWatchJob: Job? = null
    override val deviceAuthSession = DeviceAuthSession()

    override val _uiState = MutableStateFlow(
        OrchaUiState(
            containers = store.load(),
            themeMode = runCatching {
                io.openorcha.mobile.ui.theme.ThemeMode.valueOf(
                    store.loadThemeMode().replaceFirstChar { it.uppercase() },
                )
            }.getOrDefault(io.openorcha.mobile.ui.theme.ThemeMode.Auto),
            skinMode = io.openorcha.mobile.ui.theme.SkinMode.fromStorageValue(store.loadSkinMode()),
        ),
    )
    val uiState: StateFlow<OrchaUiState> = _uiState

    init {
        // Device-token auth: re-seed the in-memory bearer registry every stored
        // container's token rides on -- the Ktor request seam in
        // `OrchaHttpClient.kt` has nothing else to consult after a process restart.
        io.openorcha.mobile.data.BearerTokens.seed(_uiState.value.containers)
        val first = _uiState.value.containers.firstOrNull()
        if (first != null) openContainer(first.id) else probeContainers()
    }

    override val scope get() = viewModelScope
}
