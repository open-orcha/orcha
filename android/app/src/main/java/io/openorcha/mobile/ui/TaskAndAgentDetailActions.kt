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

/** Owns task threads, agent detail loading, and close implications. */
internal interface TaskAndAgentDetailActions : OrchaViewModelAccess {
override fun openTask(taskId: String) {
    val task = _uiState.value.snapshot?.tasks?.firstOrNull { it.id == taskId } ?: return
    cancelRunStream()
    _uiState.update {
        it.copy(
            route = AppRoute.TaskDetail, selectedTask = task, taskMessages = emptyList(),
            threadHasMore = false, threadNextBefore = null, threadNextBeforeId = null,
            taskRuns = emptyList(), error = null,
        )
    }
    refreshSelectedTask()
}

override fun refreshSelectedTask() {
    val selected = _uiState.value.selectedContainer ?: return
    val task = _uiState.value.selectedTask ?: return
    scope.launch {
        _uiState.update { it.copy(loading = true, error = null) }
        runCatching {
            // newest thread page only (issue 4) — older pages load on demand
            val messages = api.getTaskMessages(selected.baseUrl, task.id)
            val runs = api.getTaskRuns(selected.baseUrl, task.id).runs
            messages to runs
        }.onSuccess { (resp, runs) ->
            _uiState.update {
                it.copy(
                    taskMessages = resp.messages,
                    threadHasMore = resp.hasMore == true,
                    threadNextBefore = resp.nextBefore,
                    threadNextBeforeId = resp.nextBeforeId,
                    taskRuns = runs,
                    loading = false,
                )
            }
        }.onFailure { err ->
            _uiState.update { it.copy(loading = false, error = friendlyConnectionError(err)) }
        }
    }
}

/** Issue 4: "Load earlier" — fetch the page before the oldest loaded message and prepend. */
fun loadEarlierMessages() {
    val selected = _uiState.value.selectedContainer ?: return
    val task = _uiState.value.selectedTask ?: return
    val before = _uiState.value.threadNextBefore ?: return
    val beforeId = _uiState.value.threadNextBeforeId
    if (_uiState.value.threadLoadingEarlier) return
    scope.launch {
        _uiState.update { it.copy(threadLoadingEarlier = true) }
        runCatching { api.getTaskMessages(selected.baseUrl, task.id, before = before, beforeId = beforeId) }
            .onSuccess { resp ->
                _uiState.update { st ->
                    st.copy(
                        taskMessages = Paging.prependOlder(st.taskMessages, resp.messages, ::messageKey),
                        threadHasMore = resp.hasMore == true,
                        threadNextBefore = resp.nextBefore,
                        threadNextBeforeId = resp.nextBeforeId,
                        threadLoadingEarlier = false,
                    )
                }
            }
            .onFailure { err ->
                _uiState.update { it.copy(threadLoadingEarlier = false, error = friendlyConnectionError(err)) }
            }
    }
}

fun openRequest(requestId: String) {
    val request = _uiState.value.snapshot?.requests?.firstOrNull { it.id == requestId } ?: return
    _uiState.update { it.copy(route = AppRoute.RequestDetail, selectedRequest = request, error = null) }
}

fun openAgent(agentId: String) {
    val agent = _uiState.value.snapshot?.agents?.firstOrNull { it.id == agentId } ?: return
    cancelRunStream()
    _uiState.update { it.copy(route = AppRoute.AgentDetail, selectedAgent = agent, agentRuns = emptyList(), models = emptyList(), error = null) }
    refreshAgentDetail()
}

override fun refreshAgentDetail() {
    val selected = _uiState.value.selectedContainer ?: return
    val agent = _uiState.value.selectedAgent ?: return
    scope.launch {
        _uiState.update { it.copy(loading = true, error = null, agentExtras = AgentExtras()) }
        runCatching {
            // flow 09 §9: headless + resident runs merged, newest first
            val headless = api.getAgentRuns(selected.baseUrl, agent.id).runs
            val resident = runCatching { api.getResidentRuns(selected.baseUrl, agent.id).runs }.getOrDefault(emptyList())
            val runs = (headless + resident).distinctBy { it.runId }.sortedByDescending { it.startedAt ?: "" }
            val models = api.listModels(selected.baseUrl).models
            runs to models
        }.onSuccess { (runs, models) ->
            _uiState.update { it.copy(agentRuns = runs, models = models, loading = false) }
        }.onFailure { err ->
            _uiState.update { it.copy(loading = false, error = friendlyConnectionError(err)) }
        }
        // lazy sections — each best-effort, independent of the core fetch (flow 09 §states)
        val persona = runCatching { api.getPersona(selected.baseUrl, agent.id) }.getOrNull()
        val digest = runCatching { api.getDigest(selected.baseUrl, agent.id).digest }.getOrNull()
        val inbox = runCatching { api.getInbox(selected.baseUrl, agent.id).openRequests }.getOrNull()
        val outbox = runCatching { api.getOutbox(selected.baseUrl, agent.id).outgoingRequests }.getOrNull()
        _uiState.update {
            it.copy(
                agentExtras = AgentExtras(
                    persona = persona,
                    digest = digest,
                    inboxCount = inbox?.size,
                    inboxPreview = inbox?.firstOrNull()?.payload,
                    outboxOpen = outbox?.count { r -> r.status == "open" },
                    outboxAnswered = outbox?.count { r -> r.status == "answered" },
                ),
            )
        }
    }
}

/** Flow 05: fetch the close-implications preview before showing the destructive confirm. */
fun fetchCloseImplications() {
    val selected = _uiState.value.selectedContainer ?: return
    val task = _uiState.value.selectedTask ?: return
    scope.launch {
        val imp = runCatching { api.getCloseImplications(selected.baseUrl, task.id) }.getOrNull()
        val lines = io.openorcha.mobile.domain.CloseImplicationsUx.lines(imp)
        _uiState.update { it.copy(closeImplications = lines.ifEmpty { null }) }
    }
}

/** Flow 09: rename an agent (overflow → Details). PARTIAL update, human-gated. */
fun renameSelectedAgent(alias: String) = runHumanAction("Agent renamed") { selected, actor ->
    val agent = _uiState.value.selectedAgent ?: error("No agent selected")
    api.updateAgent(selected.baseUrl, agent.id, actor, alias, null)
    refreshSelected()
}

}
