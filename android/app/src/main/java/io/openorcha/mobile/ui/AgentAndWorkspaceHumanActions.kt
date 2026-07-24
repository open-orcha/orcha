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

/** Owns remaining request, agent, container-control, conversation, and creation actions. */
internal interface AgentAndWorkspaceHumanActions : OrchaViewModelAccess {
fun escalateSelectedRequest(reason: String?) = runHumanAction("Request escalated") { selected, actor ->
    val request = _uiState.value.selectedRequest ?: error("No request selected")
    api.escalateRequest(selected.baseUrl, request.id, actor, reason)
    refreshSelected()
    showWorkspace()
}

fun acceptSelectedTaskRequest(note: String?) = runHumanAction("Task request accepted") { selected, actor ->
    val request = _uiState.value.selectedRequest ?: error("No request selected")
    api.acceptTaskRequest(selected.baseUrl, request.id, actor, note)
    refreshSelected()
    showWorkspace()
}

fun rejectSelectedTaskRequest(reason: String) = runHumanAction("Task request rejected") { selected, actor ->
    val request = _uiState.value.selectedRequest ?: error("No request selected")
    api.rejectTaskRequest(selected.baseUrl, request.id, actor, reason)
    refreshSelected()
    showWorkspace()
}

fun convertSelectedRequest(title: String, definitionOfDone: String, assigneeAlias: String?, priority: Int) =
    runHumanAction("Request became a task") { selected, actor ->
        val request = _uiState.value.selectedRequest ?: error("No request selected")
        api.convertRequest(selected.baseUrl, request.id, actor, title, definitionOfDone, assigneeAlias, priority)
        refreshSelected()
        showWorkspace()
    }

fun changeSelectedAgentModel(model: String) = runHumanAction("Model changed") { selected, _ ->
    val agent = _uiState.value.selectedAgent ?: error("No agent selected")
    api.updateAgentModel(selected.baseUrl, agent.id, model)
    refreshSelected()
    refreshAgentDetail()
}

fun changeSelectedAgentAutoWake(intervalSecs: Int?) = runHumanAction("Auto-wake updated") { selected, actor ->
    val agent = _uiState.value.selectedAgent ?: error("No agent selected")
    api.updateAutoWake(selected.baseUrl, agent.id, actor, intervalSecs)
    refreshSelected()
}

fun retireSelectedAgent() = runHumanAction("Agent retired") { selected, actor ->
    val agent = _uiState.value.selectedAgent ?: error("No agent selected")
    api.retireAgent(selected.baseUrl, agent.id, actor)
    refreshSelected()
    showWorkspace()
}

/** GH #148: notifier switch. Never touches autonomy_level — the two controls are orthogonal. */
fun setWakes(enabled: Boolean) = runHumanAction(if (enabled) "Wakes resumed" else "Wakes paused") { selected, actor ->
    api.setWakes(selected.baseUrl, selected.id, enabled, actor)
    refreshSelected()
}

/** GH #148: autonomy gearbox. Never touches wakes_enabled — applies whether running or paused. */
fun setAutonomy(level: String) = runHumanAction("Autonomy set to $level") { selected, actor ->
    api.setAutonomy(selected.baseUrl, selected.id, level, actor)
    refreshSelected()
}

fun sendConversationTurn(content: String) = runHumanAction("Message sent") { selected, actor ->
    val agent = _uiState.value.selectedAgent ?: error("No agent selected")
    val conversation = _uiState.value.conversation ?: api.startConversation(selected.baseUrl, agent.id, actor).conversation
    val conversationId = conversation?.id ?: error("Conversation did not start")
    api.sendConversationTurn(selected.baseUrl, conversationId, actor, content)
    refreshConversation()
}

fun endConversation() = runHumanAction("Conversation ended") { selected, actor ->
    val conversation = _uiState.value.conversation ?: return@runHumanAction
    api.endConversation(selected.baseUrl, conversation.id, actor)
    refreshConversation()
}

fun createTask(
    title: String,
    description: String?,
    definitionOfDone: String,
    assigneeAlias: String?,
    priority: Int,
    dependsOn: List<String>,
    notReady: Boolean,
) = runHumanAction("Task created") { selected, actor ->
    val response = api.createTask(
        selected.baseUrl,
        selected.id,
        title,
        description,
        definitionOfDone,
        actor,
        assigneeAlias,
        priority,
        dependsOn,
        notReady,
    )
    refreshSelected()
    response.taskId?.let { openTask(it) } ?: showWorkspace()
}

fun stopSelectedRun() = runHumanAction("Stop requested") { selected, actor ->
    val run = _uiState.value.selectedRun ?: error("No run selected")
    api.stopRun(selected.baseUrl, run.runId, actor)
    refreshRunLog()
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

fun clearToast() {
    _uiState.update { it.copy(toast = null) }
}

}
