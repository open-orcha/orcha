package io.openorcha.mobile.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import io.openorcha.mobile.data.ContainerSnapshot
import io.openorcha.mobile.data.ContainerStore
import io.openorcha.mobile.data.OrchaApiClient
import io.openorcha.mobile.data.OrchaServerAddress
import io.openorcha.mobile.data.StoredContainer
import io.openorcha.mobile.data.TaskDto
import io.openorcha.mobile.data.TaskMessageDto
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

enum class AppRoute { Containers, AddContainer, Workspace, TaskDetail }
enum class WorkspaceTab { Home, Tasks, Requests, Agents }

data class OrchaUiState(
    val route: AppRoute = AppRoute.Containers,
    val containers: List<StoredContainer> = emptyList(),
    val selectedContainer: StoredContainer? = null,
    val snapshot: ContainerSnapshot? = null,
    val selectedTab: WorkspaceTab = WorkspaceTab.Home,
    val selectedTask: TaskDto? = null,
    val taskMessages: List<TaskMessageDto> = emptyList(),
    val loading: Boolean = false,
    val connecting: Boolean = false,
    val error: String? = null,
)

class OrchaViewModel(application: Application) : AndroidViewModel(application) {
    private val store = ContainerStore(application)
    private val api = OrchaApiClient()

    private val _uiState = MutableStateFlow(OrchaUiState(containers = store.load()))
    val uiState: StateFlow<OrchaUiState> = _uiState

    init {
        val first = _uiState.value.containers.firstOrNull()
        if (first != null) openContainer(first.id)
    }

    fun showContainers() {
        _uiState.update { it.copy(route = AppRoute.Containers, error = null) }
    }

    fun showAddContainer() {
        _uiState.update { it.copy(route = AppRoute.AddContainer, error = null) }
    }

    fun showWorkspace() {
        _uiState.update { it.copy(route = AppRoute.Workspace, selectedTask = null, taskMessages = emptyList()) }
    }

    fun selectTab(tab: WorkspaceTab) {
        _uiState.update { it.copy(selectedTab = tab) }
    }

    fun connectManual(rawBaseUrl: String) {
        val baseUrl = try {
            OrchaServerAddress.normalize(rawBaseUrl)
        } catch (err: IllegalArgumentException) {
            _uiState.update { it.copy(error = err.message ?: friendlyConnectionError()) }
            return
        }
        viewModelScope.launch {
            _uiState.update { it.copy(connecting = true, error = null) }
            runCatching {
                val container = api.listContainers(baseUrl).containers.firstOrNull()
                    ?: error("No Orcha container was found at this address.")
                StoredContainer(
                    id = container.id,
                    displayName = container.name,
                    baseUrl = baseUrl,
                    lastOpenedAt = System.currentTimeMillis(),
                )
            }.onSuccess { stored ->
                val containers = store.upsert(stored)
                _uiState.update {
                    it.copy(
                        containers = containers,
                        selectedContainer = stored,
                        route = AppRoute.Workspace,
                        connecting = false,
                    )
                }
                refreshSelected()
            }.onFailure { err ->
                _uiState.update {
                    it.copy(connecting = false, error = friendlyConnectionError(err))
                }
            }
        }
    }

    fun openContainer(id: String) {
        val selected = _uiState.value.containers.firstOrNull { it.id == id } ?: return
        val touched = selected.copy(lastOpenedAt = System.currentTimeMillis())
        val containers = store.upsert(touched)
        _uiState.update {
            it.copy(
                containers = containers,
                selectedContainer = touched,
                route = AppRoute.Workspace,
                selectedTab = WorkspaceTab.Home,
                error = null,
            )
        }
        refreshSelected()
    }

    fun refreshSelected() {
        val selected = _uiState.value.selectedContainer ?: return
        viewModelScope.launch {
            _uiState.update { it.copy(loading = true, error = null) }
            runCatching {
                api.getSnapshot(selected.baseUrl, selected.id)
            }.onSuccess { snapshot ->
                _uiState.update { it.copy(snapshot = snapshot, loading = false) }
            }.onFailure { err ->
                _uiState.update {
                    it.copy(loading = false, error = friendlyConnectionError(err))
                }
            }
        }
    }

    fun openTask(taskId: String) {
        val task = _uiState.value.snapshot?.tasks?.firstOrNull { it.id == taskId } ?: return
        _uiState.update { it.copy(route = AppRoute.TaskDetail, selectedTask = task, taskMessages = emptyList()) }
        refreshSelectedTask()
    }

    fun refreshSelectedTask() {
        val selected = _uiState.value.selectedContainer ?: return
        val task = _uiState.value.selectedTask ?: return
        viewModelScope.launch {
            _uiState.update { it.copy(loading = true, error = null) }
            runCatching {
                api.getTaskMessages(selected.baseUrl, task.id).messages
            }.onSuccess { messages ->
                _uiState.update { it.copy(taskMessages = messages, loading = false) }
            }.onFailure { err ->
                _uiState.update {
                    it.copy(loading = false, error = friendlyConnectionError(err))
                }
            }
        }
    }

    fun forgetContainer(id: String) {
        val containers = store.remove(id)
        _uiState.update {
            it.copy(
                containers = containers,
                selectedContainer = null,
                snapshot = null,
                route = AppRoute.Containers,
            )
        }
    }

    fun forgetSelectedContainer() {
        _uiState.value.selectedContainer?.id?.let(::forgetContainer)
    }

    private fun friendlyConnectionError(err: Throwable? = null): String {
        if (err is IllegalArgumentException && !err.message.isNullOrBlank()) {
            return err.message.orEmpty()
        }
        return "Could not reach Orcha at this address. Check that Orcha is running and your phone is on the same Wi-Fi."
    }
}
