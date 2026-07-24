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

/** Owns saved-container navigation, probing, connection, and snapshot refresh. */
internal interface ContainerNavigationActions : OrchaViewModelAccess {
fun showContainers() {
    pollingJob?.cancel()
    cancelRunStream()
    _uiState.update { it.copy(route = AppRoute.Containers, error = null, selectedTask = null, selectedRequest = null, selectedAgent = null) }
    probeContainers()
}

fun showSettings() {
    _uiState.update { it.copy(route = AppRoute.Settings, error = null) }
}

fun setThemeMode(mode: io.openorcha.mobile.ui.theme.ThemeMode) {
    store.saveThemeMode(mode.name.lowercase())
    _uiState.update { it.copy(themeMode = mode) }
}

fun renameContainer(id: String, name: String) {
    if (name.isBlank()) return
    val containers = store.rename(id, name.trim())
    _uiState.update { st ->
        st.copy(
            containers = containers,
            selectedContainer = st.selectedContainer?.let { sel ->
                containers.firstOrNull { it.id == sel.id } ?: sel
            },
        )
    }
}

/** Flow 04: per-card reachability probe + glance counts, non-blocking per card. */
fun probeContainers() {
    val targets = _uiState.value.containers
    targets.forEach { stored ->
        scope.launch {
            _uiState.update { it.copy(containerHealth = it.containerHealth + (stored.id to (it.containerHealth[stored.id]?.copy(state = "probing") ?: ContainerHealth("probing")))) }
            // issue 4: the home cards need counts only — fetch a slim snapshot window
            // (server orders needs-attention rows first, so needsYou stays accurate)
            // and read totals from task_total/request_total instead of row counts.
            val health = runCatching { api.getSnapshot(stored.baseUrl, stored.id, taskLimit = PROBE_LIMIT, requestLimit = PROBE_LIMIT) }
                .map { snap ->
                    val needs = io.openorcha.mobile.domain.OrchaSelectors.needsYou(snap).total
                    ContainerHealth("polling", snap.agents.size, snap.taskTotal ?: snap.tasks.size, needs)
                }
                .getOrElse { ContainerHealth("unreachable") }
            _uiState.update { it.copy(containerHealth = it.containerHealth + (stored.id to health)) }
        }
    }
}

fun openThread() {
    if (_uiState.value.selectedTask == null) return
    _uiState.update { it.copy(route = AppRoute.TaskThread, error = null) }
}

fun backToTaskDetail() {
    cancelRunStream()
    _uiState.update { it.copy(route = AppRoute.TaskDetail, error = null) }
}

fun showAddContainer() {
    _uiState.update { it.copy(route = AppRoute.AddContainer, error = null) }
}

fun showScanner() {
    _uiState.update { it.copy(route = AppRoute.Scanner, error = null) }
}

/** Flow 03: a scanned QR payload runs through the same parse+probe as manual entry. */
fun connectScanned(payload: String) {
    _uiState.update { it.copy(route = AppRoute.AddContainer) }
    connectManual(payload)
}

override fun showWorkspace() {
    cancelRunStream()
    _uiState.update {
        it.copy(
            route = AppRoute.Workspace,
            selectedTask = null,
            selectedRequest = null,
            selectedAgent = null,
            selectedRun = null,
            taskMessages = emptyList(),
            threadHasMore = false,
            threadNextBefore = null,
            threadNextBeforeId = null,
            taskRuns = emptyList(),
            agentRuns = emptyList(),
            runFeed = emptyList(),
            runStreamNote = null,
            conversation = null,
            turns = emptyList(),
            error = null,
        )
    }
}

fun showCreateTask() {
    _uiState.update { it.copy(route = AppRoute.CreateTask, error = null) }
}

fun selectTab(tab: WorkspaceTab) {
    _uiState.update { it.copy(selectedTab = tab) }
}

fun connectManual(rawBaseUrl: String) {
    val baseUrl = try {
        OrchaServerAddress.normalize(pairingBaseUrl(rawBaseUrl))
    } catch (err: IllegalArgumentException) {
        _uiState.update { it.copy(error = err.message ?: friendlyConnectionError()) }
        return
    }
    scope.launch {
        _uiState.update { it.copy(connecting = true, error = null) }
        runCatching {
            val container = api.listContainers(baseUrl).containers.firstOrNull()
                ?: error("No Orcha container was found at this address.")
            val snapshot = api.getSnapshot(baseUrl, container.id)
            val human = snapshot.agents.firstOrNull { it.kind == "human" }
            StoredContainer(
                id = container.id,
                displayName = container.name,
                baseUrl = baseUrl,
                humanAgentId = human?.id,
                humanAlias = human?.alias,
                lastOpenedAt = System.currentTimeMillis(),
            ) to snapshot
        }.onSuccess { (stored, snapshot) ->
            val containers = store.upsert(stored)
            _uiState.update {
                it.copy(
                    containers = containers,
                    selectedContainer = stored,
                    snapshot = snapshot,
                    route = AppRoute.Workspace,
                    connecting = false,
                    selectedTab = WorkspaceTab.Home,
                )
            }
            startPolling()
        }.onFailure { err ->
            android.util.Log.w("OrchaApp", "connect failed", err)
            _uiState.update { it.copy(connecting = false, error = friendlyConnectionError(err)) }
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
    startPolling()
}

override fun refreshSelected() {
    val selected = _uiState.value.selectedContainer ?: return
    scope.launch {
        _uiState.update { it.copy(loading = true, error = null) }
        runCatching {
            api.getSnapshot(selected.baseUrl, selected.id)
        }.onSuccess { snapshot ->
            val human = snapshot.agents.firstOrNull { it.kind == "human" }
            val upgraded = if (selected.humanAgentId == null && human != null) {
                selected.copy(humanAgentId = human.id, humanAlias = human.alias)
            } else {
                selected
            }
            if (upgraded != selected) {
                val containers = store.upsert(upgraded)
                _uiState.update { it.copy(containers = containers, selectedContainer = upgraded) }
            }
            _uiState.update { state ->
                state.copy(
                    snapshot = snapshot,
                    selectedTask = state.selectedTask?.let { task -> snapshot.tasks.firstOrNull { it.id == task.id } ?: task },
                    selectedRequest = state.selectedRequest?.let { request -> snapshot.requests.firstOrNull { it.id == request.id } ?: request },
                    selectedAgent = state.selectedAgent?.let { agent -> snapshot.agents.firstOrNull { it.id == agent.id } ?: agent },
                    loading = false,
                )
            }
        }.onFailure { err ->
            _uiState.update { it.copy(loading = false, error = friendlyConnectionError(err)) }
        }
    }
}

}
